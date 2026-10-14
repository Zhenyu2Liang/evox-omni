import { randomUUID } from 'node:crypto';
import type { Agent, AgentEvent, PrepareRequestContext, AgentRequestUpdate, AgentMessage } from '@earendil-works/pi-agent-core';
import { toToolDeclaration } from '@earendil-works/pi-ai';
import type { ToolInvocation } from '@/lib/db/prisma';
import type { DbClient } from '@/lib/db/client';
import type { AgentRunLease, AgentRunStatus, RuntimeEventChannel, ToolInvocationStatus } from '@/lib/contracts/runtime';
import {
  appendRuntimeEvent, assertAgentRunLease, beginAgentRun, finishAgentRun, finishInvocationWithEvent,
  renewAgentRunLease, startInvocationWithEvent, updateInvocationAuthorization,
  type BegunAgentRun, type BeginAgentRunInput,
  saveRunCheckpoint, startModelRequest, completeModelRequest,
} from '@/lib/db/repositories/agentRun';
import { AppError } from '@/lib/errors';
import { encodeRuntimeValue, runtimeRequestDigest, snapshotRuntimeValue } from './serialization';
import { toolReplayPolicy, type RetryPolicyCapabilities } from './retry-policy';
import type { SessionSnapshot } from '@/agent/session';
import type { AppConfig } from '@/lib/config';
import { encodeCheckpoint } from './checkpoint';
import { retryableModelFailure } from '@/agent/providers/model-failure';
import { parseModelToolError } from '@/agent/tools/result';

export interface BeginRunInput extends Omit<BeginAgentRunInput, 'requestDigest' | 'requestJson'> {
  request: unknown;
}

export function beginRun(input: BeginRunInput): Promise<BegunAgentRun> {
  const { request, ...identity } = input;
  return beginAgentRun({ ...identity, requestDigest: runtimeRequestDigest('agent_input', request), requestJson: encodeRuntimeValue(request) });
}

/** Ordered, persist-first adapter for Pi Core's awaited event subscription. */
export class AgentRunJournal {
  readonly lease: AgentRunLease;
  private readonly capabilities: RetryPolicyCapabilities;
  private readonly activeCalls = new Map<string, ToolInvocation>();
  private tail: Promise<void> = Promise.resolve();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatFailure: unknown;
  private persistenceFailure: unknown;
  private finished = false;
  private snapshot?: () => SessionSnapshot;
  private config?: AppConfig;
  private modelRequestId?: string;
  private originalModelInput?: { messages: AgentMessage[]; tools: unknown[]; [key: string]: unknown };
  private originalModelDigest?: string;

  constructor(lease: AgentRunLease, capabilities: RetryPolicyCapabilities = {}) {
    this.lease = lease;
    this.capabilities = capabilities;
  }

  bindRuntime(snapshot: () => SessionSnapshot, config: AppConfig): void {
    this.snapshot = snapshot;
    this.config = config;
  }

  restoreModelRequestIdentity(id: string, inputJson?: string, requestDigest?: string): void {
    this.modelRequestId = id;
    if (inputJson) {
      const input = JSON.parse(inputJson) as { messages?: AgentMessage[]; tools?: unknown[]; [key: string]: unknown };
      if (!Array.isArray(input.messages) || !Array.isArray(input.tools)) throw new AppError('CONFLICT', 'The original model request context and tool definitions are required');
      this.originalModelInput = { ...input, messages: input.messages, tools: input.tools };
      this.originalModelDigest = requestDigest;
    }
  }

  /** Original model input is immutable; compaction must not prepare a replacement on replay. */
  hasOriginalModelInput(): boolean {
    return this.originalModelInput !== undefined;
  }

  /** Presentation uses the prepared request identity, never a reused provider call ID alone. */
  currentModelRequestIdentity(): string | undefined {
    return this.modelRequestId;
  }

  checkpoint(stage: string): Promise<void> {
    if (!this.snapshot || !this.config) return Promise.reject(new AppError('CONFLICT', 'A durable runtime checkpoint is not bound'));
    const json = encodeCheckpoint(this.snapshot(), this.config);
    return this.enqueue(() => saveRunCheckpoint(this.lease, stage, json));
  }

  prepareModelRequest(request: PrepareRequestContext): Promise<AgentRequestUpdate | undefined> {
    if (!this.snapshot || !this.config) return Promise.reject(new AppError('CONFLICT', 'A durable model runtime is not bound'));
    const original = this.originalModelInput;
    const tools = (request.context.tools ?? []).map(toToolDeclaration);
    if (original && runtimeRequestDigest('tool_declarations', original.tools) !== runtimeRequestDigest('tool_declarations', tools)) return Promise.reject(new AppError('CONFLICT', 'The original tool definitions are required for continuation'));
    const messages = original?.messages ?? request.context.messages;
    const snapshot = this.snapshot();
    // The request may be compacted, but its checkpoint must retain the complete archive.
    snapshot.agentState = { ...snapshot.agentState, model: request.model };
    const input = original ?? { messages, systemPrompt: snapshot.agentState.systemPrompt, model: request.model, tools, requestIntent: snapshot.intent };
    const digest = original && this.originalModelDigest ? this.originalModelDigest : runtimeRequestDigest('model_request', input);
    const json = encodeRuntimeValue(input);
    const checkpoint = encodeCheckpoint(snapshot, this.config);
    this.modelRequestId = undefined;
    return this.enqueue(async () => {
      const attempt = await startModelRequest(this.lease, digest, json, checkpoint);
      this.modelRequestId = attempt.id;
      this.originalModelInput = undefined;
      this.originalModelDigest = undefined;
      return original ? { context: { ...request.context, messages } } : undefined;
    });
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    if (this.finished) return Promise.reject(new AppError('CONFLICT', 'Agent run journal has finished'));
    const result = this.tail.then(async () => {
      if (this.heartbeatFailure) throw this.heartbeatFailure;
      return write();
    });
    this.tail = result.then(() => undefined);
    // Event producers may publish updates without awaiting; flush still observes the failure.
    this.tail.catch(error => { this.persistenceFailure = error; });
    return result;
  }

  /** Snapshot synchronously, so mutable provider messages cannot alter the stored evidence. */
  recordEvent(eventType: string, payload: unknown, channel: RuntimeEventChannel = 'raw'): Promise<void> {
    const payloadJson = encodeRuntimeValue(payload);
    return this.enqueue(async () => { await appendRuntimeEvent(this.lease, { channel, eventType, payloadJson }); });
  }

  recordPresentationEvent<T extends { type: string }>(event: T): Promise<void> {
    return this.recordEvent(event.type, event, 'ui');
  }

  /** Bind wire evidence to the exact prepared model request; never store authentication headers. */
  recordModelProviderEvent(eventType: string, payload: unknown): Promise<void> {
    if (!this.modelRequestId) return Promise.reject(new AppError('CONFLICT', 'Provider evidence requires a prepared model request'));
    return this.recordEvent(eventType, { modelRequestId: this.modelRequestId, payload }, 'internal');
  }

  recordAgentEvent(event: AgentEvent): Promise<void> {
    const snapshot = snapshotRuntimeValue(event) as AgentEvent;
    const recorded = { channel: 'raw' as const, eventType: event.type, payloadJson: JSON.stringify(snapshot) };
    if (event.type === 'message_end' && event.message.role === 'assistant' && this.modelRequestId && this.snapshot && this.config) {
      const requestId = this.modelRequestId;
      const failed = ['error', 'aborted', 'length'].includes(event.message.stopReason);
      const errorCode = failed ? retryableModelFailure(event.message) ? 'MODEL_TRANSIENT' : 'MODEL_PERMANENT' : undefined;
      const checkpointJson = encodeCheckpoint(this.snapshot(), this.config);
      return this.enqueue(async () => {
        await appendRuntimeEvent(this.lease, recorded);
        await completeModelRequest(this.lease, requestId, encodeRuntimeValue(event.message), checkpointJson, errorCode);
      });
    }
    if (event.type === 'tool_execution_start') {
      const input = {
        id: `call_${randomUUID()}`,
        callId: event.toolCallId,
        toolName: event.toolName,
        argsJson: encodeRuntimeValue(event.args),
        requestDigest: runtimeRequestDigest(event.toolName, event.args),
        policy: toolReplayPolicy(event.toolName, this.capabilities),
        modelRequestId: this.modelRequestId,
      };
      return this.enqueue(async () => {
        if (this.activeCalls.has(input.callId)) throw new AppError('CONFLICT', 'Overlapping provider tool call identities are ambiguous');
        const { invocation } = await startInvocationWithEvent(this.lease, input, recorded);
        this.activeCalls.set(input.callId, invocation);
      });
    }
    if (event.type === 'tool_execution_end') {
      const callId = event.toolCallId;
      const status: ToolInvocationStatus = event.isError ? 'failed' : 'completed';
      const errorCode = event.isError ? structuredErrorCode(event.result) : undefined;
      const resultJson = encodeRuntimeValue({
        ok: !event.isError,
        data: event.result.details,
        content: event.result.content ?? [],
        usage: event.result.usage,
        durationMs: event.durationMs,
        summary: (event.result.content ?? []).find((part: { type: string; text?: string }) => part.type === 'text')?.text,
        ...(errorCode ? { error: errorCode } : {}),
      });
      return this.enqueue(async () => {
        const invocation = this.activeCalls.get(callId);
        if (!invocation) throw new AppError('CONFLICT', 'Tool completion has no durable invocation');
        await finishInvocationWithEvent(this.lease, { invocationId: invocation.id, status, resultJson, errorCode }, recorded);
        this.activeCalls.delete(callId);
      });
    }
    return this.enqueue(async () => { await appendRuntimeEvent(this.lease, recorded); });
  }

  /** Register this before any listener that grounds, transforms, or publishes events. */
  subscribe(agent: Pick<Agent, 'subscribe'>): () => void {
    return agent.subscribe(event => this.recordAgentEvent(event));
  }

  /** Available after the awaited start event, before the security gateway runs. */
  invocationForCall(callId: string): ToolInvocation | undefined {
    return this.activeCalls.get(callId);
  }

  /** A bank command calls this on its transaction handle immediately before its mutation. */
  async assertLeaseOwned(client: DbClient): Promise<void> {
    if (this.heartbeatFailure) throw this.heartbeatFailure;
    if (this.persistenceFailure) throw this.persistenceFailure;
    await assertAgentRunLease(this.lease, client);
  }

  parkInvocation(callId: string, status: 'waiting_confirmation' | 'waiting_verification', operationKey?: string): Promise<ToolInvocation> {
    return this.enqueue(async () => {
      const invocation = this.activeCalls.get(callId);
      if (!invocation) throw new AppError('NOT_FOUND', 'Tool invocation not found');
      const parked = await updateInvocationAuthorization(this.lease, invocation.id, status, operationKey);
      this.activeCalls.set(callId, parked);
      return parked;
    });
  }

  /** Heartbeats renew only an owned lease; a failure blocks subsequent events and effects. */
  startHeartbeat(intervalMs = 20_000): () => void {
    if (this.heartbeatTimer) throw new AppError('CONFLICT', 'Agent run heartbeat already started');
    this.heartbeatTimer = setInterval(() => {
      void this.enqueue(() => renewAgentRunLease(this.lease)).catch(error => { this.heartbeatFailure = error; });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
    return () => this.stopHeartbeat();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.heartbeatFailure) throw this.heartbeatFailure;
  }

  /** Failure finalization still attempts to release the lease if an earlier event write failed. */
  async finish(status: Exclude<AgentRunStatus, 'running'>, errorCode?: string): Promise<void> {
    this.stopHeartbeat();
    let eventError: unknown;
    try { await this.flush(); } catch (error) { eventError = error; }
    await finishAgentRun(this.lease, eventError ? 'failed' : status, eventError ? 'EVENT_PERSISTENCE_FAILED' : errorCode);
    this.finished = true;
    if (eventError) throw eventError;
  }
}

/** Error codes are read only from structured tool results, never from generated prose. */
function structuredErrorCode(result: unknown): string {
  if (typeof result !== 'object' || result === null) return 'TOOL_FAILED';
  const value = result as { errorCode?: unknown; details?: unknown; content?: unknown };
  if (typeof value.errorCode === 'string') return value.errorCode;
  if (typeof value.details === 'object' && value.details !== null) {
    const detail = value.details as { errorCode?: unknown; code?: unknown };
    if (typeof detail.errorCode === 'string') return detail.errorCode;
    if (typeof detail.code === 'string') return detail.code;
  }
  if (Array.isArray(value.content)) {
    const text = value.content.flatMap(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
    const failure = parseModelToolError(text);
    if (failure?.errorCode) return failure.errorCode;
  }
  return 'TOOL_FAILED';
}

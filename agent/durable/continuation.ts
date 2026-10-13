import type { AgentRun, ToolInvocation } from '@prisma/client';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, JsonValue } from '@earendil-works/pi-ai';
import type { AppConfig } from '@/lib/config';
import { getConfig } from '@/lib/config';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { AgentRunStatus } from '@/lib/contracts/runtime';
import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/db/client';
import { newId } from '@/lib/ids';
import { safeParse } from '@/lib/json';
import { createBankingAgent } from '@/agent/banking-agent';
import type { ModelRuntime } from '@/agent/providers/types';
import { saveSession } from '@/agent/session';
import { createEventHandler, createTurnBuffer, groundMessage, publishServerReply, relayPlanSnapshot, flushParkedDecision } from '@/agent/turn-presentation';
import { renderFinancialResponse } from '@/agent/financial-response';
import { transientModelFailure, PLANNING_RECOVERY_INSTRUCTION } from '@/agent/live-recovery';
import { withRealToolResult } from '@/agent/message-normalize';
import { decodeCheckpoint, encodeCheckpoint, hasRedactedCredentials } from './checkpoint';
import { AgentRunJournal } from './journal';
import { runtimeRequestDigest } from './serialization';
import { verifiedAuthorizationInput } from './authorized-checkpoint';
import { performAuthorizationResume } from '../authorization-resume';
import type { ResumeTurnInput } from '../turns/contracts';

/** A parked authorization needs its original provider call in the saved session after a crash. */
export async function restoreWaitingCheckpoint(run: AgentRun, journal: AgentRunJournal,
  invocations: readonly ToolInvocation[], deps: ContinuationDependencies = {}): Promise<void> {
  if (!run.checkpointJson || run.checkpointStage === 'session_committed') return;
  const config = deps.config ?? getConfig();
  const checkpoint = decodeCheckpoint(run.checkpointJson, config);
  const snapshot = checkpoint.snapshot;
  if (snapshot.sessionId !== run.sessionId || snapshot.userId !== run.userId || snapshot.revision !== run.baseRevision) throw new AppError('CONFLICT', 'The parked checkpoint identity is not valid');
  for (const invocation of invocations.filter(item => item.origin === 'pi' && ['waiting_confirmation', 'waiting_verification'].includes(item.status))) {
    const result = safeParse<{ data?: JsonValue; summary?: string }>(invocation.resultJson, {});
    const message: ToolResultMessage = { role: 'toolResult', toolCallId: invocation.callId, toolName: invocation.toolName,
      content: [{ type: 'text', text: result.summary ?? 'The original human authorization is required.' }],
      details: result.data, isError: true, timestamp: Date.now() };
    snapshot.agentState.messages = withRealToolResult(snapshot.agentState.messages, message);
  }
  snapshot.intent = snapshot.intent ? { ...snapshot.intent, status: 'submitted' } : undefined;
  const request = safeParse<{ message?: string }>(run.requestJson, {});
  if (!checkpoint.inputMessagePersisted && request.message) snapshot.transcript.push({ id: newId('msg'), role: 'user', content: request.message, timestamp: Date.now() });
  await saveSession(snapshot, { lease: journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
}

export interface ContinuationDependencies {
  config?: AppConfig;
  provider?: ModelRuntime;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}

/** Resume the original model decision, never submit the user request as a new bank operation. */
export async function continueDurableRun(run: AgentRun, journal: AgentRunJournal, invocations: readonly ToolInvocation[], deps: ContinuationDependencies = {}): Promise<Exclude<AgentRunStatus, 'running'>> {
  const config = deps.config ?? getConfig();
  if (!run.checkpointJson) throw new AppError('CONFLICT', 'The run has no complete continuation checkpoint');
  const checkpoint = decodeCheckpoint(run.checkpointJson, config);
  const { snapshot } = checkpoint;
  if (snapshot.sessionId !== run.sessionId || snapshot.userId !== run.userId || snapshot.revision !== run.baseRevision) throw new AppError('CONFLICT', 'Checkpoint ownership or revision does not match the run');
  if (run.checkpointStage === 'session_committed') return 'completed';
  const request = safeParse<{ kind?: string; message?: string } & Partial<ResumeTurnInput>>(run.requestJson, {});
  const authorization = request.kind === 'authorization_result'
    ? await verifiedAuthorizationInput(run, request as ResumeTurnInput) : undefined;
  if (!authorization && (request.kind !== 'input' || typeof request.message !== 'string')) throw new AppError('CONFLICT', 'The original run input is incomplete');
  if (authorization && run.checkpointStage === 'input') {
    const published = new Set<AgentStreamEvent>();
    const publish = async (events: readonly AgentStreamEvent[]) => {
      for (const event of events) {
        if (published.has(event)) continue;
        await journal.recordPresentationEvent(event); published.add(event); await deps.onEvent?.(event);
      }
    };
    const response = await performAuthorizationResume(authorization, deps, snapshot, { journal, publish }, {
      createBuffer: createTurnBuffer, createHandler: createEventHandler, relayPlan: relayPlanSnapshot,
      flushDecision: flushParkedDecision, ground: groundMessage, reply: publishServerReply,
    });
    await publish(response.events);
    const model = await prisma.modelRequest.findFirst({ where: { runId: run.id }, orderBy: { ordinal: 'desc' } });
    if (model?.status === 'failed') throw new AppError(model.errorCode === 'MODEL_TRANSIENT' ? 'INTERNAL' : 'VALIDATION', 'Authorization narration did not complete', { retryable: model.errorCode === 'MODEL_TRANSIENT' });
    return response.events.some(event => event.type === 'mfa_required') ? 'waiting_verification'
      : response.events.some(event => event.type === 'confirmation_required') ? 'waiting_confirmation'
        : response.events.some(event => event.type === 'error') ? 'failed' : 'completed';
  }
  const latest = await prisma.modelRequest.findFirst({ where: { runId: run.id }, orderBy: { ordinal: 'desc' } });
  if (latest) journal.restoreModelRequestIdentity(latest.id, latest.status !== 'completed' ? latest.inputJson : undefined);
  if (latest?.status === 'failed' && latest.errorCode !== 'MODEL_TRANSIENT') throw new AppError('VALIDATION', 'A permanent model failure cannot be retried');
  const buffer = createTurnBuffer(request.message);
  if (authorization) buffer.factResults.push({ toolName: authorization.resultToolName ?? authorization.toolName ?? '',
    result: authorization.toolResult, toolCallId: authorization.toolCallId, actionId: authorization.actionId,
    sourceAccountId: authorization.sourceAccountId, taskId: authorization.taskId, nodeId: authorization.nodeId });
  buffer.events.push({ type: 'session', sessionId: run.sessionId, runId: run.id });
  const published = new Set<AgentStreamEvent>();
  const publish = async () => {
    for (const event of buffer.events) {
      if (published.has(event)) continue;
      await journal.recordPresentationEvent(event);
      published.add(event);
      await deps.onEvent?.(event);
    }
  };
  const runtime = createBankingAgent({ sessionId: run.sessionId, userId: run.userId, snapshot, config, provider: deps.provider,
    journal, conversationIntent: () => snapshot.intent,
    onPlanUpdate: async plan => { buffer.events.push({ type: 'plan_update', plan }); await publish(); } });
  const originalModel = snapshot.agentState.model;
  const restoredModel = runtime.agent.state.model;
  if (originalModel && (originalModel.id !== restoredModel.id || originalModel.provider !== restoredModel.provider || originalModel.api !== restoredModel.api || originalModel.baseUrl !== restoredModel.baseUrl)) {
    runtime.dispose();
    throw new AppError('CONFLICT', 'Continuation requires the original model and endpoint');
  }
  const handler = createEventHandler(buffer, () => Date.now(), runtime.planningRejections);
  const observe = async (event: AgentEvent) => { await handler(event); if (event.type === 'tool_execution_end') await journal.checkpoint('tool_result'); await publish(); };
  const emit = async (event: AgentEvent) => { await journal.recordAgentEvent(event); await observe(event); };
  const unsubscribeJournal = journal.subscribe(runtime.agent);
  const unsubscribe = runtime.agent.subscribe(observe);
  try {
    // Completed outcomes are authoritative context, even if the crash lost Pi's tool-result message.
    for (const invocation of invocations.filter(item => item.origin === 'pi' && item.status === 'completed' && item.resultJson !== null)) {
      const result = safeParse<{ ok?: boolean; data?: unknown; summary?: string }>(invocation.resultJson, {});
      if (result.ok !== true) throw new AppError('CONFLICT', 'A saved successful tool result is incomplete');
      const message: ToolResultMessage = { role: 'toolResult', toolCallId: invocation.callId, toolName: invocation.toolName,
        content: [{ type: 'text', text: result.summary ?? JSON.stringify(result.data ?? null) }], details: result.data as JsonValue, isError: false, timestamp: invocation.finishedAt?.getTime() ?? Date.now() };
      if (latest?.status === 'completed' && invocation.modelRequestId === latest.id) runtime.agent.state.messages = withRealToolResult(runtime.agent.state.messages, message);
      buffer.factResults.push({ toolName: invocation.toolName, toolCallId: invocation.callId, result: { ok: true, data: result.data, summary: result.summary } });
    }
    if (latest?.status === 'completed' && latest.resultJson) {
      const assistant = JSON.parse(latest.resultJson) as AssistantMessage;
      if (assistant.role !== 'assistant' || ['error', 'aborted', 'length'].includes(assistant.stopReason)) throw new AppError('CONFLICT', 'An incomplete model response cannot execute calls');
      const calls = assistant.content.filter(part => part.type === 'toolCall');
      for (const call of calls) {
        const invocation = invocations.find(item => item.origin === 'pi' && item.modelRequestId === latest.id && item.callId === call.id);
        if (invocation) {
          if (invocation.requestDigest !== runtimeRequestDigest(call.name, call.arguments)) throw new AppError('CONFLICT', 'The original tool arguments do not match their invocation');
          if (invocation.status !== 'completed') throw new AppError('CONFLICT', 'An unresolved original tool call cannot be replaced');
          continue;
        }
        if (hasRedactedCredentials(call.arguments)) throw new AppError('SECURITY_DENIED', 'Credential input must be supplied through a new authorization workflow');
        const message = await runtime.executeCheckpointCall(call, assistant, emit);
        runtime.agent.state.messages = withRealToolResult(runtime.agent.state.messages, message);
        await journal.checkpoint('tool_result');
        const parked = await prisma.toolInvocation.findFirst({ where: { runId: run.id, origin: 'pi', callId: call.id }, orderBy: { ordinal: 'desc' } });
        if (parked?.status === 'waiting_confirmation' || parked?.status === 'waiting_verification') {
          snapshot.agentState = runtime.serialize().agentState;
          snapshot.transcript.push(...buffer.assistants);
          await saveSession(snapshot, { lease: journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
          buffer.events.push({ type: 'done' }); await publish();
          return parked.status;
        }
        if (message.isError) throw new AppError('TOOL_FAILED', 'The original checkpoint tool call failed');
      }
      if (calls.length === 0) {
        // Generation already completed. Rebuild its grounded presentation without another request.
        await handler({ type: 'message_start', message: assistant });
        await handler({ type: 'message_end', message: assistant });
      } else if (calls.some(call => call.name === 'submit_plan')) {
        publishServerReply(runtime, buffer, () => Date.now(), renderFinancialResponse(buffer.factResults));
      } else await runtime.agent.continue();
    } else if (run.checkpointStage === 'input') await runtime.agent.prompt(request.message!);
    else await runtime.agent.continue();
    const terminal = runtime.agent.state.messages.at(-1);
    if (terminal?.role === 'assistant' && ['error', 'aborted'].includes(terminal.stopReason)) {
      throw new AppError(transientModelFailure(terminal.errorMessage) ? 'INTERNAL' : 'VALIDATION', 'Model continuation did not complete', { retryable: transientModelFailure(terminal.errorMessage) });
    }
    snapshot.agentState = runtime.serialize().agentState;
    snapshot.agentState.messages = snapshot.agentState.messages.filter(message => message.role !== 'system' || message.content !== PLANNING_RECOVERY_INSTRUCTION);
    groundMessage(buffer, buffer.current);
    if (!authorization && !checkpoint.inputMessagePersisted) snapshot.transcript.push({ id: newId('msg'), role: 'user', content: request.message!, timestamp: Date.now() });
    snapshot.transcript.push(...buffer.assistants);
    await saveSession(snapshot, { lease: journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
    buffer.events.push({ type: 'done' }); await publish();
    return buffer.events.some(event => event.type === 'mfa_required') ? 'waiting_verification'
      : buffer.events.some(event => event.type === 'confirmation_required') ? 'waiting_confirmation' : 'completed';
  } finally { unsubscribe(); unsubscribeJournal(); runtime.dispose(); }
}

import type { AgentRun, ToolInvocation } from '@/lib/db/prisma';
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
import { createEventHandler, createTurnBuffer, groundMessage, publishServerReply, relayPlanSnapshot, flushParkedDecision, repairConversationalReply } from '@/agent/turn-presentation';
import { renderConversationalResponse } from '@/agent/conversational-response';
import { collectConversationEvidence } from '@/agent/conversation-evidence';
import { renderFinancialResponse } from '@/agent/financial-response';
import { continueDeclaredWrites } from '@/agent/write-continuation';
import { retryableModelFailure } from '@/agent/providers/model-failure';
import { withRealToolResult } from '@/agent/message-normalize';
import { decodeCheckpoint, encodeCheckpoint, hasRedactedCredentials } from './checkpoint';
import { AgentRunJournal } from './journal';
import { savedToolContent, savedToolMetadata, type SavedToolResult } from './tool-result';
import { runtimeRequestDigest } from './serialization';
import { verifiedAuthorizationInput } from './authorized-checkpoint';
import { performAuthorizationResume } from '../authorization-resume';
import type { ResumeTurnInput } from '../turns/contracts';
import { activePlanMessage, publishAuthorizedToolOutcome, readyPresentationEvents } from '../turns/buffer';
import { readAuthorizationToolContext } from '../authorization-context';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { providerPresentationKey, toolPresentationId } from '../tool-presentation-identity';
import { security } from '@/security';
import { mayPromptForDecision } from '@/agent/action-status';
import { safePublicText } from '@/lib/public-text';
import { createTranslator, DEFAULT_LOCALE } from '@/lib/i18n/shared';

/** The typed facts of a TERMINAL parked decision — never a status literal rendered as user text. */
function settledDecisionFacts(status: string): { code: string; reason: string } {
  switch (status) {
    case 'locked': return { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted' };
    case 'executed': return { code: 'DECISION_SETTLED', reason: 'decision_executed' };
    case 'failed': return { code: 'DECISION_FAILED', reason: 'decision_failed' };
    case 'cancelled': return { code: 'DECISION_CANCELLED', reason: 'decision_cancelled' };
    case 'needs_reconciliation': return { code: 'NEEDS_RECONCILIATION', reason: 'outcome_unknown' };
    default: return { code: 'DECISION_SETTLED', reason: 'decision_settled' };
  }
}

/**
 * The public projection of a parked call whose persisted `PendingAction` is TERMINAL. `locked` is a
 * settled refusal (exhausted verification / open circuit) and every other terminal status means the
 * operation already moved on, so neither the raw `__SECURITY_BLOCK__…` payload nor the status literal
 * may become user-visible text: the historical tool row keeps its place with catalog text and one
 * typed `security_event` (the shape `agent/turns/events.ts` publishes: typed fields, no message).
 */
function settledParkedProjection(actionId: string, status: string, storedSummary: string | undefined):
  { text: string; signal: Extract<AgentStreamEvent, { type: 'security_event' }> } {
  const t = createTranslator(DEFAULT_LOCALE);
  const fallback = status === 'locked' ? 'chat.error.actionLocked' : 'chat.error.stateChanged';
  return {
    text: safePublicText(storedSummary, t, fallback),
    signal: { type: 'security_event', kind: 'locked', actionId, ...settledDecisionFacts(status) },
  };
}

/** A parked authorization needs its original provider call in the saved session after a crash. */
export async function restoreWaitingCheckpoint(run: AgentRun, journal: AgentRunJournal,
  invocations: readonly ToolInvocation[], deps: ContinuationDependencies = {}): Promise<void> {
  if (!run.checkpointJson || run.checkpointStage === 'session_committed') return;
  const config = deps.config ?? getConfig();
  const checkpoint = decodeCheckpoint(run.checkpointJson, config);
  const snapshot = checkpoint.snapshot;
  if (snapshot.sessionId !== run.sessionId || snapshot.userId !== run.userId || snapshot.revision !== run.baseRevision) throw new AppError('CONFLICT', 'The parked checkpoint identity is not valid');
  const request = safeParse<{ message?: string }>(run.requestJson, {});
  const scope = { sessionId: run.sessionId, userId: run.userId };
  const waiting = invocations.filter(item => item.origin === 'pi' && ['waiting_confirmation', 'waiting_verification'].includes(item.status));
  const [models, actions] = await Promise.all([
    prisma.modelRequest.findMany({ where: { runId: run.id, run: scope, status: 'completed' },
      orderBy: { ordinal: 'asc' }, select: { id: true, resultJson: true } }),
    prisma.pendingAction.findMany({ where: { ...scope, invocationId: { in: waiting.map(item => item.id) } } }),
  ]);
  const actionsByInvocation = new Map(actions.map(action => [action.invocationId, action]));
  const buffer = createTurnBuffer(request.message, snapshot.intent);
  buffer.events.push({ type: 'session', sessionId: run.sessionId, runId: run.id });
  let modelRequestId: string | undefined;
  const handler = createEventHandler(buffer, () => Date.now(), undefined, () => modelRequestId);
  for (const model of models) {
    const source = safeParse<AssistantMessage | null>(model.resultJson, null);
    if (!source || source.role !== 'assistant' || !Array.isArray(source.content)) continue;
    modelRequestId = model.id;
    if (!snapshot.agentState.messages.some(message => message.role === 'assistant' && providerPresentationKey(message) === providerPresentationKey(source))) {
      snapshot.agentState.messages.push(source);
    }
    await handler({ type: 'message_start', message: source });
    await handler({ type: 'message_end', message: source });
    for (const call of source.content.filter(part => part.type === 'toolCall')) {
      const invocation = invocations.find(item => item.origin === 'pi' && item.modelRequestId === model.id && item.callId === call.id);
      if (!invocation || !['completed', 'waiting_confirmation', 'waiting_verification'].includes(invocation.status)) continue;
      if (runtimeRequestDigest(call.name, safeParse(invocation.argsJson, null)) !== runtimeRequestDigest(call.name, call.arguments)) {
        throw new AppError('CONFLICT', 'The waiting checkpoint call arguments do not match their recorded presentation.');
      }
      const result = safeParse<{ data?: JsonValue; summary?: string; internalSummary?: string }>(invocation.resultJson, {});
      const isWaiting = invocation.status !== 'completed';
      const action = isWaiting ? actionsByInvocation.get(invocation.id) : undefined;
      if (isWaiting && (!action || action.toolName !== call.name)) throw new AppError('CONFLICT', 'The waiting call has no original owned authorization.');
      // The PERSISTED row alone decides whether this call is still decidable: a settled
      // (`locked`/`executed`/`failed`/`cancelled`/`needs_reconciliation`) action is never
      // re-synthesized into a decision prompt and never exposes its raw refusal payload.
      const settled = isWaiting && !mayPromptForDecision(action!.status)
        ? settledParkedProjection(action!.id, action!.status, result.summary) : undefined;
      const summary = isWaiting ? settled ? settled.text
        : `${security.gateway.BLOCK_REASON_PREFIX}${JSON.stringify({ actionId: action!.id,
        decisionKind: action!.requiresMfa || action!.riskLevel === 'RED' || action!.status === 'awaiting_mfa' ? 'require_mfa' : 'require_confirmation' })}`
        : result.summary ?? '';
      // The Pi-internal result keeps the model/classifier-facing text (nothing was executed, so
      // `isError` stays true); only the public presentation below is closed.
      const message: ToolResultMessage = { role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: result.summary ?? result.internalSummary ?? summary }], details: result.data, isError: isWaiting,
        timestamp: invocation.finishedAt?.getTime() ?? Date.now() };
      snapshot.agentState.messages = withRealToolResult(snapshot.agentState.messages, message, source);
      await handler({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
      await handler({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name,
        result: { content: [{ type: 'text', text: summary }], details: result.data }, isError: isWaiting });
      // A settled refusal keeps its historical row (above) and reports its typed facts, never text.
      if (settled) buffer.events.push(settled.signal);
    }
  }
  const recovered = new Set(buffer.assistants.filter(message => message.role === 'tool').map(message => message.id));
  if (waiting.some(invocation => !invocation.modelRequestId ||
      !recovered.has(toolPresentationId(run.id, invocation.modelRequestId, invocation.callId)))) {
    throw new AppError('CONFLICT', 'The waiting checkpoint has no original completed model call.');
  }
  if (!checkpoint.inputMessagePersisted && request.message) snapshot.transcript.push({ id: newId('msg'), role: 'user', content: request.message, timestamp: Date.now() });
  for (const message of buffer.assistants) {
    const index = snapshot.transcript.findIndex(existing => existing.id === message.id);
    if (index < 0) snapshot.transcript.push(message); else snapshot.transcript[index] = message;
  }
  await saveSession(snapshot, { lease: journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
  for (const event of readyPresentationEvents(buffer)) {
    await journal.recordPresentationEvent(event);
    await deps.onEvent?.(event);
  }
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
  if (latest) journal.restoreModelRequestIdentity(latest.id, latest.status !== 'completed' ? latest.inputJson : undefined, latest.requestDigest);
  if (latest?.status === 'failed' && latest.errorCode !== 'MODEL_TRANSIENT') throw new AppError('VALIDATION', 'A permanent model failure cannot be retried');
  const advice = authorization ? snapshot.replyContext : undefined;
  if (advice && authorization) {
    const original = await readAuthorizationToolContext(authorization, snapshot, snapshot.agentState.messages);
    const latestUser = snapshot.agentState.messages.findLast(message => message.role === 'user');
    const currentText = latestUser?.role === 'user' ? typeof latestUser.content === 'string' ? latestUser.content
      : latestUser.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : undefined;
    if (!original || original.originatingPurpose !== advice.purpose || snapshot.intent?.purpose !== advice.purpose ||
        original.sourceModelRequestId !== advice.sourceModelRequestId ||
        original.originatingUserText !== advice.requestText || currentText !== advice.requestText ||
        !authorization.toolResult.ok || catalogEntry(authorization.resultToolName ?? authorization.toolName ?? '')?.effect !== 'read') {
      throw new AppError('CONFLICT', 'The saved continuation context does not match the original authorized query and current request.');
    }
  }
  const buffer = createTurnBuffer(advice?.requestText ?? request.message, snapshot.intent);
  if (advice) buffer.advisory = advice.purpose === 'advice';
  buffer.conversationFacts = collectConversationEvidence(snapshot.agentState.messages);
  if (authorization) buffer.factResults.push({ toolName: authorization.resultToolName ?? authorization.toolName ?? '',
    result: authorization.toolResult, toolCallId: authorization.toolCallId, actionId: authorization.actionId,
    sourceAccountId: authorization.sourceAccountId, taskId: authorization.taskId, nodeId: authorization.nodeId });
  buffer.events.push({ type: 'session', sessionId: run.sessionId, runId: run.id });
  if (authorization) publishAuthorizedToolOutcome(buffer, snapshot.transcript, authorization);
  const published = new Set<AgentStreamEvent>();
  const publish = async () => {
    for (const event of readyPresentationEvents(buffer)) {
      if (published.has(event)) continue;
      await journal.recordPresentationEvent(event);
      published.add(event);
      await deps.onEvent?.(event);
    }
  };
  const runtime = createBankingAgent({ sessionId: run.sessionId, userId: run.userId, snapshot, config, provider: deps.provider,
    journal,
    replyContext: advice,
    preserveSystemMessages: Boolean(latest),
    onTurnIntent: intent => {
      buffer.advisory = intent.purpose === 'advice';
      buffer.allowProtocolExamples = intent.allowProtocolExamples;
    },
    onPlanUpdate: async plan => {
      const owner = activePlanMessage(buffer);
      buffer.events.push({ type: 'plan_update', plan, ...(owner ? { messageId: owner.id } : {}) }); await publish();
    } });
  const originalModel = snapshot.agentState.model;
  const restoredModel = runtime.agent.state.model;
  if (originalModel && (originalModel.id !== restoredModel.id || originalModel.provider !== restoredModel.provider || originalModel.api !== restoredModel.api || originalModel.baseUrl !== restoredModel.baseUrl)) {
    runtime.dispose();
    throw new AppError('CONFLICT', 'Continuation requires the original model and endpoint');
  }
  let presentationModelRequestId: string | undefined;
  const handler = createEventHandler(buffer, () => Date.now(), runtime.planningRejections,
    () => presentationModelRequestId ?? journal.currentModelRequestIdentity?.());
  const observe = async (event: AgentEvent) => { await handler(event); if (event.type === 'tool_execution_end') await journal.checkpoint('tool_result'); await publish(); };
  const emit = async (event: AgentEvent) => { await journal.recordAgentEvent(event); await observe(event); };
  const unsubscribeJournal = journal.subscribe(runtime.agent);
  const unsubscribe = runtime.agent.subscribe(observe);
  const continueInContext = async () => {
    if (runtime.agent.state.messages.at(-1)?.role === 'assistant') runtime.agent.state.messages.push({ role: 'system', timestamp: Date.now(),
      content: 'Continue the interrupted answer for this recorded run using the existing conversation and verified results. Do not repeat completed tool calls, restart an earlier request, or treat a historical request as new consent.' });
    await runtime.agent.continue();
  };
  try {
    const completedModels = await prisma.modelRequest.findMany({ where: { runId: run.id, status: 'completed' },
      orderBy: { ordinal: 'asc' }, select: { id: true, resultJson: true } });
    // A crash during the next generation can precede the session's transcript commit.
    // Rebuild completed calls from their original model group, with the same stable IDs.
    for (const model of completedModels) {
      if (latest?.status === 'completed' && model.id === latest.id) continue;
      const source = safeParse<AssistantMessage | null>(model.resultJson, null);
      if (!source || source.role !== 'assistant' || !Array.isArray(source.content)) continue;
      presentationModelRequestId = model.id;
      await handler({ type: 'message_start', message: source });
      await handler({ type: 'message_end', message: source });
      for (const call of source.content.filter(part => part.type === 'toolCall')) {
        const invocation = invocations.find(item => item.origin === 'pi' && item.modelRequestId === model.id && item.callId === call.id && item.status === 'completed');
        if (!invocation || call.name === 'describe_turn') continue;
        const result = safeParse<SavedToolResult>(invocation.resultJson, {});
        if (result.ok !== true) throw new AppError('CONFLICT', 'A saved successful tool result is incomplete');
        await handler({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
        await handler({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name,
          result: { content: savedToolContent(result), details: result.data, usage: result.usage },
          isError: false, ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }) });
      }
    }
    presentationModelRequestId = undefined;
    // Completed outcomes are authoritative context, even if the crash lost Pi's tool-result message.
    for (const invocation of invocations.filter(item => item.origin === 'pi' && item.status === 'completed' && item.resultJson !== null)) {
      const result = safeParse<SavedToolResult>(invocation.resultJson, {});
      if (result.ok !== true) throw new AppError('CONFLICT', 'A saved successful tool result is incomplete');
      const message: ToolResultMessage = { role: 'toolResult', toolCallId: invocation.callId, toolName: invocation.toolName,
        content: savedToolContent(result), details: result.data, ...savedToolMetadata(result),
        isError: false, timestamp: invocation.finishedAt?.getTime() ?? Date.now() };
      if (latest?.status === 'completed' && invocation.modelRequestId === latest.id) runtime.agent.state.messages = withRealToolResult(runtime.agent.state.messages, message);
      if (invocation.toolName !== 'describe_turn' && !buffer.factResults.some(fact => fact.toolCallId === invocation.callId && fact.toolName === invocation.toolName) &&
          (latest?.status !== 'completed' || invocation.modelRequestId !== latest.id)) {
        buffer.factResults.push({ toolName: invocation.toolName, toolCallId: invocation.callId, result: { ok: true, data: result.data, summary: result.summary } });
      }
    }
    if (latest?.status === 'completed' && latest.resultJson) {
      const assistant = JSON.parse(latest.resultJson) as AssistantMessage;
      if (assistant.role !== 'assistant' || ['error', 'aborted', 'length'].includes(assistant.stopReason)) throw new AppError('CONFLICT', 'An incomplete model response cannot execute calls');
      // A completed request can outlive its Pi checkpoint. Restore the original messages in place
      // before attributing results, without replacing the retained archive with its model projection.
      if (!authorization && request.message && !runtime.agent.state.messages.some(message => message.role === 'user' &&
          (typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')) === request.message)) {
        runtime.agent.state.messages.push({ role: 'user', content: request.message, timestamp: Date.now() });
      }
      if (!runtime.agent.state.messages.some(message => message.role === 'assistant' && message.timestamp === assistant.timestamp &&
          JSON.stringify(message.content) === JSON.stringify(assistant.content))) runtime.agent.state.messages.push(assistant);
      const calls = assistant.content.filter(part => part.type === 'toolCall');
      if (calls.length) {
        await handler({ type: 'message_start', message: assistant });
        await handler({ type: 'message_end', message: assistant });
      }
      let dialogueCallRejected = false;
      for (const call of calls) {
        const invocation = invocations.find(item => item.origin === 'pi' && item.modelRequestId === latest.id && item.callId === call.id);
        if (invocation) {
          if (invocation.requestDigest !== runtimeRequestDigest(call.name, call.arguments)) throw new AppError('CONFLICT', 'The original tool arguments do not match their invocation');
          if (invocation.status !== 'completed') throw new AppError('CONFLICT', 'An unresolved original tool call cannot be replaced');
          const result = safeParse<SavedToolResult>(invocation.resultJson, {});
          runtime.agent.state.messages = withRealToolResult(runtime.agent.state.messages, { role: 'toolResult', toolCallId: call.id,
            toolName: call.name, content: savedToolContent(result),
            details: result.data, ...savedToolMetadata(result), isError: false, timestamp: invocation.finishedAt?.getTime() ?? Date.now() });
          await handler({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
          await handler({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name,
            result: { content: savedToolContent(result), details: result.data, usage: result.usage },
            isError: false, ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }) });
          continue;
        }
        if (hasRedactedCredentials(call.arguments)) throw new AppError('SECURITY_DENIED', 'Credential input must be supplied through a new authorization workflow');
        const message = await runtime.executeCheckpointCall(call, assistant, emit);
        runtime.agent.state.messages = withRealToolResult(runtime.agent.state.messages, message);
        await journal.checkpoint('tool_result');
        const parked = await prisma.toolInvocation.findFirst({ where: { runId: run.id, origin: 'pi', callId: call.id }, orderBy: { ordinal: 'desc' } });
        if (parked?.status === 'waiting_confirmation' || parked?.status === 'waiting_verification') {
          snapshot.agentState = runtime.serialize().agentState;
          buffer.events = readyPresentationEvents(buffer);
          snapshot.transcript.push(...buffer.assistants);
          await saveSession(snapshot, { lease: journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
          buffer.events.push({ type: 'done' }); await publish();
          return parked.status;
        }
        if (message.isError) {
          if (runtime.planningRejections.has(call.id)) {
            dialogueCallRejected = true;
            break;
          }
          throw new AppError('TOOL_FAILED', 'The original checkpoint tool call failed');
        }
      }
      if (dialogueCallRejected) {
        if (buffer.conversational && !buffer.serverGuidance) await continueInContext();
        else publishServerReply(runtime, buffer, () => Date.now(), renderFinancialResponse(buffer.factResults, { guidance: buffer.serverGuidance }));
      } else if (calls.length === 0) {
        // Generation already completed. Rebuild its grounded presentation without another request.
        await handler({ type: 'message_start', message: assistant });
        await handler({ type: 'message_end', message: assistant });
        await continueDeclaredWrites(runtime, buffer, () => Date.now(), { config });
      } else if (calls.some(call => call.name === 'submit_plan')) {
        publishServerReply(runtime, buffer, () => Date.now(), renderFinancialResponse(buffer.factResults));
      } else await continueInContext();
    } else if (!authorization && !latest && buffer.serverGuidance?.code === 'invalid_amount') {
      runtime.agent.state.messages.push({ role: 'user', content: request.message!, timestamp: Date.now() });
      publishServerReply(runtime, buffer, () => Date.now(), renderFinancialResponse([], { guidance: buffer.serverGuidance, requestText: request.message }));
    } else if (run.checkpointStage === 'input') await runtime.agent.prompt(request.message!);
    else await continueInContext();
    if (config.llmMode === 'live') await repairConversationalReply(runtime, buffer, () => Date.now());
    const terminal = runtime.agent.state.messages.at(-1);
    if (terminal?.role === 'assistant' && ['error', 'aborted', 'length'].includes(terminal.stopReason)) {
      throw new AppError(retryableModelFailure(terminal) ? 'INTERNAL' : 'VALIDATION', 'Model continuation did not complete', { retryable: retryableModelFailure(terminal) });
    }
    if (!buffer.current || buffer.current.content === '') {
      publishServerReply(runtime, buffer, () => Date.now(), buffer.conversational && !buffer.serverGuidance
        ? renderConversationalResponse('') : renderFinancialResponse(buffer.factResults, { guidance: buffer.serverGuidance }));
    }
    const serialized = runtime.serialize();
    snapshot.agentState = serialized.agentState;
    snapshot.intent = serialized.intent;
    snapshot.contextCompaction = serialized.contextCompaction;
    snapshot.replyRepair = serialized.replyRepair;
    snapshot.replyContext = serialized.replyContext;
    snapshot.writeContinuation = serialized.writeContinuation;
    snapshot.modelBudget = serialized.modelBudget;
    groundMessage(buffer, buffer.current);
    buffer.events = readyPresentationEvents(buffer);
    if (!authorization && !checkpoint.inputMessagePersisted) snapshot.transcript.push({ id: newId('msg'), role: 'user', content: request.message!, timestamp: Date.now() });
    snapshot.transcript.push(...buffer.assistants);
    await saveSession(snapshot, { lease: journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
    buffer.events.push({ type: 'done' }); await publish();
    return buffer.events.some(event => event.type === 'mfa_required') ? 'waiting_verification'
      : buffer.events.some(event => event.type === 'confirmation_required') ? 'waiting_confirmation' : 'completed';
  } finally { unsubscribe(); unsubscribeJournal(); runtime.dispose(); }
}

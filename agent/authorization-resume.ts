import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, JsonValue, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import { demoNow } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import { toJson } from '@/lib/json';
import { createBankingAgent, type BankingAgentRuntime } from './banking-agent';
import { renderFinancialResponse } from './financial-response';
import { withRealToolResult } from './message-normalize';
import { saveSession, type SessionSnapshot } from './session';
import type { TurnRuntime } from './turn-runtime';
import type { ResumeTurnInput, RunTurnDeps, TurnBuffer } from './turn-presentation';
import { encodeCheckpoint } from './durable/checkpoint';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ChatMessage } from '@/lib/contracts/agent';
import { publishAuthorizedToolOutcome, readyPresentationEvents } from './turns/buffer';
import { readAuthorizationToolContext } from './authorization-context';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { collectConversationEvidence } from './conversation-evidence';
import { repairConversationalReply } from './turns/live-prompt';
import { findRunFailure, modelFailureMessage } from './turns/message-utils';
import { toModelToolResult } from './tools/result';

interface Relay { parkedActionId?: string; parkedToolName?: string; }
export interface ResumePresentation {
  createBuffer(): TurnBuffer;
  createHandler(buffer: TurnBuffer, now: () => number, rejected?: ReadonlyMap<string, string>,
    modelRequestIdentity?: () => string | undefined): (event: AgentEvent) => Promise<void>;
  relayPlan(buffer: TurnBuffer, relay: Relay, plan: TaskPlan): void;
  flushDecision(buffer: TurnBuffer, relay: Relay): Promise<void>;
  ground(buffer: TurnBuffer, message: ChatMessage | null): void;
  reply(runtime: BankingAgentRuntime, buffer: TurnBuffer, now: () => number, content: string): void;
}

function findCall(messages: readonly AgentMessage[], id?: string, name?: ToolName): ToolCall | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const calls = (message as AssistantMessage).content.filter(part => part.type === 'toolCall');
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex--) {
      const call = calls[callIndex];
      if ((id === undefined || call.id === id) && (name === undefined || call.name === name)) return call;
    }
  }
  return undefined;
}

/** Inject a committed authorization outcome into the matching original provider call. */
export async function performAuthorizationResume(input: ResumeTurnInput, deps: RunTurnDeps | undefined,
  snapshot: SessionSnapshot, context: TurnRuntime, presentation: ResumePresentation): Promise<ChatTurnResponse> {
  const config = deps?.config ?? getConfig();
  const now = deps?.now ?? demoNow;
  const buffer = presentation.createBuffer();
  const original = await readAuthorizationToolContext(input, snapshot, snapshot.agentState.messages);
  const latestUser = snapshot.agentState.messages.findLast(message => message.role === 'user');
  const latestUserText = latestUser?.role === 'user' ? typeof latestUser.content === 'string'
    ? latestUser.content : latestUser.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : undefined;
  const continuationText = input.toolResult.ok && original?.originatingUserText === latestUserText &&
    original?.originatingUserText && (original.originatingPurpose === 'advice' || original.originatingPurpose === 'query' || original.originatingPurpose === 'operation') &&
    snapshot.intent?.purpose === original.originatingPurpose &&
    catalogEntry(input.resultToolName ?? input.toolName ?? '')?.effect === 'read'
    ? original.originatingUserText : undefined;
  if (continuationText) {
    buffer.requestText = continuationText;
    buffer.conversational = true;
    buffer.advisory = original?.originatingPurpose === 'advice';
    buffer.allowProtocolExamples = snapshot.intent?.allowProtocolExamples;
    buffer.conversationFacts = collectConversationEvidence(snapshot.agentState.messages);
  }
  buffer.events.push({ type: 'session', sessionId: snapshot.sessionId, runId: context.journal.lease.runId });
  const relay: Relay = {};
  const runtime = createBankingAgent({ sessionId: snapshot.sessionId, userId: snapshot.userId, snapshot, config,
    provider: deps?.provider, journal: context.journal,
    ...(continuationText && original?.sourceModelRequestId && (original.originatingPurpose === 'advice' || original.originatingPurpose === 'query' || original.originatingPurpose === 'operation') ? { replyContext: {
      purpose: original.originatingPurpose, requestText: continuationText, sourceModelRequestId: original.sourceModelRequestId,
    } } : {}),
    onTurnIntent: intent => {
      buffer.advisory = intent.purpose === 'advice';
      buffer.allowProtocolExamples = intent.allowProtocolExamples;
    },
    onPlanUpdate: async plan => { presentation.relayPlan(buffer, relay, plan); await context.publish(buffer.events); } });
  const unsubscribeJournal = context.journal.subscribe(runtime.agent);
  const handler = presentation.createHandler(buffer, now, runtime.planningRejections,
    () => context.journal.currentModelRequestIdentity?.());
  const unsubscribe = runtime.agent.subscribe(async event => {
    await handler(event);
    if (event.type === 'tool_execution_end') await context.journal.checkpoint('tool_result');
    await context.publish(readyPresentationEvents(buffer));
  });
  try {
    await context.journal.checkpoint('input');
    const call = original ? original.call : findCall(runtime.agent.state.messages, input.toolCallId, input.toolName);
    const toolCallId = input.toolCallId ?? call?.id ?? '';
    const output = toModelToolResult(input.toolResult);
    const message: ToolResultMessage = { role: 'toolResult', toolCallId, toolName: call?.name ?? 'unknown',
      content: output.content,
      details: output.details === undefined ? undefined : JSON.parse(toJson(output.details)) as JsonValue,
      isError: input.toolResult.ok !== true, timestamp: now() };
    runtime.agent.state.messages = withRealToolResult(runtime.agent.state.messages, message, original?.owner);
    publishAuthorizedToolOutcome(buffer, snapshot.transcript, { ...input,
      toolCallId, toolName: input.toolName ?? call?.name as ToolName | undefined });
    buffer.factResults.push({ toolName: input.resultToolName ?? input.toolName ?? '', result: input.toolResult,
      ...(input.sourceAccountId !== undefined ? { sourceAccountId: input.sourceAccountId } : {}),
      ...(toolCallId !== '' ? { toolCallId } : {}), ...(input.actionId ? { actionId: input.actionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}) });
    if (continuationText) {
      // Query approval resumes the original question or remaining declared operation, never grants write consent.
      runtime.agent.state.messages.push({ role: 'system', timestamp: now(),
        content: original?.originatingPurpose === 'operation'
          ? 'The user approved only the original query. Its verified result is now in the original tool group. Continue planning the remaining operations in this same declared user request using that result. Keep the existing purpose and declared operation list. Do not repeat completed operations or queries. Query approval grants no permission for a mutation: propose remaining declared writes through the normal gateway, and require each operation confirmation or MFA before execution. Do not resume a different or historical request.'
          : 'The user confirmed the requested query, and its verified result is now in the original tool group. Answer the same current advice or query question completely. This is not permission for a mutation or workflow. Reuse the completed query rather than asking for the same authorization again. Distinguish observed costs from assumptions about usage.' });
      await context.journal.checkpoint('authorized_read_result');
      await runtime.agent.continue();
      await repairConversationalReply(runtime, buffer, now);
      const failure = findRunFailure(runtime.agent.state.messages.slice(-1));
      if (failure) buffer.events.push({ type: 'error', message: modelFailureMessage(failure) });
    } else {
      // Mutation outcomes remain server-authored receipts, without a new model execution turn.
      presentation.reply(runtime, buffer, now, renderFinancialResponse(buffer.factResults));
    }
  } catch (error) { buffer.events.push({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  finally { await presentation.flushDecision(buffer, relay); unsubscribe(); unsubscribeJournal(); runtime.dispose(); }
  const serialized = runtime.serialize();
  snapshot.agentState = serialized.agentState;
  snapshot.intent = serialized.intent;
  snapshot.contextCompaction = serialized.contextCompaction;
  snapshot.replyRepair = serialized.replyRepair;
  snapshot.replyContext = serialized.replyContext;
  snapshot.writeContinuation = serialized.writeContinuation;
  presentation.ground(buffer, buffer.current);
  buffer.events = readyPresentationEvents(buffer);
  snapshot.transcript.push(...buffer.assistants);
  await saveSession(snapshot, { lease: context.journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
  buffer.events.push({ type: 'done' });
  return { sessionId: snapshot.sessionId, events: buffer.events };
}

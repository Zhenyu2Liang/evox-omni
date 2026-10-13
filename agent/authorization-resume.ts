import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, JsonValue, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import { demoNow } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
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

interface Relay { parkedActionId?: string; parkedToolName?: string; }
export interface ResumePresentation {
  createBuffer(): TurnBuffer;
  createHandler(buffer: TurnBuffer, now: () => number): (event: AgentEvent) => Promise<void>;
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
  buffer.events.push({ type: 'session', sessionId: snapshot.sessionId, runId: context.journal.lease.runId });
  const relay: Relay = {};
  const runtime = createBankingAgent({ sessionId: snapshot.sessionId, userId: snapshot.userId, snapshot, config,
    provider: deps?.provider, journal: context.journal,
    onPlanUpdate: async plan => { presentation.relayPlan(buffer, relay, plan); await context.publish(buffer.events); } });
  const unsubscribeJournal = context.journal.subscribe(runtime.agent);
  const handler = presentation.createHandler(buffer, now);
  const unsubscribe = runtime.agent.subscribe(async event => {
    await handler(event);
    if (event.type === 'tool_execution_end') await context.journal.checkpoint('tool_result');
    await context.publish(buffer.events);
  });
  try {
    const call = findCall(runtime.agent.state.messages, input.toolCallId, input.toolName);
    if (input.toolName !== undefined && !call) throw new AppError('CONFLICT', `The original ${input.toolName} tool call could not be located; the committed outcome remains saved`);
    const toolCallId = input.toolCallId ?? call?.id ?? '';
    const message: ToolResultMessage = { role: 'toolResult', toolCallId, toolName: call?.name ?? 'unknown',
      content: [{ type: 'text', text: input.toolResult.summary ?? input.toolResult.error ?? (input.toolResult.ok ? 'Operation completed' : 'Tool execution failed') }],
      details: input.toolResult.data === undefined ? undefined : JSON.parse(toJson(input.toolResult.data)) as JsonValue,
      isError: input.toolResult.ok !== true, timestamp: now() };
    runtime.agent.state.messages = withRealToolResult(runtime.agent.state.messages, message);
    buffer.factResults.push({ toolName: input.resultToolName ?? input.toolName ?? '', result: input.toolResult,
      ...(input.sourceAccountId !== undefined ? { sourceAccountId: input.sourceAccountId } : {}),
      ...(toolCallId !== '' ? { toolCallId } : {}), ...(input.actionId ? { actionId: input.actionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}) });
    if (config.llmMode === 'live') presentation.reply(runtime, buffer, now, renderFinancialResponse(buffer.factResults));
    else await runtime.agent.continue();
  } catch (error) { buffer.events.push({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  finally { await presentation.flushDecision(buffer, relay); unsubscribe(); unsubscribeJournal(); runtime.dispose(); }
  snapshot.agentState = runtime.serialize().agentState;
  presentation.ground(buffer, buffer.current);
  snapshot.transcript.push(...buffer.assistants);
  await saveSession(snapshot, { lease: context.journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
  buffer.events.push({ type: 'done' });
  return { sessionId: snapshot.sessionId, events: buffer.events };
}

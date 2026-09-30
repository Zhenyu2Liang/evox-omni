/**
 * run-turn.ts — one chat turn + the confirmation resume.
 * `runTurn`: resolve/create session, injection scan (security.injection), build runtime
 * (`createBankingAgent`), subscribe to pi AgentEvents and map them to AgentStreamEvents (mapping
 * table in ../CONTEXT.md), prompt the agent, persist the session, return the collected events.
 * `resumeTurn`: inject a REAL tool result and call `agent.continue()` so the model narrates only the
 * factual outcome. NO chain-of-thought is emitted — only task steps / tool status / results.
 */
import type {
  AgentStreamEvent,
  ChatCard,
  ChatMessage,
  ChatTurnRequest,
  ChatTurnResponse,
  ToolEventView,
} from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { ToolName } from '@/lib/contracts/tools';
import type { AppConfig } from '@/lib/config';
import { getConfig } from '@/lib/config';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { safeParse } from '@/lib/json';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { security } from '@/security';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai';
import { createBankingAgent, type BankingAgentRuntime } from './banking-agent';
import { confirmationCard, errorCard, mfaCard, toCards } from './card-emitter';
import { getOrCreateSession, loadSession, saveSession } from './session';
import type { ToolExecutionResult } from './tools';

export interface RunTurnDeps { config?: AppConfig; now?: () => number; }
export interface ResumeTurnInput {
  sessionId: string;
  toolResult: ToolExecutionResult;
  toolCallId?: string;
}

/** MFA prompt hint surfaced to the UI (never contains the code). */
const MFA_HINT = '请输入 6 位短信验证码。';

/** Fallback text when a failed tool carries no message of its own. */
const TOOL_FAILURE_FALLBACK = '工具执行失败';

/**
 * The gateway runtime object + block-reason tag. `@/security` re-exports the gateway MODULE
 * namespace (whose named exports include the `securityGateway` object); `parseBlockReason` /
 * `serializeBlockReason` are methods of that object, not standalone module exports.
 */
const gateway = security.gateway.securityGateway;
const BLOCK_REASON_PREFIX = security.gateway.BLOCK_REASON_PREFIX;

/* ----------------------------------------------------------------------------- small utils */

/** Coerce any value to a safe, non-throwing string (the `error` stream event payload). */
function safeToString(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return isRecord(message) && message.role === 'assistant';
}

/** Concatenate the text parts of a message `content` array (ignores thinking / toolCall / image). */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') out += part.text;
  }
  return out;
}

/** Extract the plain text carried in an `AgentToolResult` / a tool-result message. */
function textOfResult(result: unknown): string {
  return isRecord(result) ? textOfContent(result.content) : '';
}

function isToolExecutionResult(value: unknown): value is ToolExecutionResult {
  return isRecord(value) && typeof value.ok === 'boolean';
}

/**
 * Derive a `ToolExecutionResult` from the raw `details` a tool returned. Family tools put the
 * Banking-SDK DTO directly in `details` (NOT a `ToolExecutionResult`), so a plain DTO is wrapped
 * as `{ ok: true, data }` using the tool's text content as the summary.
 */
function toExecutionResult(details: unknown, summary: string): ToolExecutionResult {
  if (isToolExecutionResult(details)) return details;
  return summary === '' ? { ok: true, data: details } : { ok: true, data: details, summary };
}

/* ------------------------------------------------------------------------- turn collection */

/** Mutable accumulator for one turn (events + the assistant messages built during it). */
interface TurnBuffer {
  events: AgentStreamEvent[];
  /** Assistant `ChatMessage`s created this turn (appended to the transcript on persist). */
  assistants: ChatMessage[];
  /** The assistant message currently streaming (tool events / cards attach here). */
  current: ChatMessage | null;
}

function createTurnBuffer(): TurnBuffer {
  return { events: [], assistants: [], current: null };
}

function newAssistantMessage(now: number): ChatMessage {
  return {
    id: newId('msg'),
    role: 'assistant',
    content: '',
    timestamp: now,
    cards: [],
    toolEvents: [],
  };
}

/** Replace an existing tool-timeline entry for `toolCallId`, else append (one row per tool call). */
function upsertToolEvent(message: ChatMessage | null, view: ToolEventView): void {
  if (message === null) return;
  const list = message.toolEvents ?? (message.toolEvents = []);
  const index = list.findIndex((entry) => entry.toolCallId === view.toolCallId);
  if (index >= 0) list[index] = view;
  else list.push(view);
}

/** Attach a card to the current assistant message and emit it (cards always come from a tool). */
function emitCard(buffer: TurnBuffer, card: ChatCard): void {
  if (buffer.current !== null) {
    const list = buffer.current.cards ?? (buffer.current.cards = []);
    list.push(card);
  }
  buffer.events.push({ type: 'card', card });
}

/** Map a successful tool result to its card(s) (`card-emitter.toCards` is PURE + total). */
function emitToolCards(buffer: TurnBuffer, toolName: string, result: ToolExecutionResult): void {
  for (const card of toCards(toolName as ToolName, result)) emitCard(buffer, card);
}

/** Build the `PendingActionSummary` for a gated call from its persisted `PendingAction` row. */
async function loadPendingSummary(
  actionId: string,
  toolName: string,
): Promise<PendingActionSummary> {
  const fallback: PendingActionSummary = {
    title: '待处理操作',
    toolName: toolName as ToolName,
    tier: 'YELLOW',
    fields: [],
    requiresMfa: false,
  };
  const row = await getPendingAction(actionId);
  if (row === null) return fallback;
  return safeParse<PendingActionSummary>(row.summaryJson, {
    ...fallback,
    toolName: row.toolName as ToolName,
    tier: row.riskLevel as RiskLevel,
    requiresMfa: row.requiresMfa,
  });
}

/** The `tool_execution_end` variant of the pi `AgentEvent` union. */
type ToolExecutionEndEvent = Extract<AgentEvent, { type: 'tool_execution_end' }>;

/**
 * Map a finished tool call. A gated (YELLOW/RED) call arrives here as an ERROR tool result whose
 * text is the gateway's opaque block reason (`securityGateway.parseBlockReason`); a locked session
 * arrives as a `deny` block reason (no actionId). Anything else is a genuine tool failure.
 */
async function handleToolExecutionEnd(
  buffer: TurnBuffer,
  event: ToolExecutionEndEvent,
): Promise<void> {
  const { toolCallId, toolName } = event;

  if (!event.isError) {
    const details = isRecord(event.result) ? event.result.details : undefined;
    const summary = textOfResult(event.result);
    const execResult = toExecutionResult(details, summary);
    const view: ToolEventView = {
      toolCallId,
      toolName,
      status: 'success',
      ...(summary !== '' ? { summary } : {}),
    };
    upsertToolEvent(buffer.current, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    emitToolCards(buffer, toolName, execResult);
    return;
  }

  const errorText = textOfResult(event.result);
  const message = errorText !== '' ? errorText : TOOL_FAILURE_FALLBACK;
  const parsed = gateway.parseBlockReason(message);
  const blocked = parsed !== null || message.startsWith(BLOCK_REASON_PREFIX);

  // A genuine tool failure — surface the error status + card.
  if (!blocked) {
    const view: ToolEventView = { toolCallId, toolName, status: 'error', summary: message };
    upsertToolEvent(buffer.current, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    emitCard(buffer, errorCard(message));
    return;
  }

  // GATED — the gateway blocked the call and (for YELLOW/RED) persisted a PendingAction.
  const blockView: ToolEventView = { toolCallId, toolName, status: 'blocked' };
  upsertToolEvent(buffer.current, blockView);
  buffer.events.push({ type: 'tool_end', toolEvent: blockView });

  if (parsed !== null && parsed.decisionKind === 'require_mfa') {
    buffer.events.push({ type: 'mfa_required', actionId: parsed.actionId, hint: MFA_HINT });
    emitCard(buffer, mfaCard(parsed.actionId, MFA_HINT));
    return;
  }

  if (parsed !== null && parsed.decisionKind === 'require_confirmation') {
    const summary = await loadPendingSummary(parsed.actionId, toolName);
    buffer.events.push({
      type: 'confirmation_required',
      action: summary,
      actionId: parsed.actionId,
    });
    emitCard(buffer, confirmationCard(summary));
    return;
  }

  // `deny` (circuit breaker) or an unrecognised block reason — nothing to confirm.
  buffer.events.push({ type: 'security_event', kind: 'locked', message });
}

/** The last assistant message that failed the run (pi reports LLM errors via `agent_end`). */
function findRunFailure(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return message;
  }
  return null;
}

/**
 * Build the pi `AgentEvent` → `AgentStreamEvent` listener. Every mapping lives here so `runTurn`
 * and `resumeTurn` stream identically. The body is wrapped so a mapping bug becomes an `error`
 * event rather than an unhandled rejection (never swallowed silently).
 */
function createEventHandler(
  buffer: TurnBuffer,
  now: () => number,
): (event: AgentEvent) => Promise<void> {
  return async (event: AgentEvent): Promise<void> => {
    try {
      switch (event.type) {
        case 'message_start': {
          if (!isAssistantMessage(event.message)) return; // ignore user / toolResult messages
          const assistant = newAssistantMessage(now());
          buffer.current = assistant;
          buffer.assistants.push(assistant);
          buffer.events.push({ type: 'message_start', message: { ...assistant } });
          return;
        }
        case 'message_update': {
          const assistantEvent = event.assistantMessageEvent;
          // ONLY text deltas — never emit thinking/chain-of-thought.
          if (assistantEvent.type !== 'text_delta') return;
          const delta = assistantEvent.delta;
          if (delta === '') return;
          if (buffer.current !== null) buffer.current.content += delta;
          buffer.events.push({ type: 'text_delta', delta });
          return;
        }
        case 'message_end': {
          if (!isAssistantMessage(event.message)) return;
          const full = textOfContent(event.message.content);
          const assistant = buffer.current ?? newAssistantMessage(now());
          if (assistant.content === '' && full !== '') assistant.content = full;
          buffer.events.push({ type: 'message_end', message: assistant });
          return;
        }
        case 'tool_execution_start': {
          const view: ToolEventView = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: 'started',
          };
          upsertToolEvent(buffer.current, view);
          buffer.events.push({ type: 'tool_start', toolEvent: view });
          return;
        }
        case 'tool_execution_update': {
          const view: ToolEventView = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: 'updated',
          };
          upsertToolEvent(buffer.current, view);
          buffer.events.push({ type: 'tool_end', toolEvent: view });
          return;
        }
        case 'tool_execution_end': {
          await handleToolExecutionEnd(buffer, event);
          return;
        }
        case 'agent_end': {
          const failure = findRunFailure(event.messages);
          if (failure !== null && failure.errorMessage !== undefined && failure.errorMessage !== '') {
            buffer.events.push({ type: 'error', message: failure.errorMessage });
          }
          return;
        }
        // agent_start / turn_start / turn_end carry no UI stream event.
        default:
          return;
      }
    } catch (error) {
      buffer.events.push({ type: 'error', message: safeToString(error) });
    }
  };
}

/* -------------------------------------------------------------------------------- runTurn */

/** Run one agent turn; returns the stream events emitted during it. */
export async function runTurn(
  req: ChatTurnRequest,
  deps?: RunTurnDeps,
): Promise<ChatTurnResponse> {
  const config = deps?.config ?? getConfig();
  const now = deps?.now ?? (() => demoNow());

  const snapshot = await getOrCreateSession(config.demoUserId, req.sessionId);
  const buffer = createTurnBuffer();
  buffer.events.push({ type: 'session', sessionId: snapshot.sessionId });

  // Injection scan is defense-in-depth ONLY — it records a SecurityEvent but NEVER grants
  // permission (the gateway remains the sole authority).
  const scan = security.injection.scan(req.message);
  if (scan.suspicious) {
    await security.injection.reportInjection(snapshot.sessionId, req.message, scan);
    buffer.events.push({ type: 'security_event', kind: 'injection', message: scan.note });
  }

  const runtime = createBankingAgent({
    sessionId: snapshot.sessionId,
    userId: config.demoUserId,
    snapshot,
    config,
  });

  const unsubscribe = runtime.agent.subscribe(createEventHandler(buffer, now));
  try {
    await runtime.agent.prompt(req.message);
  } finally {
    unsubscribe();
    runtime.dispose();
  }

  const userMessage: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    content: req.message,
    timestamp: now(),
  };

  snapshot.agentState = runtime.serialize().agentState;
  snapshot.transcript.push(userMessage, ...buffer.assistants);
  await saveSession(snapshot);

  buffer.events.push({ type: 'done' });
  return { sessionId: snapshot.sessionId, events: buffer.events };
}

/* ------------------------------------------------------------------------------ resumeTurn */

/** The last tool call the model proposed (scanned backwards through the agent transcript). */
function findLastToolCall(messages: readonly AgentMessage[]): ToolCall | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const part = message.content[j];
      if (part.type === 'toolCall') return part;
    }
  }
  return null;
}

/**
 * Build the pi tool-result message carrying the REAL outcome of a gated tool. Appending it (rather
 * than re-prompting) is what lets `agent.continue()` run: the last transcript entry must be a
 * user/tool-result message for the model to narrate the factual result.
 */
function buildToolResultMessage(
  input: ResumeTurnInput,
  runtime: BankingAgentRuntime,
  timestamp: number,
): ToolResultMessage {
  const lastCall = findLastToolCall(runtime.agent.state.messages);
  const toolCallId = input.toolCallId ?? lastCall?.id ?? newId('tool');
  const toolName = lastCall?.name ?? 'unknown';
  const text =
    input.toolResult.summary ??
    input.toolResult.error ??
    (input.toolResult.ok ? '操作完成' : TOOL_FAILURE_FALLBACK);

  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    details: input.toolResult.data,
    isError: input.toolResult.ok !== true,
    timestamp,
  };
}

/** Resume a session after a human confirmation: inject the real tool result and `agent.continue()`. */
export async function resumeTurn(
  input: ResumeTurnInput,
  deps?: RunTurnDeps,
): Promise<ChatTurnResponse> {
  const config = deps?.config ?? getConfig();
  const now = deps?.now ?? (() => demoNow());

  const snapshot = await loadSession(input.sessionId);
  if (snapshot === null) {
    throw new AppError('NOT_FOUND', `未找到会话: ${input.sessionId}`);
  }

  const buffer = createTurnBuffer();
  buffer.events.push({ type: 'session', sessionId: snapshot.sessionId });

  const runtime = createBankingAgent({
    sessionId: snapshot.sessionId,
    userId: snapshot.userId,
    snapshot,
    config,
  });

  const unsubscribe = runtime.agent.subscribe(createEventHandler(buffer, now));
  try {
    const toolResultMessage = buildToolResultMessage(input, runtime, now());
    runtime.agent.state.messages = [...runtime.agent.state.messages, toolResultMessage];
    await runtime.agent.continue();
  } finally {
    unsubscribe();
    runtime.dispose();
  }

  snapshot.agentState = runtime.serialize().agentState;
  snapshot.transcript.push(...buffer.assistants);
  await saveSession(snapshot);

  buffer.events.push({ type: 'done' });
  return { sessionId: snapshot.sessionId, events: buffer.events };
}

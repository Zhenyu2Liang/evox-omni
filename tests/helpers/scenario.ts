/**
 * tests/helpers/scenario.ts — drive a full agent session turn and collect its events.
 *
 * This is the harness the `tests/scenarios/*` specs use to prove the 12 demo scenarios
 * end-to-end. It wraps a `FauxAgent` (`./faux-agent`) and mirrors the real two-phase flow
 * of `POST /api/chat` + `POST /api/actions/:id/{confirm|verify|cancel}` WITHOUT going through
 * Next.js HTTP — it calls the same agent-runtime + security-gateway + SDK functions the routes
 * call, so the assertions target real behaviour, not a mock.
 *
 * It is a TEST-ONLY re-instantiation of `@/agent/run-turn.ts`'s collection logic, driven against a
 * RAW scripted agent (from `./faux-agent`). It deliberately does NOT route through
 * `@/agent.runTurn`/`resumeTurn`: those require a persisted `AgentSession` row and rebuild the agent
 * with the UNSCRIPTED config model, which would break the scripted model.
 *
 * Two phases (see root CONTEXT.md):
 *   1. `runTurn()` — prompt the agent; GREEN tools execute inline, YELLOW/RED tools are BLOCKED
 *      by `beforeToolCall`, a `PendingAction` is persisted, and a `confirmation_required` /
 *      `mfa_required` event is surfaced.
 *   2. `confirmAction()` / `verifyAction()` — a HUMAN decision executes the ORIGINAL validated
 *      args through the gateway's authorized path, then `agent.continue()` narrates the outcome.
 */
import type { Agent, AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { fauxAssistantMessage } from '@mariozechner/pi-ai';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai';
import type {
  AgentStreamEvent,
  ChatCard,
  ChatMessage,
  PendingActionSummary,
  TaskPlan,
  ToolEventView,
} from '@/lib/contracts/agent';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { ToolName } from '@/lib/contracts/tools';
import { newId } from '@/lib/ids';
import { demoNow } from '@/lib/clock';
import { safeParse } from '@/lib/json';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { security } from '@/security';
import {
  confirmationCard,
  createToolRegistry,
  errorCard,
  mfaCard,
  toCards,
  type ToolExecutionResult,
} from '@/agent';
import { recordAudit } from '@/audit';
import { DEMO_USER_ID } from './fixtures';
import { fauxRegistrationOf } from './faux-agent';

/** Everything a spec needs to assert about one completed agent turn. */
export interface ScenarioResult {
  sessionId: string;
  /** Raw ordered stream events (never contains chain-of-thought — UI contract). */
  events: AgentStreamEvent[];
  /** Concatenated assistant text of the turn. */
  text: string;
  /** Tool lifecycle events (started/success/error/blocked). */
  toolEvents: ToolEventView[];
  /** Structured cards surfaced to the UI (balance/confirmation/mfa/plan/…). */
  cards: ChatCard[];
  /** Present when the turn ended awaiting a YELLOW/RED human decision. */
  confirmation?: { actionId: string; action: PendingActionSummary };
  /** Present when the turn ended awaiting MFA (RED). */
  mfa?: { actionId: string; hint?: string };
  /** Present when a plan was submitted/updated. */
  plan?: TaskPlan;
  /** Present when the turn surfaced an error. */
  error?: string;
}

export interface RunTurnInput {
  sessionId: string;
  message: string;
  /** Agent instance (usually from `faux-agent.buildFauxAgent`). */
  agent: Agent;
}

const gateway = security.gateway.securityGateway;
const BLOCK_REASON_PREFIX = security.gateway.BLOCK_REASON_PREFIX;

/** MFA prompt hint surfaced to the UI (never contains the code). */
const MFA_HINT = '请输入 6 位短信验证码。';
/** Fallback text when a failed tool carries no message of its own. */
const TOOL_FAILURE_FALLBACK = '工具执行失败';

/* ----------------------------------------------------------------------------- small utils */

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

/** Derive a `ToolExecutionResult` from the raw `details` a family tool returned. */
function toExecutionResult(details: unknown, summary: string): ToolExecutionResult {
  if (isToolExecutionResult(details)) return details;
  return summary === '' ? { ok: true, data: details } : { ok: true, data: details, summary };
}

/* ------------------------------------------------------------------------- turn collection */

/** Mutable accumulator for one turn (stream events + everything a spec asserts on). */
interface TurnBuffer {
  events: AgentStreamEvent[];
  assistants: ChatMessage[];
  current: ChatMessage | null;
  text: string;
  toolEvents: ToolEventView[];
  cards: ChatCard[];
  plan?: TaskPlan;
  confirmation?: { actionId: string; action: PendingActionSummary };
  mfa?: { actionId: string; hint?: string };
  error?: string;
}

function createTurnBuffer(): TurnBuffer {
  return { events: [], assistants: [], current: null, text: '', toolEvents: [], cards: [] };
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
function upsertToolEvent(buffer: TurnBuffer, view: ToolEventView): void {
  const list = buffer.toolEvents;
  const index = list.findIndex((entry) => entry.toolCallId === view.toolCallId);
  if (index >= 0) list[index] = view;
  else list.push(view);

  if (buffer.current !== null) {
    const messageList = buffer.current.toolEvents ?? (buffer.current.toolEvents = []);
    const messageIndex = messageList.findIndex((entry) => entry.toolCallId === view.toolCallId);
    if (messageIndex >= 0) messageList[messageIndex] = view;
    else messageList.push(view);
  }
}

/** Attach a card to the current assistant message and emit it (cards always come from a tool). */
function emitCard(buffer: TurnBuffer, card: ChatCard): void {
  if (buffer.current !== null) {
    const list = buffer.current.cards ?? (buffer.current.cards = []);
    list.push(card);
  }
  buffer.cards.push(card);
  buffer.events.push({ type: 'card', card });
  if (card.type === 'plan') buffer.plan = card.plan;
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

type ToolExecutionEndEvent = Extract<AgentEvent, { type: 'tool_execution_end' }>;

/**
 * Map a finished tool call. A gated (YELLOW/RED) call arrives here as an ERROR tool result whose
 * text is the gateway's opaque block reason; a locked session arrives as a `deny` block reason
 * (no actionId) and is surfaced as a `security_event{kind:'locked'}`.
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
    upsertToolEvent(buffer, view);
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
    upsertToolEvent(buffer, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    emitCard(buffer, errorCard(message));
    return;
  }

  // GATED — the gateway blocked the call and (for YELLOW/RED) persisted a PendingAction.
  const blockView: ToolEventView = { toolCallId, toolName, status: 'blocked' };
  upsertToolEvent(buffer, blockView);
  buffer.events.push({ type: 'tool_end', toolEvent: blockView });

  if (parsed !== null && parsed.decisionKind === 'require_mfa') {
    buffer.mfa = { actionId: parsed.actionId, hint: MFA_HINT };
    buffer.events.push({ type: 'mfa_required', actionId: parsed.actionId, hint: MFA_HINT });
    emitCard(buffer, mfaCard(parsed.actionId, MFA_HINT));
    return;
  }

  if (parsed !== null && parsed.decisionKind === 'require_confirmation') {
    const summary = await loadPendingSummary(parsed.actionId, toolName);
    buffer.confirmation = { actionId: parsed.actionId, action: summary };
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
 * Build the pi `AgentEvent` → `AgentStreamEvent` listener (mirrors `@/agent/run-turn.ts`). The body
 * is wrapped so a mapping bug becomes an `error` event rather than an unhandled rejection.
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
          buffer.text += delta;
          buffer.events.push({ type: 'text_delta', delta });
          return;
        }
        case 'message_end': {
          if (!isAssistantMessage(event.message)) return;
          const full = textOfContent(event.message.content);
          const assistant = buffer.current ?? newAssistantMessage(now());
          if (assistant.content === '' && full !== '') assistant.content = full;
          if (buffer.text === '') buffer.text = assistant.content;
          buffer.events.push({ type: 'message_end', message: assistant });
          return;
        }
        case 'tool_execution_start': {
          const view: ToolEventView = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: 'started',
          };
          upsertToolEvent(buffer, view);
          buffer.events.push({ type: 'tool_start', toolEvent: view });
          return;
        }
        case 'tool_execution_update': {
          const view: ToolEventView = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: 'updated',
          };
          upsertToolEvent(buffer, view);
          buffer.events.push({ type: 'tool_end', toolEvent: view });
          return;
        }
        case 'tool_execution_end': {
          await handleToolExecutionEnd(buffer, event);
          return;
        }
        case 'agent_end': {
          const failure = findRunFailure(event.messages);
          const message = failure?.errorMessage;
          if (message !== undefined && message !== '') {
            buffer.error = message;
            buffer.events.push({ type: 'error', message });
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

/** Assemble the public `ScenarioResult` from a completed turn buffer. */
function assemble(sessionId: string, buffer: TurnBuffer): ScenarioResult {
  const result: ScenarioResult = {
    sessionId,
    events: buffer.events,
    text: buffer.text,
    toolEvents: buffer.toolEvents,
    cards: buffer.cards,
  };
  if (buffer.confirmation !== undefined) result.confirmation = buffer.confirmation;
  if (buffer.mfa !== undefined) result.mfa = buffer.mfa;
  if (buffer.plan !== undefined) result.plan = buffer.plan;
  if (buffer.error !== undefined) result.error = buffer.error;
  return result;
}

/* -------------------------------------------------------------------------------- runTurn */

/** Send one user message and collect the resulting turn. */
export async function runTurn(input: RunTurnInput): Promise<ScenarioResult> {
  const { sessionId, message, agent } = input;
  const buffer = createTurnBuffer();
  buffer.events.push({ type: 'session', sessionId });

  const unsubscribe = agent.subscribe(createEventHandler(buffer, () => demoNow()));
  try {
    await agent.prompt(message);
  } finally {
    unsubscribe();
  }

  buffer.events.push({ type: 'done' });
  return assemble(sessionId, buffer);
}

/* ------------------------------------------------------------- human decisions (confirm/verify) */

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
 * than re-prompting) is what lets `agent.continue()` run to narrate the factual result.
 */
function buildToolResultMessage(
  messages: readonly AgentMessage[],
  toolResult: ToolExecutionResult,
  timestamp: number,
): ToolResultMessage {
  const lastCall = findLastToolCall(messages);
  const toolCallId = lastCall?.id ?? newId('tool');
  const toolName = lastCall?.name ?? 'unknown';
  const text =
    toolResult.summary ?? toolResult.error ?? (toolResult.ok ? '操作完成' : TOOL_FAILURE_FALLBACK);

  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    details: toolResult.data,
    isError: toolResult.ok !== true,
    timestamp,
  };
}

/** A factual narration for a tool result — used to seed a continuation when the script ran dry. */
function narrationFor(toolResult: ToolExecutionResult): string {
  if (toolResult.summary !== undefined && toolResult.summary !== '') return toolResult.summary;
  if (toolResult.error !== undefined && toolResult.error !== '') return toolResult.error;
  return toolResult.ok ? '操作已完成。' : TOOL_FAILURE_FALLBACK;
}

/**
 * Shared tail for `confirmAction`/`verifyAction`: authorize via the gateway, execute the ORIGINAL
 * validated args through the Banking SDK (NEVER the LLM), write the audit row, inject the REAL
 * result and drive the scripted agent to narrate the outcome.
 */
async function decideAndContinue(
  agent: Agent,
  actionId: string,
  mfaCode?: string,
): Promise<ScenarioResult> {
  const sessionId = agent.sessionId ?? 'sess';
  const auth =
    mfaCode === undefined
      ? await gateway.authorizeAction(actionId, { userId: DEMO_USER_ID, sessionId })
      : await gateway.authorizeAction(actionId, { userId: DEMO_USER_ID, sessionId, mfaCode });

  // A non-ok authorization (awaiting MFA / locked) is a domain outcome, not an error: return the
  // gateway's safe message and execute NOTHING.
  if (!auth.ok || auth.action === undefined) {
    return { sessionId, events: [], text: auth.message, toolEvents: [], cards: [] };
  }

  const action = auth.action;

  // Execute the args the gateway validated and persisted at gate time — straight through the
  // registry. Re-running `handleToolCall` would re-gate the call and mint a duplicate PendingAction.
  const registry = createToolRegistry(DEMO_USER_ID);
  const result = await registry.executeDirect(action.toolName, action.args);

  await recordAudit({
    timestamp: Date.now(),
    sessionId: action.sessionId,
    userRequest: '',
    toolName: action.toolName,
    riskLevel: auth.tier,
    confirmationRequired: true,
    confirmed: true,
    mfaRequired: auth.requiresMfa,
    mfaResult: auth.mfaResult,
    toolResult: result,
    status: result.ok ? 'success' : 'failed',
  });

  const toolResultMessage = buildToolResultMessage(agent.state.messages, result, Date.now());
  agent.state.messages = [...agent.state.messages, toolResultMessage];

  // One faux step is consumed per model call; if the script ran dry, seed a factual narration so
  // the continuation does not fail with "No more faux responses queued".
  const registration = fauxRegistrationOf(agent);
  if (registration !== undefined && registration.getPendingResponseCount() === 0) {
    registration.appendResponses([fauxAssistantMessage(narrationFor(result))]);
  }

  const buffer = createTurnBuffer();
  const unsubscribe = agent.subscribe(createEventHandler(buffer, () => demoNow()));
  try {
    await agent.continue();
  } finally {
    unsubscribe();
  }
  buffer.events.push({ type: 'done' });
  return assemble(sessionId, buffer);
}

/**
 * Confirm a pending YELLOW (or RED-after-MFA) action and drive the agent to narrate the
 * factual outcome. Returns the post-decision turn's collected result.
 */
export function confirmAction(agent: Agent, actionId: string): Promise<ScenarioResult> {
  return decideAndContinue(agent, actionId);
}

/** Submit an MFA code for a RED action and drive the agent to narrate the outcome. */
export function verifyAction(
  agent: Agent,
  actionId: string,
  code: string,
): Promise<ScenarioResult> {
  return decideAndContinue(agent, actionId, code);
}

/** Cancel a pending action; no execution occurs. */
export async function cancelAction(agent: Agent, actionId: string): Promise<ScenarioResult> {
  const sessionId = agent.sessionId ?? 'sess';

  // `cancelAction` throws `AppError('NOT_FOUND'|'CONFLICT')` for an unknown/settled action.
  const action = await gateway.cancelAction(actionId, { userId: DEMO_USER_ID, sessionId });

  await recordAudit({
    timestamp: Date.now(),
    sessionId: action.sessionId,
    userRequest: '',
    toolName: action.toolName,
    riskLevel: action.tier,
    confirmationRequired: true,
    confirmed: false,
    mfaRequired: action.requiresMfa,
    status: 'cancelled',
  });

  // Nothing ran, so there is no continuation to narrate and no event to stream.
  return { sessionId, events: [], text: '操作已取消。', toolEvents: [], cards: [] };
}

/* ---------------------------------------------------------------------------- utils */

/**
 * A unique session id per test — REQUIRED for circuit-breaker isolation (breaker state is
 * in-process keyed by sessionId; the lock from Test 10 must not leak into other specs).
 */
export function newSessionId(prefix = 'sess'): string {
  return newId(prefix);
}

/** Attach a listener that captures every `AgentStreamEvent` into an array (and detaches on return). */
export function collectEvents(agent: Agent): { events: AgentStreamEvent[]; detach: () => void } {
  const buffer = createTurnBuffer();
  const unsubscribe = agent.subscribe(createEventHandler(buffer, () => demoNow()));
  return { events: buffer.events, detach: () => unsubscribe() };
}

/** Filter helpers for readable assertions. */
export function toolEventsOf(res: ScenarioResult, toolName: string): ToolEventView[] {
  return res.toolEvents.filter((event) => event.toolName === toolName);
}

export function cardsOfType<T extends ChatCard['type']>(
  res: ScenarioResult,
  type: T,
): Extract<ChatCard, { type: T }>[] {
  return res.cards.filter((card): card is Extract<ChatCard, { type: T }> => card.type === type);
}

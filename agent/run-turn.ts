/**
 * run-turn.ts — one chat turn + the confirmation resume.
 * `runTurn`: resolve/create session, injection scan (security.injection), build runtime
 * (`createBankingAgent`), subscribe to pi AgentEvents and map them to AgentStreamEvents (mapping
 * table in ../CONTEXT.md), prompt the agent, persist the session, return the collected events.
 * `resumeTurn`: inject a REAL tool result and call `agent.continue()` so the model narrates only the
 * factual outcome. NO chain-of-thought is emitted — only task steps / tool status / results.
 */
/*
 * SECURITY BOUNDARY (root-owned invariant; restated here because this file drives the model).
 * The model's ONLY capabilities are the registered banking tools in `./tools` — exactly the names of
 * the frozen `ToolName` union (`@/lib/contracts/tools`) — plus the `submit_plan` meta-tool. There is
 * deliberately NO bash/shell/write/edit/file/SQL/system/http tool: the tool registry IS the complete
 * and exhaustive capability set, so an injection asking for such a tool has nothing to call.
 * `beforeToolCall` (installed in `./banking-agent.ts`) is the ONE code-enforced chokepoint: every
 * proposed call goes through `security.gateway.securityGateway.handleToolCall`, and permission is
 * decided by code — NEVER by the model. Resource limits: contextWindow 128000 / maxTokens 16384.
 * No chain-of-thought is ever streamed to the UI — only task steps, tool status and results.
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
import type { TaskNodeResult, TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import type { ToolName } from '@/lib/contracts/tools';
import type { AppConfig } from '@/lib/config';
import { getConfig } from '@/lib/config';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { safeParse, toJson } from '@/lib/json';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { security } from '@/security';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, JsonValue, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { createBankingAgent, type BankingAgentRuntime } from './banking-agent';
import { confirmationCard, errorCard, mfaCard, toCards } from './card-emitter';
import { redactRequest } from '@/lib/sensitive';
import type { FactInput } from './grounding-facts';
import { renderFinancialResponse, UNAVAILABLE_RESPONSE } from './financial-response';
import { parseBankingGuidance, filterMissingFields, providedRequestFields, type BankingGuidance, type GuidanceField } from './banking-guidance';
import { withActionPolicy } from '@/lib/action-summary';
import { listProducts } from '@/lib/db/repositories/investment';
import { invalidRequestedComparison, requestedComparison } from '@/lib/request-constraints';
import { invalidRequestedPurchase } from '@/lib/request-purchases';
import { withRealToolResult } from './message-normalize';
import type { ModelRuntime } from './providers/types';
import { getOrCreateSession, loadSession, saveSession } from './session';
import { readPendingActionId } from './task-control';
import type { ToolExecutionResult } from './tools';
import { canRecoverPlanning, unfinishedPlanning, transientModelFailure, recoveryNotice, startedMutation, PLANNING_RECOVERY_INSTRUCTION } from './live-recovery';

export interface RunTurnDeps {
  config?: AppConfig;
  now?: () => number;
  /**
   * TEST SEAM (additive, optional): inject a scripted `{ model, streamFn }` pair so `runTurn`/
   * `resumeTurn` can be driven deterministically by a faux provider, exactly as `createBankingAgent`
   * would resolve it from config. Absent ⇒ unchanged behavior (`resolveProvider(config)`).
   */
  provider?: ModelRuntime;
}
export interface ResumeTurnInput {
  sessionId: string;
  toolResult: ToolExecutionResult;
  toolCallId?: string;
  /** Server-owned action name; never attribute its result to another tool. */
  toolName?: ToolName;
  /** Actual bank tool for a DAG result injected into Pi's outer submit_plan call. */
  resultToolName?: ToolName;
  sourceAccountId?: string;
  /** The gated `PendingAction` this result belongs to (server-owned), when the caller knows it. */
  actionId?: string;
  /** The owning DAG plan / node when this result executed as a plan node, when the caller knows it. */
  taskId?: string;
  nodeId?: string;
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

function isAssistantMessage(message: unknown): message is AssistantMessage {
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
  return isRecord(result) ? textOfContent(Array.isArray(result.content) ? result.content.slice(0, 1) : result.content) : '';
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
  /**
   * Real tool results and execution identities, consumed by the server-owned response renderer.
   */
  factResults: FactInput[];
  sourceAccounts: Map<string, string>;
  requestText?: string;
  providedFields?: GuidanceField[];
  serverGuidance?: BankingGuidance;
  lastGuidance?: BankingGuidance;
  /**
   * SERVER-tracked ids of the messages already grounded this turn. The grounding module no longer
   * skips on a text marker, so idempotency MUST be keyed here — on the server-owned message id —
   * NEVER on a string the model can produce (a model that includes the correction tag in its own
   * text is STILL verified).
   */
  groundedIds: Set<string>;
}

function createTurnBuffer(requestText?: string): TurnBuffer {
  return { events: [], assistants: [], current: null, factResults: [], sourceAccounts: new Map(), requestText, groundedIds: new Set() };
}

/**
 * Render one UI message from real results only. Presentation errors fail closed without changing
 * the business operation's outcome. Message identity makes rendering idempotent; model text and
 * correction labels are never evidence. Cards keep their existing server-owned execution path.
 */
function groundMessage(buffer: TurnBuffer, message: ChatMessage | null, guidance?: BankingGuidance): void {
  if (message === null) return;
  if (buffer.groundedIds.has(message.id)) return;
  try {
    const pendingEvent = [...buffer.events].reverse().find(event => event.type === 'mfa_required' || event.type === 'confirmation_required');
    message.content = renderFinancialResponse(buffer.factResults, {
      requestText: buffer.requestText,
      guidance: buffer.serverGuidance ?? filterMissingFields(guidance, buffer.providedFields ?? []),
      locked: buffer.events.some(event => event.type === 'security_event' && event.kind === 'locked'),
      ...(pendingEvent?.type === 'mfa_required' ? { pending: 'mfa' as const }
        : pendingEvent?.type === 'confirmation_required' ? { pending: 'confirmation' as const } : {}),
    });
    buffer.groundedIds.add(message.id);
  } catch (error) {
    // Fail closed for presentation: the financial write may already have committed. Never send
    // raw model text or invent a failure/success when rendering the authoritative facts failed.
    message.content = UNAVAILABLE_RESPONSE;
    buffer.groundedIds.add(message.id);
    buffer.events.push({ type: 'error', message: safeToString(error) });
  }
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
  return withActionPolicy(safeParse<PendingActionSummary>(row.summaryJson, {
    ...fallback,
    toolName: row.toolName as ToolName,
    tier: row.riskLevel as RiskLevel,
    requiresMfa: row.requiresMfa,
  }), { actionId, tier: row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa });
}

/* ------------------------------------------------------- live `submit_plan` (DAG) progress */

/**
 * What the turn remembers about the LIVE `submit_plan` DAG it is running: the node currently parked
 * on a gated (YELLOW/RED) tool, if any, so the human-decision event can be emitted once the run has
 * settled (the gateway's `PendingAction` row is committed by then).
 */
interface PlanRelay {
  parkedActionId?: string;
  parkedToolName?: string;
}

/** Is this node status a PARKED (gated) state, i.e. awaiting a human decision? */
function isParkedPlanStatus(status: TaskNodeStatus | undefined): boolean {
  return status === 'waiting_confirmation' || status === 'waiting_verification';
}

/** The plan node parked on a gated tool (a node drains its `PendingAction` id through `output`). */
function parkedPlanNode(plan: TaskPlan): { node: TaskNodeResult; actionId: string } | undefined {
  for (const node of plan.results) {
    if (!isParkedPlanStatus(node.status)) continue;
    const actionId = readPendingActionId(node.output);
    if (actionId !== undefined) return { node, actionId };
  }
  return undefined;
}

/**
 * Relay ONE live `submit_plan` plan snapshot into the turn stream: a `plan_update` carrying the whole
 * `TaskPlan` (what the UI folds into its DAG timeline as node statuses change), plus remembering the
 * node currently parked on a gated tool so `emitParkedDecision` can raise the human decision.
 *
 * Invoked from inside `executor.runPlan`, so it must NEVER throw (a mapping bug would abort the
 * plan); like `createEventHandler`, a bug surfaces as an `error` event instead of escaping.
 */
function relayPlanSnapshot(buffer: TurnBuffer, relay: PlanRelay, plan: TaskPlan): void {
  try {
    buffer.events.push({ type: 'plan_update', plan });
    const parked = parkedPlanNode(plan);
    if (parked === undefined) {
      relay.parkedActionId = undefined;
      return;
    }
    relay.parkedActionId = parked.actionId;
    relay.parkedToolName = parked.node.tool ?? '';
  } catch (error) {
    buffer.events.push({ type: 'error', message: safeToString(error) });
  }
}

/**
 * Emit the human-decision event for the DAG node that parked during this turn: YELLOW ⇒
 * `confirmation_required` + a confirmation card, RED ⇒ `mfa_required` + an MFA card. The tier and
 * the MFA requirement are read from the PERSISTED `PendingAction` row (a plan node carries no risk
 * level) — i.e. from `security/`'s decision, never from a guess. Emitted AFTER the run settles so
 * the row is guaranteed committed; at most one decision event per parked node.
 */
async function emitParkedDecision(buffer: TurnBuffer, relay: PlanRelay): Promise<void> {
  const actionId = relay.parkedActionId;
  if (actionId === undefined) return;
  relay.parkedActionId = undefined;
  const summary = await loadPendingSummary(actionId, relay.parkedToolName ?? 'submit_plan');
  if (summary.tier === 'RED' || summary.requiresMfa) {
    buffer.events.push({ type: 'mfa_required', actionId, hint: MFA_HINT, action: summary });
    emitCard(buffer, mfaCard(actionId, MFA_HINT, summary));
    return;
  }
  buffer.events.push({ type: 'confirmation_required', action: summary, actionId });
  emitCard(buffer, confirmationCard(summary));
}

/**
 * Flush the parked-node decision (if any) without ever failing an otherwise-complete turn: a
 * `PendingAction` that cannot be read back is surfaced as an `error` event (never swallowed), the
 * turn's real events are preserved.
 */
async function flushParkedDecision(buffer: TurnBuffer, relay: PlanRelay): Promise<void> {
  try {
    await emitParkedDecision(buffer, relay);
  } catch (error) {
    buffer.events.push({ type: 'error', message: safeToString(error) });
  }
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
    buffer.factResults.push({ toolName, result: execResult, toolCallId, sourceAccountId: buffer.sourceAccounts.get(toolCallId) });
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
    buffer.factResults.push({ toolName, result: { ok: false, error: message }, toolCallId, sourceAccountId: buffer.sourceAccounts.get(toolCallId) });
    emitCard(buffer, errorCard(message));
    return;
  }

  // GATED — the gateway blocked the call and (for YELLOW/RED) persisted a PendingAction.
  const blockView: ToolEventView = { toolCallId, toolName, status: 'blocked' };
  upsertToolEvent(buffer.current, blockView);
  buffer.events.push({ type: 'tool_end', toolEvent: blockView });

  if (parsed !== null && parsed.decisionKind === 'require_mfa') {
    const summary = await loadPendingSummary(parsed.actionId, toolName);
    buffer.events.push({ type: 'mfa_required', actionId: parsed.actionId, hint: MFA_HINT, action: summary });
    emitCard(buffer, mfaCard(parsed.actionId, MFA_HINT, summary));
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
          // Neither free model prose nor reasoning is a UI result. Real results are rendered at
          // message_end; no raw delta is accumulated on the persisted ChatMessage either.
          return;
        }
        case 'message_end': {
          if (!isAssistantMessage(event.message)) return;
          const assistant = buffer.current ?? newAssistantMessage(now());
          buffer.lastGuidance = event.message.stopReason === 'stop'
            ? filterMissingFields(parseBankingGuidance(textOfContent(event.message.content)), buffer.providedFields ?? []) : undefined;
          // The provider chooses tools, but contributes no user-visible financial prose.
          if (event.message.content.some(part => part.type === 'toolCall')) {
            // Tool-selection messages are model planning, not execution evidence. Keep the tool
            // timeline/cards, but publish none of their free prose (including a false prelude).
            assistant.content = '';
            buffer.groundedIds.add(assistant.id);
          } else groundMessage(buffer, assistant, event.message.stopReason === 'stop'
            ? parseBankingGuidance(textOfContent(event.message.content)) : undefined);
          // Pi persists these same message objects as model history. Keep the model's subsequent
          // context consistent with what the user saw, while retaining tool calls and thinking
          // blocks required by the provider protocol. Invented prose must not survive a refresh.
          event.message.content = [
            ...event.message.content.filter(part => part.type !== 'text'),
            ...(assistant.content ? [{ type: 'text' as const, text: assistant.content }] : []),
          ];
          // Emit the message's FINAL (grounded) text as ONE aggregated `text_delta`, immediately
          // followed by the `message_end` carrying the SAME content. The UI accumulates deltas into
          // `streamingText` and replaces it with `message_end.content`, so their concatenation per
          // message is identical — and no pre-grounding financial fact is ever streamed.
          if (assistant.content !== '') {
            buffer.events.push({ type: 'text_delta', delta: assistant.content });
          }
          buffer.events.push({ type: 'message_end', message: assistant });
          return;
        }
        case 'tool_execution_start': {
          if (isRecord(event.args) && typeof event.args.sourceAccountId === 'string') buffer.sourceAccounts.set(event.toolCallId, event.args.sourceAccountId);
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

/** Discard only an unexecuted terminal reply, retaining prior queries and their protocol pairs. */
function discardTerminalReply(runtime: BankingAgentRuntime, buffer: TurnBuffer): void {
  const last = runtime.agent.state.messages.at(-1);
  if (isAssistantMessage(last) && (!last.content.some(part => part.type === 'toolCall') ||
      last.stopReason === 'error' || last.stopReason === 'aborted')) runtime.agent.state.messages.pop();
  const current = buffer.current;
  if (current && !current.cards?.length && !current.toolEvents?.length) {
    const start = buffer.events.findIndex(event => event.type === 'message_start' && event.message.id === current.id);
    if (start >= 0) buffer.events.splice(start);
    buffer.assistants = buffer.assistants.filter(message => message.id !== current.id);
    buffer.groundedIds.delete(current.id);
    buffer.current = null;
  }
}

/** A server-written narrative is conversation memory, never a new tool call or provider usage. */
function publishServerReply(runtime: BankingAgentRuntime, buffer: TurnBuffer, now: () => number, content: string, retryRequest?: string): void {
  const message = { ...newAssistantMessage(now()), content, ...(retryRequest ? { retryRequest } : {}) };
  buffer.current = message;
  buffer.assistants.push(message);
  buffer.groundedIds.add(message.id);
  buffer.events.push({ type: 'message_start', message: { ...message } }, { type: 'text_delta', delta: content }, { type: 'message_end', message });
  const model = runtime.agent.state.model;
  runtime.agent.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: content }],
    api: model.api, provider: model.provider, model: model.id, timestamp: message.timestamp, stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}

/** At most one recovery of planning, before any write attempt. Never re-prompt the original turn. */
async function runLivePrompt(runtime: BankingAgentRuntime, buffer: TurnBuffer, request: string, now: () => number): Promise<string | undefined> {
  let failure: string | undefined;
  let instruction: AgentMessage | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const messageStart = runtime.agent.state.messages.length;
      buffer.lastGuidance = undefined;
      failure = undefined;
      try {
        if (attempt === 0) await runtime.agent.prompt(request);
        else await runtime.agent.continue();
        const failed = findRunFailure(runtime.agent.state.messages.slice(messageStart));
        if (failed) failure = failed.errorMessage || '模型请求中断';
      } catch (error) { failure = safeToString(error); }
      const guidance = Boolean(buffer.serverGuidance ?? buffer.lastGuidance);
      if (attempt !== 0 || !canRecoverPlanning(request, buffer.events, buffer.factResults, guidance, failure)) break;
      discardTerminalReply(runtime, buffer);
      buffer.events = buffer.events.filter(event => event.type !== 'error');
      instruction = { role: 'system', content: PLANNING_RECOVERY_INSTRUCTION, timestamp: now() };
      runtime.agent.state.messages.push(instruction);
    }
  } finally {
    // The recovery instruction belongs to this attempt, not to subsequent user requests.
    if (instruction) runtime.agent.state.messages = runtime.agent.state.messages.filter(message => message !== instruction);
  }
  return failure;
}

/** Run one agent turn; returns the stream events emitted during it. */
export async function runTurn(
  req: ChatTurnRequest,
  deps?: RunTurnDeps,
): Promise<ChatTurnResponse> {
  req = { ...req, message: redactRequest(req.message) };
  const config = deps?.config ?? getConfig();
  const now = deps?.now ?? (() => demoNow());

  const snapshot = await getOrCreateSession(config.demoUserId, req.sessionId);
  const buffer = createTurnBuffer(req.message);
  // Validate product presence against the real catalogue. This read only calibrates questions;
  // it is not a tool result, a financial statement, an ownership check or an authorization.
  try {
    const products = /理财|申购|认购|购买|产品|基金/.test(req.message) || requestedComparison(req.message).length > 0 ? await listProducts() : [];
    buffer.providedFields = providedRequestFields(req.message, products);
    if (invalidRequestedComparison(req.message, products) ||
        (/理财|申购|认购|产品|基金/.test(req.message) && invalidRequestedPurchase(req.message, products))) {
      buffer.serverGuidance = { code: 'product_selection_invalid' };
    }
  } catch { buffer.providedFields = []; }
  buffer.events.push({ type: 'session', sessionId: snapshot.sessionId });

  // Injection scan is defense-in-depth ONLY — it records a SecurityEvent but NEVER grants
  // permission (the gateway remains the sole authority).
  const scan = security.injection.scan(req.message);
  if (scan.suspicious) {
    await security.injection.reportInjection(snapshot.sessionId, req.message, scan);
    buffer.events.push({ type: 'security_event', kind: 'injection', message: scan.note });
  }

  // LIVE DAG progress for a `submit_plan` turn: the sink fires from inside `executor.runPlan` on
  // every node change, so the UI sees the plan timeline update and the parked node's decision.
  const relay: PlanRelay = {};
  const runtime = createBankingAgent({
    sessionId: snapshot.sessionId,
    userId: config.demoUserId,
    snapshot,
    config,
    provider: deps?.provider,
    onPlanUpdate: (plan) => relayPlanSnapshot(buffer, relay, plan),
  });

  const unsubscribe = runtime.agent.subscribe(createEventHandler(buffer, now));
  let liveFailure: string | undefined;
  try {
    if (config.llmMode === 'live') liveFailure = await runLivePrompt(runtime, buffer, req.message, now);
    else await runtime.agent.prompt(req.message);
  } finally {
    // Flush AFTER the run settles (the parked `PendingAction` row is committed by then) and even
    // when the run failed — the user must still be able to take the parked decision.
    await flushParkedDecision(buffer, relay);
    unsubscribe();
    runtime.dispose();
  }

  const unfinished = config.llmMode === 'live' && unfinishedPlanning(req.message, buffer.events, buffer.factResults,
    Boolean(buffer.serverGuidance ?? buffer.lastGuidance));
  if (config.llmMode === 'live' && (liveFailure || unfinished)) {
    discardTerminalReply(runtime, buffer);
    const notice = recoveryNotice(buffer.events, liveFailure, req.message, buffer.factResults);
    // A provider outage does not establish a business failure. Keep all real outcomes/cards.
    const facts = buffer.factResults.length || startedMutation(buffer.events)
      ? renderFinancialResponse(buffer.factResults, { requestText: req.message,
          pending: buffer.events.some(event => event.type === 'mfa_required') ? 'mfa'
            : buffer.events.some(event => event.type === 'confirmation_required') ? 'confirmation' : undefined }) + '\n' : '';
    const retryable = canRecoverPlanning(req.message, buffer.events, buffer.factResults,
      Boolean(buffer.serverGuidance ?? buffer.lastGuidance), liveFailure);
    buffer.events = buffer.events.filter(event => event.type !== 'error');
    publishServerReply(runtime, buffer, now, facts + notice, retryable ? req.message : undefined);
    if (liveFailure) buffer.events.push({ type: 'error', message: notice });
  } else if (config.llmMode === 'live' && buffer.current?.content === '' &&
      (buffer.factResults.length || startedMutation(buffer.events))) {
    publishServerReply(runtime, buffer, now, renderFinancialResponse(buffer.factResults, {
      guidance: buffer.serverGuidance ?? buffer.lastGuidance,
      locked: buffer.events.some(event => event.type === 'security_event' && event.kind === 'locked'),
      pending: buffer.events.some(event => event.type === 'mfa_required') ? 'mfa'
        : buffer.events.some(event => event.type === 'confirmation_required') ? 'confirmation' : undefined,
    }));
  }

  const userMessage: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    content: req.message,
    timestamp: now(),
  };

  snapshot.agentState = runtime.serialize().agentState;
  // Safety net: re-ground the terminal narration before persisting (idempotent).
  groundMessage(buffer, buffer.current);
  snapshot.transcript.push(userMessage, ...buffer.assistants);
  await saveSession(snapshot);

  buffer.events.push({ type: 'done' });
  return { sessionId: snapshot.sessionId, events: buffer.events };
}

/* ------------------------------------------------------------------------------ resumeTurn */

/** The last tool call the model proposed (scanned backwards through the agent transcript). */
function findLastToolCall(messages: readonly AgentMessage[], toolName?: ToolName): ToolCall | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const part = message.content[j];
      if (part.type === 'toolCall' && (toolName === undefined || part.name === toolName)) return part;
    }
  }
  return null;
}

/** The model's tool call with the given id (scanned backwards), or `null` when none matches. */
function findToolCallById(messages: readonly AgentMessage[], id: string): ToolCall | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    for (const part of message.content) {
      if (part.type === 'toolCall' && part.id === id) return part;
    }
  }
  return null;
}

/**
 * Resolve WHICH tool call the REAL result belongs to: explicit id, else the latest call of the
 * server-owned action's tool. A crash can leave a parked action without its persisted call;
 * report narration failure in that case rather than overwriting another tool's factual result.
 * The legacy model-double path without an action name retains its model-only fallback.
 */
function resolveToolResultTarget(
  messages: readonly AgentMessage[],
  explicitId?: string,
  expectedName?: ToolName,
): { toolCallId: string; toolName: string } {
  const matched = explicitId !== undefined ? findToolCallById(messages, explicitId) : null;
  const call = matched ?? findLastToolCall(messages, expectedName);
  if (expectedName !== undefined && (
    call === null || call.name !== expectedName || (explicitId !== undefined && matched === null)
  )) {
    throw new AppError('CONFLICT', `无法定位 ${expectedName} 的原始工具调用，交易结果已保留，未修改其他工具结果。`);
  }
  return { toolCallId: explicitId ?? call?.id ?? '', toolName: call?.name ?? 'unknown' };
}

/**
 * Build the pi tool-result message carrying the REAL outcome of a gated tool. It is placed next to
 * its tool call (see `withRealToolResult`) so `agent.continue()` — which requires the last transcript
 * entry to be a user/tool-result message — can run and let the model narrate the factual result.
 */
function buildToolResultMessage(
  input: ResumeTurnInput,
  toolCallId: string,
  toolName: string,
  timestamp: number,
): ToolResultMessage {
  const text =
    input.toolResult.summary ??
    input.toolResult.error ??
    (input.toolResult.ok ? '操作完成' : TOOL_FAILURE_FALLBACK);

  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    details: input.toolResult.data === undefined ? undefined : JSON.parse(toJson(input.toolResult.data)) as JsonValue,
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

  // A continuation can drive a `submit_plan` DAG too (the model may plan while narrating), so the
  // same live-progress relay is installed here.
  const relay: PlanRelay = {};
  const runtime = createBankingAgent({
    sessionId: snapshot.sessionId,
    userId: snapshot.userId,
    snapshot,
    config,
    provider: deps?.provider,
    onPlanUpdate: (plan) => relayPlanSnapshot(buffer, relay, plan),
  });

  const unsubscribe = runtime.agent.subscribe(createEventHandler(buffer, now));
  try {
    // Attribute the REAL outcome to the ORIGINAL tool call and REPLACE the turn-time (blocked)
    // placeholder in place — never append a second result for the same id (which would sit after the
    // narration and trip the provider's "tool message must answer a preceding tool_calls" rule).
    const { toolCallId, toolName } = resolveToolResultTarget(
      runtime.agent.state.messages,
      input.toolCallId,
      input.toolName,
    );
    const toolResultMessage = buildToolResultMessage(input, toolCallId, toolName, now());
    runtime.agent.state.messages = withRealToolResult(
      runtime.agent.state.messages,
      toolResultMessage,
    );
    // Seed the authoritative facts with the injected REAL result so the continuation narration is
    // grounded against it (never against the model's own prose). The server-side OPERATION identity
    // (the resolved call id + the action / plan-node ids the caller supplied) is threaded through so
    // the claim is bound to THIS operation.
    buffer.factResults.push({
      toolName: input.resultToolName ?? input.toolName ?? '',
      result: input.toolResult,
      ...(input.sourceAccountId !== undefined ? { sourceAccountId: input.sourceAccountId } : {}),
      ...(toolCallId !== undefined && toolCallId !== '' ? { toolCallId } : {}),
      ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    });
    if (config.llmMode === 'live') {
      // Owning DAG continuation already ran in confirmation.ts. Financial prose is server-owned,
      // so another model request adds latency and can propose unrelated new writes.
      publishServerReply(runtime, buffer, now, renderFinancialResponse(buffer.factResults));
    } else await runtime.agent.continue();
  } catch (error) {
    // The gated business action ALREADY executed and is ALREADY audited (see `./confirmation`).
    // A continuation failure (model/narration error) must NEVER be swallowed — it is surfaced as an
    // `error` event — nor turned into a success: the caller still receives the REAL tool result.
    buffer.events.push({ type: 'error', message: safeToString(error) });
  } finally {
    // Flush AFTER the continuation settles (even when it failed): a DAG node parked by this turn
    // still needs its human decision surfaced.
    await flushParkedDecision(buffer, relay);
    unsubscribe();
    runtime.dispose();
  }

  snapshot.agentState = runtime.serialize().agentState;
  // Safety net: re-ground the terminal narration before persisting (idempotent).
  groundMessage(buffer, buffer.current);
  snapshot.transcript.push(...buffer.assistants);
  await saveSession(snapshot);

  buffer.events.push({ type: 'done' });
  return { sessionId: snapshot.sessionId, events: buffer.events };
}

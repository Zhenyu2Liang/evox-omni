'use client';

/**
 * `useAgentStream.ts` — the event→state fold of `AgentStreamEvent[]` → chat UI state.
 *
 * Two layers:
 *  - `reduceAgentEvents` / `initialChatUIState` — a PURE, DOM-free reducer over `ChatUIState`,
 *    unit-testable with scripted `AgentStreamEvent[]` fixtures (see `./CONTEXT.md` fold table).
 *  - `useAgentStream` — the stateful hook wrapping the reducer, owning `busy`/`pendingAction`
 *    transitions and driving the client fetch helpers in `./actions`.
 *
 * Rules: NEVER throws to the UI (failures fold into `error` + a synthetic `error` event); never
 * renders chain-of-thought; the browser never executes a banking op (confirm/verify/cancel/recover
 * POST to `./app` routes which re-validate + execute server-side).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentStreamEvent,
  ChatCard,
  ChatMessage,
  ChatTurnResponse,
  ToolEventView,
} from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolName } from '@/lib/contracts/tools';
import type { OutOfBandAttention, TaskControlAction } from './cards';
import type { ChatEndpoints, PendingActionRef } from './actions';
import {
  DEFAULT_ENDPOINTS,
  cancelAction,
  confirmAction,
  controlTask as controlTaskRequest,
  fetchPendingActions,
  fetchTaskPlan,
  recoverAction,
  sendChatTurn,
  verifyAction,
} from './actions';
// VALUE import from the DIRECT module path (NOT the `./cards` barrel) so this module's runtime graph
// does not pull in every card component; `decisionKey` is the shared decision-identity helper.
import { asTerminalStatus } from './cards/confirmationStatus';
import { decisionKey } from './decisionKey';
import { redactRequest } from '@/lib/sensitive';
import { withActionPolicy } from '@/lib/action-summary';

/**
 * The summary for an MFA prompt. The `mfa_required` event carries no tool name, so `toolName` is
 * the actual gated tool the stream reported as blocked (omitted when the stream carried none —
 * never invented).
 */
export interface MfaActionSummary extends Omit<PendingActionSummary, 'toolName'> {
  toolName?: ToolName;
}

/**
 * The ACTIVE human decision the UI must surface — set by a `confirmation_required` (YELLOW) or
 * `mfa_required` (RED) event. `kind` discriminates the two so `ChatWindow` renders exactly the right
 * card; the MFA `hint` is carried through (never the code). `actionId` is the server-side
 * `PendingAction` id that confirm/verify/cancel operate on.
 */
export type PendingHumanDecision =
  | { kind: 'confirmation'; summary: PendingActionSummary; actionId: string }
  | { kind: 'mfa'; summary: MfaActionSummary; actionId: string; hint?: string };

/**
 * A restored OUT-OF-BAND action (never a live decision): a `confirmed` row still being processed or
 * a recoverable result-less wedge, or a terminal `needs_reconciliation` that must be reconciled — it
 * carries no confirm/MFA path but is surfaced so the user sees the state and (where allowed) can
 * trigger recovery. `attention` distinguishes the three treatments.
 */
export interface PendingReconciliation {
  summary: PendingActionSummary;
  actionId: string;
  attention: OutOfBandAttention;
}

export interface UseAgentStreamResult {
  messages: ChatMessage[];
  toolEvents: ToolEventView[];
  activePlan?: TaskPlan;
  pendingAction?: PendingHumanDecision;
  /** Restored out-of-band actions (processing / recoverable / needs_reconciliation) — never re-invoked. */
  pendingReconciliations: PendingReconciliation[];
  streamingText: string;
  busy: boolean;
  /** True while the mount-time pending-actions read (`GET /api/actions`) is in flight. */
  restoring: boolean;
  /** Consecutive failed MFA attempts for the ACTIVE decision (reset when it settles/changes). */
  mfaAttempts: number;
  error?: string;
  applyEvents(events: AgentStreamEvent[]): void; // fold a batch (used by actions + SSE)
  send(text: string): Promise<void>; // POST /api/chat, fold response
  confirm(actionId: string): Promise<void>; // POST /api/actions/:id/confirm
  verify(actionId: string, code: string): Promise<void>; // POST .../verify
  cancel(actionId: string): Promise<void>; // POST .../cancel
  /** POST /api/actions/:id/recover — server-side recovery of a result-less out-of-band action. */
  recover(actionId: string): Promise<void>;
  /** POST /api/tasks/:id { action } — steer the running plan; folds the returned snapshot. */
  controlTask(action: TaskControlAction, planId?: string): Promise<void>;
}

export interface UseAgentStreamOptions {
  sessionId?: string;
  endpoints?: ChatEndpoints;
  initialMessages?: ChatMessage[];
  /**
   * Plan id to recover on mount (refresh recovery). When omitted, the last-seen plan id persisted
   * in `sessionStorage` is used instead.
   */
  taskId?: string;
}

/**
 * The full chat UI state. The reducer is a pure fold over this shape; `currentAssistantId` and
 * `lastBlockedToolName` are internal bookkeeping (not part of the public hook result).
 */
export interface ChatUIState {
  sessionId?: string;
  messages: ChatMessage[];
  toolEvents: ToolEventView[];
  activePlan?: TaskPlan;
  pendingAction?: PendingHumanDecision;
  pendingReconciliations: PendingReconciliation[];
  streamingText: string;
  busy: boolean;
  error?: string;
  /** Consecutive failed MFA attempts for the active decision (see `UseAgentStreamResult`). */
  mfaAttempts: number;
  currentAssistantId?: string;
  lastBlockedToolName?: ToolName;
}

/** A fresh `ChatUIState` (empty arrays, empty streamingText, busy false) merged with `overrides`. */
export function initialChatUIState(overrides: Partial<ChatUIState> = {}): ChatUIState {
  return {
    messages: [],
    toolEvents: [],
    pendingReconciliations: [],
    streamingText: '',
    busy: false,
    mfaAttempts: 0,
    ...overrides,
  };
}

/** Module-level counter for locally generated (optimistic/system) message ids. */
let localIdSeq = 0;
function nextLocalId(prefix: string): string {
  localIdSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${localIdSeq}`;
}

/** SAFE, single-line user-facing message from any throwable (never a raw stack). */
function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const firstLine = raw.split('\n')[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : '请求失败，请稍后重试';
}

// --- plan identity persistence (refresh recovery) ----------------------------------------------

/** `sessionStorage` key holding the id of the last-seen active plan. */
const ACTIVE_PLAN_STORAGE_KEY = 'banking-agent:activePlanId';

/** Persist the id of the currently-active plan (best-effort; storage can be unavailable). */
function rememberPlanId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(ACTIVE_PLAN_STORAGE_KEY, id);
  } catch {
    /* sessionStorage can throw when disabled/quota-exceeded — recovery is best-effort only. */
  }
}

/** The last-seen plan id, if one was persisted (`undefined` in a non-browser/blocked context). */
function readRememberedPlanId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const id = window.sessionStorage.getItem(ACTIVE_PLAN_STORAGE_KEY);
    return id !== null && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

// --- pure reducer helpers ---------------------------------------------------------------------

/** Replace the message with the same `id`, else append (immutable). */
function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  next = { ...next, cards: (next.cards ?? []).filter((card, index, cards) =>
    card.type !== 'plan' && cards.findIndex(other => JSON.stringify(other) === JSON.stringify(card)) === index) };
  const index = messages.findIndex((m) => m.id === next.id);
  if (index === -1) return [...messages, next];
  const copy = messages.slice();
  copy[index] = next;
  return copy;
}

/** Replace the tool event with the same `toolCallId`, else append (immutable). */
function upsertToolEvent(list: ToolEventView[], next: ToolEventView): ToolEventView[] {
  const index = list.findIndex((t) => t.toolCallId === next.toolCallId);
  if (index === -1) return [...list, next];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

/** Fold a tool event into the currently-streaming assistant message's `toolEvents`, if any. */
function attachToolEventToMessage(
  messages: ChatMessage[],
  messageId: string | undefined,
  event: ToolEventView,
): ChatMessage[] {
  if (!messageId) return messages;
  const index = messages.findIndex((m) => m.id === messageId);
  if (index === -1) return messages;
  const copy = messages.slice();
  copy[index] = { ...copy[index], toolEvents: upsertToolEvent(copy[index].toolEvents ?? [], event) };
  return copy;
}

/** The message a `card` event should attach to: the streaming one, else the last assistant. */
function cardTargetId(state: ChatUIState): string | undefined {
  if (state.currentAssistantId && state.messages.some((m) => m.id === state.currentAssistantId)) {
    return state.currentAssistantId;
  }
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'assistant') return state.messages[i].id;
  }
  return undefined;
}

/**
 * Upsert a plan snapshot into the single `activePlan` slot (the live plan view).
 *
 * Latest wins: a newer snapshot for the SAME plan id replaces the stored one, while an out-of-order
 * (older `updatedAt`) snapshot for the same id never regresses the view. A snapshot for a DIFFERENT
 * plan id replaces the slot (only one plan is live at a time).
 *
 * Generation fence (same plan id): the agent stamps a monotonic execution `generation` whenever the
 * plan's execution token is (re)claimed (initial claim or a stale-owner takeover). When BOTH the
 * incoming and the stored snapshot carry a generation, an OLDER incoming generation is REJECTED
 * outright — even if its `updatedAt` looks fresher — and an incoming generation that is EQUAL OR
 * NEWER is ACCEPTED even if its `updatedAt` is equal/older. When EITHER side is missing a generation
 * the plan has not supplied an execution generation, so timestamp ordering applies.
 */
function upsertPlan(state: ChatUIState, plan: TaskPlan, generation?: number): ChatUIState {
  const current = state.activePlan;
  if (current && current.id === plan.id) {
    if (current.status === 'cancelled' && plan.status !== 'cancelled') return state;
    const incomingGeneration = plan.generation ?? generation;
    const storedGeneration = current.generation;
    if (incomingGeneration !== undefined && storedGeneration !== undefined) {
      // A lower generation belongs to a superseded executor — never overwrite the newer state.
      if (incomingGeneration < storedGeneration) return state;
      // Same/newer generation: the event wins, even when `updatedAt` is equal or older.
      return { ...state, activePlan: plan };
    }
    if (current.updatedAt > plan.updatedAt) {
      return state;
    }
  }
  return { ...state, activePlan: plan };
}

/**
 * Fold a `card` event into the state.
 *
 * A `plan` card is NOT appended as an inline message card — it is PROMOTED into the single
 * `activePlan` slot (see `upsertPlan`). That is what keeps "at most ONE plan view per plan id": the
 * live plan rendered by `ChatWindow` is the only plan surface, so a following `plan_update` for the
 * same id can never leave a duplicate/stale plan card behind (and vice-versa). Every other card
 * still rides the normal message path (`CardRenderer`).
 */
function attachCard(state: ChatUIState, card: ChatCard): ChatUIState {
  if (card.type === 'plan') {
    return upsertPlan(state, card.plan);
  }

  const targetId = cardTargetId(state);
  if (targetId === undefined) {
    const message: ChatMessage = {
      id: nextLocalId('assistant'),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      cards: [card],
      toolEvents: [],
    };
    return { ...state, messages: [...state.messages, message] };
  }
  const messages = state.messages.map((m) =>
    m.id === targetId && !(m.cards ?? []).some(existing => JSON.stringify(existing) === JSON.stringify(card))
      ? { ...m, cards: [...(m.cards ?? []), card] } : m,
  );
  return { ...state, messages };
}

/** The actual gated tool the stream reported as blocked (the RED tool the gateway refused). */
function blockedToolName(state: ChatUIState): ToolName | undefined {
  for (let i = state.toolEvents.length - 1; i >= 0; i -= 1) {
    const event = state.toolEvents[i];
    if (event.status === 'blocked') return event.toolName as ToolName;
  }
  return state.lastBlockedToolName;
}

/** Build the summary for an MFA prompt (the payload carries no tool name → the streamed blocked tool). */
function mfaSummary(state: ChatUIState, hint: string | undefined): MfaActionSummary {
  const toolName =
    blockedToolName(state) ??
    (state.toolEvents[state.toolEvents.length - 1]?.toolName as ToolName | undefined);
  const summary: MfaActionSummary = {
    title: '需要安全验证',
    ...(toolName !== undefined ? { toolName } : {}),
    tier: 'RED',
    fields: [],
    requiresMfa: true,
  };
  if (hint !== undefined) summary.mfaHint = hint;
  return summary;
}

/**
 * A settled-action signal emitted by `./actions#postAction` when a server action route reports a
 * TERMINAL status. ADDITIVE — the frozen `AgentStreamEvent` union is unchanged — so it is read
 * structurally; a server that never emits it falls back to the previous behaviour.
 */
interface ActionSettledEvent {
  type: 'action_settled';
  actionId: string;
  status: string;
  message?: string;
}

function asActionSettledEvent(event: AgentStreamEvent): ActionSettledEvent | undefined {
  const record = event as unknown as { type?: unknown; actionId?: unknown; status?: unknown; message?: unknown };
  if (record.type !== 'action_settled') return undefined;
  if (typeof record.actionId !== 'string' || typeof record.status !== 'string') return undefined;
  return {
    type: 'action_settled',
    actionId: record.actionId,
    status: record.status,
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
  };
}

/**
 * Fold a settled-action signal: stamp the server-reported status (+ optional reason) onto the
 * matching inline `confirmation` card(s) so a settled card shows a terminal badge instead of inert
 * buttons, and — for a TERMINAL status — clear the live decision when it is the SAME action.
 */
function settleAction(state: ChatUIState, event: ActionSettledEvent): ChatUIState {
  const pending = state.pendingAction;
  const matchesPending = pending !== undefined && pending.actionId === event.actionId;
  const key = matchesPending && pending ? decisionKey(pending.summary) : undefined;

  let changed = false;
  const messages = state.messages.map((message) => {
    const cards = message.cards;
    if (!cards || cards.length === 0) return message;
    let cardChanged = false;
    const nextCards = cards.map((card) => {
      if (card.type === 'mfa' && card.actionId === event.actionId) {
        cardChanged = true;
        return { ...card, status: event.status, message: event.message };
      }
      if (card.type !== 'confirmation') return card;
      const stamped = (card.action as unknown as { actionId?: unknown }).actionId;
      const sameAction = stamped === event.actionId;
      const sameSummary = key !== undefined && decisionKey(card.action) === key;
      if (!sameAction && !sameSummary) return card;
      cardChanged = true;
      const nextAction = {
        ...card.action,
        ...(event.message !== undefined ? { message: event.message } : {}),
        status: event.status,
      } as PendingActionSummary;
      return { ...card, action: nextAction };
    });
    if (!cardChanged) return message;
    changed = true;
    return { ...message, cards: nextCards };
  });

  const withCards = changed ? { ...state, messages } : state;
  if (matchesPending && asTerminalStatus(event.status) !== undefined) {
    return { ...withCards, pendingAction: undefined };
  }
  return withCards;
}

/** Fold ONE event into the state (immutable — returns a new state object). */
function applyEvent(state: ChatUIState, event: AgentStreamEvent): ChatUIState {
  const settled = asActionSettledEvent(event);
  if (settled) return settleAction(state, settled);

  switch (event.type) {
    case 'session':
      return { ...state, sessionId: event.sessionId };

    case 'message_start':
      return {
        ...state,
        messages: upsertMessage(state.messages, { ...event.message, cards: [] }),
        currentAssistantId: event.message.id,
      };

    case 'text_delta':
      return { ...state, streamingText: state.streamingText + event.delta };

    case 'message_end': {
      for (const card of event.message.cards ?? []) if (card.type === 'plan') state = upsertPlan(state, card.plan);
      return {
        ...state,
        messages: upsertMessage(state.messages, event.message),
        streamingText: '',
        currentAssistantId: undefined,
      };
    }

    case 'tool_start':
    case 'tool_end': {
      const toolEvents = upsertToolEvent(state.toolEvents, event.toolEvent);
      const messages = attachToolEventToMessage(
        state.messages,
        state.currentAssistantId,
        event.toolEvent,
      );
      return {
        ...state,
        toolEvents,
        messages,
        ...(event.toolEvent.status === 'blocked'
          ? { lastBlockedToolName: event.toolEvent.toolName as ToolName }
          : {}),
      };
    }

    case 'card':
      return attachCard(state, event.card);

    case 'plan_update':
      return upsertPlan(state, event.plan, event.generation);

    case 'confirmation_required':
      return {
        ...state,
        pendingAction: {
          kind: 'confirmation',
          summary: event.action,
          actionId: event.actionId,
        },
      };

    case 'mfa_required': {
      const inline = state.messages.flatMap(message => message.cards ?? []).find(card =>
        (card.type === 'confirmation' && card.action.actionId === event.actionId) ||
        (card.type === 'mfa' && card.actionId === event.actionId));
      const source = event.action ?? (state.pendingAction?.actionId === event.actionId
        ? state.pendingAction.summary : inline?.type === 'confirmation' ? inline.action
          : inline?.type === 'mfa' ? inline.action : undefined);
      const summary = source
        ? withActionPolicy(source as PendingActionSummary, { actionId: event.actionId, tier: 'RED', requiresMfa: true })
        : mfaSummary(state, event.hint);
      // Replace this action's old decision, preserving every other action and terminal card.
      const messages = state.messages.map(message => ({ ...message, cards: message.cards?.map(card => {
        if (card.type === 'confirmation' && card.action.actionId === event.actionId &&
            asTerminalStatus((card.action as PendingActionSummary & { status?: string }).status) === undefined) {
          return { type: 'mfa' as const, actionId: event.actionId, action: summary as PendingActionSummary, hint: event.hint };
        }
        if (card.type === 'mfa' && card.actionId === event.actionId && asTerminalStatus(card.status) === undefined) {
          return { ...card, action: summary as PendingActionSummary, hint: event.hint };
        }
        return card;
      }) }));
      return {
        ...state,
        messages,
        pendingAction: {
          kind: 'mfa',
          summary,
          actionId: event.actionId,
          ...(event.hint !== undefined ? { hint: event.hint } : {}),
        },
      };
    }

    case 'security_event':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: nextLocalId('system'),
            role: 'system',
            content: event.message,
            timestamp: Date.now(),
          },
        ],
      };

    case 'error':
      return { ...state, error: event.message };

    case 'done':
      return { ...state, busy: false };

    default:
      return state;
  }
}

/**
 * PURE fold of a batch of `AgentStreamEvent`s over a `ChatUIState`.
 * Non-mutating: the input state and events are never changed.
 */
export function reduceAgentEvents(state: ChatUIState, events: AgentStreamEvent[]): ChatUIState {
  return events.reduce(applyEvent, state);
}

// --- refresh restore (pending actions) ---------------------------------------------------------

/**
 * Build the MFA prompt summary for a RESTORED decision — mirrors the `mfa_required` case: the tier
 * is forced RED and `requiresMfa` true (a restored MFA decision always is one), with the row's
 * summary used as the base when it looks like a `PendingActionSummary` (title/toolName/fields/hint
 * carried through). Falls back to the minimal prompt shape otherwise.
 */
function restoredMfaSummary(summary?: PendingActionSummary): MfaActionSummary {
  if (!summary || typeof summary.title !== 'string') {
    return { title: '需要安全验证', tier: 'RED', fields: [], requiresMfa: true };
  }
  const result: MfaActionSummary = {
    title: summary.title,
    ...(summary.toolName ? { toolName: summary.toolName } : {}),
    tier: 'RED',
    fields: withActionPolicy(summary, { tier: 'RED', requiresMfa: true }).fields,
    requiresMfa: true,
  };
  if (summary.mfaHint !== undefined) result.mfaHint = summary.mfaHint;
  if (typeof summary.amount === 'string') result.amount = summary.amount;
  return result;
}

/**
 * Pick the MOST RELEVANT non-terminal action to restore: an MFA/RED row (which needs the strongest
 * user attention) wins over a plain YELLOW confirmation; among several, the first such row is used.
 * Returns `undefined` when there is nothing actionable to restore.
 */
function pickPendingAction(refs: PendingActionRef[]): PendingHumanDecision | undefined {
  // ONLY actionable rows may become a live confirmation/MFA decision — an out-of-band row
  // (`confirmed` / `needs_reconciliation`) is not a live decision and must NEVER be mistaken for one.
  const actionable = refs.filter(
    (ref) => ref.status === 'pending' || ref.status === 'awaiting_mfa',
  );
  if (actionable.length === 0) return undefined;
  const chosen =
    actionable.find(
      (ref) => ref.requiresMfa || ref.status === 'awaiting_mfa' || ref.tier === 'RED',
    ) ?? actionable[0];
  if (chosen.requiresMfa || chosen.status === 'awaiting_mfa' || chosen.tier === 'RED') {
    return { kind: 'mfa', summary: restoredMfaSummary(chosen.summary), actionId: chosen.id };
  }
  return { kind: 'confirmation', summary: chosen.summary, actionId: chosen.id };
}

/**
 * Every OUT-OF-BAND row (attention `processing` / `recoverable` / `reconciliation`), mapped to a
 * display-only `PendingReconciliation`. These rows have NO live decision path (no confirm/MFA) —
 * they exist so the user sees an in-flight action, can trigger recovery for a recoverable wedge, and
 * is told when a gated operation must be reconciled out-of-band.
 */
function pickAttention(refs: PendingActionRef[]): PendingReconciliation[] {
  const out: PendingReconciliation[] = [];
  for (const ref of refs) {
    if (ref.attention === 'decision') continue;
    out.push({ summary: ref.summary, actionId: ref.id, attention: ref.attention });
  }
  return out;
}

// --- stateful hook ----------------------------------------------------------------------------

export function useAgentStream(o?: UseAgentStreamOptions): UseAgentStreamResult {
  const endpoints = o?.endpoints ?? DEFAULT_ENDPOINTS;
  const taskId = o?.taskId;
  const [state, setState] = useState<ChatUIState>(() =>
    initialChatUIState({
      ...(o?.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
      messages: o?.initialMessages ?? [],
    }),
  );

  // Keep the newest endpoints reachable from the one-shot recovery effect without re-running it on
  // every render when a caller passes an inline `endpoints` object.
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;

  // Remember the active plan id so a page reload can recover the live plan.
  const activePlanId = state.activePlan?.id;
  useEffect(() => {
    if (activePlanId !== undefined) rememberPlanId(activePlanId);
  }, [activePlanId]);

  // Refresh recovery: rebuild the live plan from the server (explicit `taskId`, else the remembered
  // id). A stale/unmounted/aborted or failed fetch is ignored — it NEVER throws to the UI and never
  // clobbers a plan a live `plan_update` already delivered.
  useEffect(() => {
    const planId = taskId ?? readRememberedPlanId();
    if (planId === undefined) return;
    let alive = true;
    void (async () => {
      const plan = await fetchTaskPlan(planId, endpointsRef.current);
      if (!alive || plan === undefined) return;
      setState((prev) => (prev.activePlan ? prev : { ...prev, activePlan: plan }));
    })();
    return () => {
      alive = false;
    };
  }, [taskId]);

  // ACTIVE refresh restore: on mount, rebuild the pending human decision from the server so a
  // reloaded page still shows the confirm/MFA card for an in-flight action. Best-effort: a
  // stale/unmounted/aborted or failed read is ignored and NEVER clobbers a decision a live event
  // already delivered (checked via a functional `setState`). `restoring` tracks the read in flight.
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    // ALWAYS run the one-shot best-effort read on mount: a live decision must never be clobbered
    // (guarded in the functional `setState` below), and an out-of-band row — which carries no live
    // decision of its own — must still be surfaced for manual reconciliation / recovery.
    let alive = true;
    setRestoring(true);
    void (async () => {
      const refs = await fetchPendingActions(endpointsRef.current);
      if (!alive) return;
      const decision = pickPendingAction(refs);
      const reconciliations = pickAttention(refs);
      setState((prev) => {
        const next = { ...prev };
        // Never clobber a decision a live event already delivered.
        if (next.pendingAction === undefined && decision !== undefined) {
          next.pendingAction = decision;
        }
        // Seed the out-of-band list only when nothing has populated it yet.
        if (next.pendingReconciliations.length === 0 && reconciliations.length > 0) {
          next.pendingReconciliations = reconciliations;
        }
        return next;
      });
      setRestoring(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Reset the MFA attempt counter whenever the active decision clears or changes (a success, a
  // cancel, or a NEW action). A failed verify keeps the SAME actionId/kind, so the count survives.
  const pendingActionKey = state.pendingAction?.actionId;
  const pendingActionKind = state.pendingAction?.kind;
  useEffect(() => {
    setState((prev) => (prev.mfaAttempts === 0 ? prev : { ...prev, mfaAttempts: 0 }));
  }, [pendingActionKey, pendingActionKind]);

  /** Fold a batch of events into the UI state. */
  const applyEvents = useCallback((events: AgentStreamEvent[]) => {
    setState((prev) => reduceAgentEvents(prev, events));
  }, []);
  const sendingRef = useRef(false);

  /**
   * Shared "run one turn" path: flip `busy`, run `load()`, fold the returned events and settle
   * `pendingAction` (kept only if the turn reported an `error`). Never throws to the UI.
   */
  const pull = useCallback(async (load: (onEvent: (event: AgentStreamEvent) => void) => Promise<ChatTurnResponse>, settlesDecision = true, actionId?: string) => {
    setState((prev) => ({ ...prev, busy: true, error: undefined }));
    const delivered = new Set<AgentStreamEvent>();
    const onEvent = (event: AgentStreamEvent) => {
      delivered.add(event);
      setState(previous => reduceAgentEvents(previous, [event]));
    };
    try {
      const res = await load(onEvent);
      const events = res.events ?? [];
      setState((prev) => {
        // Seed the (server-confirmed) sessionId, then let a `session` event take precedence.
        const base = res.sessionId ? { ...prev, sessionId: res.sessionId } : prev;
        // Fold FIRST so a settlement signal (`action_settled`) still sees the decision it belongs to,
        // then apply the generic settle rule: a non-error turn clears the decision it acted on.
        const reduced = reduceAgentEvents(base, events.filter(event => !delivered.has(event)));
        const hasError = events.some((e) => e.type === 'error');
        // NEVER clear a decision the SAME turn just established: a `confirmation_required` /
        // `mfa_required` (a fresh YELLOW/RED gate, or a YELLOW→RED escalation whose response carries
        // no `error`) must survive so its card stays actionable. Folding before the clear without this
        // guard would wipe it, which is why the guard is required, not optional.
        const establishesDecision = events.some(
          (e) => e.type === 'confirmation_required' || e.type === 'mfa_required',
        );
        const clearPending = settlesDecision && !hasError && !establishesDecision &&
          (actionId === undefined || reduced.pendingAction?.actionId === actionId);
        return { ...reduced, ...(clearPending ? { pendingAction: undefined } : {}), busy: false };
      });
    } catch (e) {
      const message = errorMessage(e);
      setState((prev) => ({
        ...reduceAgentEvents(prev, [{ type: 'error', message }]),
        busy: false,
      }));
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      try {
      text = redactRequest(text);
      const userMessage: ChatMessage = {
        id: nextLocalId('user'),
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      setState((prev) => ({ ...prev, messages: [...prev.messages, userMessage], error: undefined }));
      const sessionId = state.sessionId;
      await pull(onEvent =>
        sendChatTurn(
          sessionId !== undefined ? { sessionId, message: text } : { message: text },
          endpoints,
          onEvent,
        ),
        false,
      );
      } finally { sendingRef.current = false; }
    },
    [state.sessionId, endpoints, pull],
  );

  const confirm = useCallback(
    (actionId: string) => pull(() => confirmAction(actionId, endpoints), true, actionId),
    [pull, endpoints],
  );
  const verify = useCallback(
    async (actionId: string, code: string) => {
      await pull(() => verifyAction(actionId, code, endpoints), true, actionId);
      // A WRONG code keeps the SAME `mfa` decision active and sets `error` — count the attempt so the
      // MFA card can show "第 N 次尝试". A success/cancel clears `pendingAction` (and the reset effect
      // zeroes the counter); a new action changes actionId/kind, which also resets it.
      setState((prev) =>
        prev.pendingAction?.kind === 'mfa' && prev.error !== undefined
          ? { ...prev, mfaAttempts: prev.mfaAttempts + 1 }
          : prev,
      );
    },
    [pull, endpoints],
  );
  const cancel = useCallback(
    (actionId: string) => pull(() => cancelAction(actionId, endpoints), true, actionId),
    [pull, endpoints],
  );

  /**
   * Trigger the RECOVERY entry for an out-of-band action (`POST /api/actions/:id/recover`). The
   * server re-checks ownership and settles the action through the gateway's authorized path — the
   * browser never replays a banking op itself. Folds the returned events like any other action; on
   * SUCCESS the card is dropped from the out-of-band list (a FAILED recovery keeps it so the user can
   * retry). Best-effort: a failure surfaces a SAFE `error` and never throws to the UI.
   */
  const recover = useCallback(
    async (actionId: string) => {
      await pull(() => recoverAction(actionId, endpoints), true, actionId);
      setState((prev) =>
        prev.error !== undefined
          ? prev
          : {
              ...prev,
              pendingReconciliations: prev.pendingReconciliations.filter(
                (r) => r.actionId !== actionId,
              ),
            },
      );
    },
    [pull, endpoints],
  );

  /**
   * Steer the running plan (`pause`/`resume`/`cancel`/`retry`) via `POST /api/tasks/:id`. Defaults
   * `planId` to the live plan. Folds the returned snapshot into the SAME `activePlan` slot (reusing
   * the `plan_update` latest-wins upsert). Best-effort: a failed control surfaces a SAFE `error` and
   * NEVER throws to the UI.
   */
  const controlTask = useCallback(
    async (action: TaskControlAction, planId?: string) => {
      const id = planId ?? state.activePlan?.id;
      if (id === undefined) {
        setState((prev) => ({ ...prev, error: '当前没有可控制的任务计划' }));
        return;
      }
      setState((prev) => ({ ...prev, busy: true, error: undefined }));
      const plan = await controlTaskRequest(id, action, endpoints);
      if (plan === undefined) {
        setState((prev) => ({ ...prev, busy: false, error: errorMessage(undefined) }));
        return;
      }
      const refs = await fetchPendingActions(endpoints);
      setState((prev) => {
        let next = upsertPlan(prev, plan);
        if (plan.status === 'cancelled' && next.pendingAction && !refs.some(ref => ref.id === next.pendingAction!.actionId)) {
          next = settleAction(next, { type: 'action_settled', actionId: next.pendingAction.actionId, status: 'cancelled' });
        }
        return { ...next, pendingAction: pickPendingAction(refs), pendingReconciliations: pickAttention(refs), busy: false };
      });
    },
    [state.activePlan?.id, endpoints],
  );

  return {
    messages: state.messages,
    toolEvents: state.toolEvents,
    activePlan: state.activePlan,
    pendingAction: state.pendingAction,
    pendingReconciliations: state.pendingReconciliations,
    streamingText: state.streamingText,
    busy: state.busy,
    restoring,
    mfaAttempts: state.mfaAttempts,
    error: state.error,
    applyEvents,
    send,
    confirm,
    verify,
    cancel,
    recover,
    controlTask,
  };
}

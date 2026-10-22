/**
 * `agent-stream-reducer.ts` — the PURE event→state fold of `AgentStreamEvent[]` → `ChatUIState`.
 *
 * Extracted from `./useAgentStream` so the stateful hook stays a thin wrapper: everything here is
 * DOM-free, side-effect free and unit-testable with scripted `AgentStreamEvent[]` fixtures. The hook
 * re-exports every symbol so existing importers keep working.
 *
 * Rendering rule: a security refusal is folded from its TYPED fields through `@/lib/public-text` —
 * the raw refusal text (which may carry `__SECURITY_BLOCK__…`) is never read, never copied onto a
 * message and never attached to a tool row.
 */
import type { AgentStreamEvent, ChatCard, ChatMessage, ToolEventView } from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolName } from '@/lib/contracts/tools';
import type { ChatHistoryPage } from '@/lib/contracts/chat-history';
import type { ErrorCode } from '@/lib/errors';
import type { OutOfBandAttention } from './cards';
import type { PendingActionRef } from './actions';
import { asTerminalStatus, type TerminalActionStatus } from './cards/confirmationStatus';
import { decisionKey } from './decisionKey';
import { withActionPolicy } from '@/lib/action-summary';
import { historyPlan, placePlanInHistory } from '@/lib/chat-plan-history';
import { cardFingerprint } from '@/lib/chat-cards';
import { acceptsHistoryPage, type ChatHistoryState } from './history';
import { createTranslator, DEFAULT_LOCALE, type Translator } from '@/lib/i18n/shared';
import { securityNotice } from '@/lib/public-text';

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
  | { kind: 'confirmation'; summary: PendingActionSummary; actionId: string; status?: string; statusMessage?: string }
  | { kind: 'mfa'; summary: MfaActionSummary; actionId: string; hint?: string; status?: string; statusMessage?: string };

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
  replyPhase?: 'generating' | 'checking' | 'repairing';
  busy: boolean;
  error?: string;
  errorCode?: ErrorCode;
  /** Consecutive failed MFA attempts for the active decision. */
  mfaAttempts: number;
  currentAssistantId?: string;
  lastBlockedToolName?: ToolName;
  history?: ChatHistoryState;
  /** Resolved permission identities prevent stale requests from reopening during execution. */
  settledActions?: Record<string, TerminalActionStatus | 'confirmed'>;
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
export function nextLocalId(prefix: string): string {
  localIdSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${localIdSeq}`;
}

// --- pure reducer helpers ---------------------------------------------------------------------

/** Replace the message with the same `id`, else append (immutable). */
function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  next = { ...next, cards: (next.cards ?? []).filter((card, index, cards) =>
    card.type !== 'plan' && cards.findIndex(other => cardFingerprint(other) === cardFingerprint(card)) === index) };
  const index = messages.findIndex((m) => m.id === next.id);
  if (index === -1) return [...messages, next];
  const previousCards = messages[index].cards ?? [];
  // Provider completion snapshots do not carry client-folded plan updates. Preserve the plan's
  // original owner when that message is published again after a tool or authorization result.
  next = { ...next, cards: [...(next.cards ?? []), ...previousCards.filter(card => card.type === 'plan')] };
  if (next.role === 'tool') {
    const incomingCards = next.cards ?? [];
    const actionIdentity = (card: ChatCard) => card.type === 'mfa' ? card.actionId
      : card.type === 'confirmation' ? card.action.actionId : undefined;
    next = { ...next, cards: [...incomingCards, ...previousCards.filter(previous => previous.type !== 'plan' &&
      !incomingCards.some(incoming => incoming.type === previous.type ||
        actionIdentity(previous) !== undefined && actionIdentity(previous) === actionIdentity(incoming)))] };
  }
  next = { ...next, cards: next.cards?.map(card => {
    if (card.type === 'confirmation' && card.action.actionId) {
      const previous = previousCards.find(candidate => candidate.type === 'confirmation' && candidate.action.actionId === card.action.actionId);
      if (previous?.type === 'confirmation' &&
          asTerminalStatus((previous.action as PendingActionSummary & { status?: string }).status) !== undefined &&
          asTerminalStatus((card.action as PendingActionSummary & { status?: string }).status) === undefined) return previous;
    }
    if (card.type === 'mfa') {
      const previous = previousCards.find(candidate => candidate.type === 'mfa' && candidate.actionId === card.actionId);
      if (previous?.type === 'mfa' && asTerminalStatus(previous.status) !== undefined && asTerminalStatus(card.status) === undefined) return previous;
    }
    return card;
  }) };
  const copy = messages.slice();
  copy[index] = next;
  return copy;
}

/** Replace the tool event with the same `toolCallId`, else append (immutable). */
function upsertToolEvent(list: ToolEventView[], next: ToolEventView): ToolEventView[] {
  const index = list.findIndex((t) => t.toolCallId === next.toolCallId && t.messageId === next.messageId);
  if (index === -1) return [...list, next];
  const previous = list[index];
  if (['success', 'error', 'cancelled', 'needs_reconciliation'].includes(previous.status) &&
      ['started', 'updated', 'blocked'].includes(next.status)) return list;
  if (previous.status === 'blocked' && ['started', 'updated'].includes(next.status)) return list;
  const copy = list.slice();
  copy[index] = { ...previous, ...next };
  return copy;
}

/** Update only the explicitly identified tool row, never a nearby prose message. */
function attachToolEventToMessage(
  messages: ChatMessage[],
  event: ToolEventView,
): ChatMessage[] {
  const index = messages.findIndex(message => message.role === 'tool' && message.id === event.messageId &&
    message.toolEvents?.some(tool => tool.toolCallId === event.toolCallId &&
      (tool.actionId === undefined || event.actionId === undefined || tool.actionId === event.actionId)));
  if (index === -1) return messages;
  const copy = messages.slice();
  copy[index] = { ...copy[index], toolEvents: upsertToolEvent(copy[index].toolEvents ?? [], event) };
  return copy;
}

/** Begin a request with an empty live activity panel while preserving historical call outcomes. */
export function beginAgentRequest(state: ChatUIState): ChatUIState {
  return { ...state, busy: true, error: undefined, errorCode: undefined, toolEvents: [], streamingText: '', replyPhase: undefined,
    currentAssistantId: undefined, lastBlockedToolName: undefined };
}

/**
 * Update the plan's original historical card and the latest plan used for task controls.
 *
 * Compare each snapshot with its own historical plan, including updates to older plans while a
 * newer plan is active. Such an update cannot steal the newest plan's control identity.
 *
 * Generation fence (same plan id): the agent stamps a monotonic execution `generation` whenever the
 * plan's execution token is (re)claimed (initial claim or a stale-owner takeover). When BOTH the
 * incoming and the stored snapshot carry a generation, an OLDER incoming generation is REJECTED
 * outright — even if its `updatedAt` looks fresher. A NEWER generation takes precedence over clock
 * ordering; within the SAME generation, an older `updatedAt` is rejected. Equal timestamps retain
 * arrival order so multiple legitimate transitions in one clock tick can advance. When EITHER
 * side has no generation, timestamp ordering applies.
 */
export function upsertPlan(state: ChatUIState, plan: TaskPlan, generation?: number, messageOwnerId?: string): ChatUIState {
  const current = historyPlan(state.messages, plan.id) ?? (state.activePlan?.id === plan.id ? state.activePlan : undefined);
  const incomingGeneration = plan.generation ?? generation;
  const incoming = incomingGeneration === undefined ? plan : { ...plan, generation: incomingGeneration };
  if (current) {
    if (current.status === 'cancelled' && plan.status !== 'cancelled') return state;
    if (current.status === 'success' && plan.status !== 'success' && plan.status !== 'cancelled') return state;
    const storedGeneration = current.generation;
    if (incomingGeneration !== undefined && storedGeneration !== undefined) {
      // A lower generation belongs to a superseded executor — never overwrite the newer state.
      if (incomingGeneration < storedGeneration) return state;
      if (incomingGeneration === storedGeneration && plan.updatedAt < current.updatedAt) return state;
    } else if (current.updatedAt > plan.updatedAt) {
      return state;
    }
  }
  const ownerId = messageOwnerId;
  const messages = state.history && !historyPlan(state.messages, incoming.id) &&
    !state.messages.some(message => message.id === ownerId)
    ? state.messages : placePlanInHistory(state.messages, incoming, ownerId);
  const latest = state.activePlan;
  return { ...state, messages, activePlan: !latest || latest.id === plan.id || latest.createdAt <= plan.createdAt ? incoming : latest };
}

/**
 * Fold a `card` event into the state.
 *
 * A plan snapshot updates its original message rather than appending another plan card.
 */
function attachCard(state: ChatUIState, card: ChatCard, messageId?: string): ChatUIState {
  if (card.type === 'plan') {
    return upsertPlan(state, card.plan, undefined, messageId);
  }
  if (!state.messages.some(message => message.role === 'tool' && message.id === messageId)) return state;
  const messages = state.messages.map((m) =>
    m.id === messageId && !(m.cards ?? []).some(existing => cardFingerprint(existing) === cardFingerprint(card))
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
 * The current typed settlement signal emitted by action transport and persisted run recovery.
 */
export type ActionSettledEvent = Extract<AgentStreamEvent, { type: 'action_settled' }>;

/**
 * Fold a settled-action signal: stamp the server-reported status (+ optional reason) onto the
 * matching inline `confirmation` card(s) so a settled card shows a terminal badge instead of inert
 * buttons, and — for a TERMINAL status — clear the live decision when it is the SAME action.
 */
export function settleAction(state: ChatUIState, event: ActionSettledEvent): ChatUIState {
  if (event.status === 'confirmed' && asTerminalStatus(state.settledActions?.[event.actionId])) return state;
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
      const sameSummary = stamped === undefined && key !== undefined && decisionKey(card.action) === key;
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

  const status: ToolEventView['status'] | undefined = event.status === 'executed' ? 'success'
    : event.status === 'failed' || event.status === 'locked' ? 'error'
      : event.status === 'cancelled' || event.status === 'needs_reconciliation' ? event.status
        : event.status === 'confirmed' ? 'updated' : undefined;
  // A settlement carries NO user-facing text of its own (a locked refusal may carry a raw payload),
  // so the row keeps its own `summary`/`errorParams` and gains TYPED facts instead: a `locked`
  // settlement states the lock through `errorCode` (an existing gateway code such as `MFA_LOCKED` /
  // `CIRCUIT_OPEN` wins), which `publicToolSummary` renders as `chat.error.actionLocked` /
  // `chat.error.securityLocked`. No string cleaning happens here.
  const settleTools = (tools: ToolEventView[] | undefined) => tools?.map(tool => {
    if (!status || tool.actionId !== event.actionId) return tool;
    if (status !== 'error') return { ...tool, status };
    const errorCode = tool.errorCode ?? (event.status === 'locked' ? 'MFA_LOCKED' as const : undefined);
    return errorCode === undefined ? { ...tool, status } : { ...tool, status, errorCode };
  });
  let withCards = { ...state,
    messages: (changed ? messages : state.messages).map(message => ({ ...message, toolEvents: settleTools(message.toolEvents) })),
    toolEvents: settleTools(state.toolEvents) ?? [],
  };
  const terminal = asTerminalStatus(event.status);
  if (terminal !== undefined) {
    const pendingReconciliations = state.pendingReconciliations.flatMap(row => {
      if (row.actionId !== event.actionId) return [row];
      return terminal === 'needs_reconciliation' ? [{ ...row, attention: 'reconciliation' as const }] : [];
    });
    if (terminal === 'needs_reconciliation' && !pendingReconciliations.some(row => row.actionId === event.actionId)) {
      const inline = state.messages.flatMap(message => message.cards ?? []).find(card =>
        (card.type === 'confirmation' && card.action.actionId === event.actionId) ||
        (card.type === 'mfa' && card.actionId === event.actionId));
      const summary = matchesPending && pending?.summary.toolName ? pending.summary
        : inline?.type === 'confirmation' ? inline.action : inline?.type === 'mfa' ? inline.action : undefined;
      if (summary?.toolName) pendingReconciliations.push({
        actionId: event.actionId, summary: { ...summary, toolName: summary.toolName }, attention: 'reconciliation',
      });
    }
    withCards = { ...withCards, pendingReconciliations,
      settledActions: { ...state.settledActions, [event.actionId]: terminal } };
  }
  if (event.status === 'confirmed') withCards = { ...withCards,
    settledActions: { ...state.settledActions, [event.actionId]: 'confirmed' } };
  if (matchesPending && (terminal !== undefined || event.status === 'confirmed')) {
    return { ...withCards, pendingAction: undefined };
  }
  return withCards;
}

/** An old authorization frame cannot reopen an action already recorded as terminal. */
function hasSettledAction(state: ChatUIState, actionId: string): boolean {
  return state.settledActions?.[actionId] !== undefined || state.messages.some(message => message.cards?.some(card =>
    card.type === 'mfa' && card.actionId === actionId && asTerminalStatus(card.status) !== undefined ||
    card.type === 'confirmation' && card.action.actionId === actionId &&
      asTerminalStatus((card.action as PendingActionSummary & { status?: string }).status) !== undefined));
}

/**
 * Rows that may still (re)build a live decision. An action already recorded as settled — in
 * `settledActions` or on a terminal inline card — must NEVER be re-adopted, so a stale server row
 * that keeps reporting `awaiting_mfa` cannot reopen a dismissed popup. Out-of-band
 * `needs_reconciliation` rows are always surfaced (they carry no confirm/MFA path) so the user still
 * sees the uncertain outcome.
 */
export function visibleRefs(state: ChatUIState, refs: PendingActionRef[]): PendingActionRef[] {
  return refs.filter(ref => ref.status === 'needs_reconciliation' || !hasSettledAction(state, ref.id));
}

/** A later plan node can issue a decision without republishing its original tool message. */
function attachPlanDecisionRecord(messages: ChatMessage[], actionId: string, record: ChatCard): ChatMessage[] {
  if (messages.some(message => message.cards?.some(card =>
    card.type === 'mfa' && card.actionId === actionId || card.type === 'confirmation' && card.action.actionId === actionId))) return messages;
  const owners = messages.filter(message => message.cards?.some(card => card.type === 'plan' &&
    card.plan.results.some(node => node.output !== null && typeof node.output === 'object' &&
      (node.output as { pendingActionId?: unknown }).pendingActionId === actionId)));
  if (owners.length !== 1) return messages;
  return messages.map(message => message.id === owners[0].id
    ? { ...message, cards: [...(message.cards ?? []), record] } : message);
}

/** Fold ONE event into the state (immutable — returns a new state object). */
function applyEvent(state: ChatUIState, event: AgentStreamEvent, t: Translator): ChatUIState {
  if (event.type === 'action_settled') return settleAction(state, event);

  switch (event.type) {
    case 'session':
      return { ...state, sessionId: event.sessionId };

    case 'message_start':
      // A start replay is not a new response and must not erase completed history or live text.
      if (state.messages.some(message => message.id === event.message.id)) return state;
      if (event.message.role !== 'assistant') return { ...state, messages: upsertMessage(state.messages, event.message) };
      return {
        ...state,
        messages: upsertMessage(state.messages, { ...event.message, cards: [] }),
        currentAssistantId: event.message.id,
        streamingText: '',
      };

    case 'text_delta':
      if (!state.currentAssistantId) return state;
      return { ...state, streamingText: state.streamingText + event.delta };

    case 'reply_progress':
      if (!state.busy) return state;
      return { ...state, replyPhase: event.phase };

    case 'message_end': {
      const previous = state.messages.find(message => message.id === event.message.id);
      const toolEvents = (event.message.toolEvents ?? []).reduce(upsertToolEvent, previous?.toolEvents ?? []);
      const endsCurrent = state.currentAssistantId === event.message.id;
      let next: ChatUIState = {
        ...state,
        messages: upsertMessage(state.messages, { ...event.message, toolEvents }),
        streamingText: endsCurrent ? '' : state.streamingText,
        currentAssistantId: endsCurrent ? undefined : state.currentAssistantId,
      };
      for (const card of event.message.cards ?? []) {
        if (card.type === 'plan') next = upsertPlan(next, card.plan, undefined, event.message.id);
      }
      return next;
    }

    case 'tool_start':
    case 'tool_end': {
      const toolEvents = upsertToolEvent(state.toolEvents, event.toolEvent);
      const messages = attachToolEventToMessage(state.messages, event.toolEvent);
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
      return attachCard(state, event.card, event.messageId);

    case 'plan_update':
      return upsertPlan(state, event.plan, event.generation, event.messageId);

    case 'confirmation_required':
      if (hasSettledAction(state, event.actionId)) return state;
      return {
        ...state,
        messages: attachPlanDecisionRecord(state.messages, event.actionId, {
          type: 'confirmation', action: { ...event.action, actionId: event.actionId },
        }),
        pendingAction: {
          kind: 'confirmation',
          summary: event.action,
          actionId: event.actionId,
        },
      };

    case 'mfa_required': {
      if (hasSettledAction(state, event.actionId)) return state;
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
        messages: attachPlanDecisionRecord(messages, event.actionId, {
          type: 'mfa', actionId: event.actionId, action: summary as PendingActionSummary, hint: event.hint,
        }),
        pendingAction: {
          kind: 'mfa',
          summary,
          actionId: event.actionId,
          ...(event.hint !== undefined ? { hint: event.hint } : {}),
        },
      };
    }

    case 'security_event':
      // A refusal is rendered from its TYPED facts (`code`/`reason`/`attemptsLeft`) through the one
      // public-text funnel. The event's own text is never read: a locked/deny payload is internal.
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: nextLocalId('system'),
            role: 'system',
            content: securityNotice(event, t) || t('chat.error.securityDenied'),
            timestamp: Date.now(),
          },
        ],
      };

    case 'error':
      return { ...state, error: event.message, errorCode: event.code };

    case 'done':
      return { ...state, busy: false, replyPhase: undefined };

    default:
      return state;
  }
}

/**
 * PURE fold of a batch of `AgentStreamEvent`s over a `ChatUIState`.
 * Non-mutating: the input state and events are never changed.
 */
export function reduceAgentEvents(state: ChatUIState, events: AgentStreamEvent[], t: Translator = createTranslator(DEFAULT_LOCALE)): ChatUIState {
  return events.reduce((current, event) => applyEvent(current, event, t), state);
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
export function pickPendingAction(refs: PendingActionRef[]): PendingHumanDecision | undefined {
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
  // A decision built from a persisted row carries that row's own status/reason so a NON-live row can
  // never render as a live input (a live `pending` / `awaiting_mfa` row still renders the input).
  const statusMessage = (chosen.summary as PendingActionSummary & { message?: string }).message;
  const decisionStatus = { status: chosen.status, ...(statusMessage !== undefined ? { statusMessage } : {}) };
  if (chosen.requiresMfa || chosen.status === 'awaiting_mfa' || chosen.tier === 'RED') {
    return { kind: 'mfa', summary: restoredMfaSummary(chosen.summary), actionId: chosen.id, ...decisionStatus };
  }
  return { kind: 'confirmation', summary: chosen.summary, actionId: chosen.id, ...decisionStatus };
}

/**
 * Every OUT-OF-BAND row (attention `processing` / `recoverable` / `reconciliation`), mapped to a
 * display-only `PendingReconciliation`. These rows have NO live decision path (no confirm/MFA) —
 * they exist so the user sees an in-flight action, can trigger recovery for a recoverable wedge, and
 * is told when a gated operation must be reconciled out-of-band.
 */
export function pickAttention(refs: PendingActionRef[]): PendingReconciliation[] {
  const out: PendingReconciliation[] = [];
  for (const ref of refs) {
    if (ref.attention === 'decision') continue;
    out.push({ summary: ref.summary, actionId: ref.id, attention: ref.attention });
  }
  return out;
}

/** A restoration read cannot overwrite a decision changed after the read started. */
export function restoreActionAttention(state: ChatUIState, refs: PendingActionRef[], readRevision: number, currentRevision: number): ChatUIState {
  if (readRevision !== currentRevision) return state;
  const relevant = visibleRefs(state, refs);
  const decision = pickPendingAction(relevant);
  const reconciliations = pickAttention(relevant);
  const pendingAction = state.pendingAction ?? decision;
  const messages = pendingAction?.kind === 'mfa' ? state.messages.map(message => ({ ...message,
    cards: message.cards?.map(card => card.type === 'confirmation' && card.action.actionId === pendingAction.actionId &&
      asTerminalStatus((card.action as PendingActionSummary & { status?: string }).status) === undefined
      ? { type: 'mfa' as const, actionId: pendingAction.actionId,
        ...(pendingAction.summary.toolName ? { action: { ...pendingAction.summary, toolName: pendingAction.summary.toolName } } : {}),
        hint: pendingAction.hint } : card),
  })) : state.messages;
  return { ...state, messages, pendingAction,
    pendingReconciliations: state.pendingReconciliations.length ? state.pendingReconciliations : reconciliations };
}

/** Both the conversation generation and request revision fence asynchronous responses. */
export function acceptsChatResponse(generation: string | undefined, currentGeneration: string | undefined, revision: number, currentRevision: number): boolean {
  return generation === currentGeneration && revision === currentRevision;
}

/** Restore authoritative prose and tool rows; never duplicate optimistic user messages. */
export function reconcileInterruptedHistory(state: ChatUIState, page: ChatHistoryPage, startedAt: number, t: Translator = createTranslator(DEFAULT_LOCALE)): ChatUIState {
  if (!acceptsHistoryPage(state.history, page)) return state;
  const candidates = page.messages.filter(message => (message.role === 'assistant' || message.role === 'tool') &&
    (message.timestamp >= startedAt || state.messages.some(existing => existing.id === message.id)));
  let next = state;
  for (const message of candidates) {
    next = reduceAgentEvents(next, [{ type: 'message_end', message }], t);
    for (const toolEvent of message.toolEvents ?? []) {
      if (['success', 'error', 'cancelled', 'needs_reconciliation'].includes(toolEvent.status)) {
        next = { ...next, toolEvents: upsertToolEvent(next.toolEvents, toolEvent) };
      }
    }
    for (const card of message.cards ?? []) {
      const actionId = card.type === 'mfa' ? card.actionId : card.type === 'confirmation' ? card.action.actionId : undefined;
      const status = card.type === 'mfa' ? card.status : card.type === 'confirmation'
        ? (card.action as PendingActionSummary & { status?: string }).status : undefined;
      const terminal = asTerminalStatus(status);
      if (actionId && terminal) next = settleAction(next, { type: 'action_settled', actionId, status: terminal });
    }
  }
  return { ...next, history: { ...next.history!, revision: Math.max(next.history!.revision, page.revision) } };
}

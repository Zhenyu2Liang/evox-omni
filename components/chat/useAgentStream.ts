'use client';

/**
 * `useAgentStream.ts` — the STATEFUL chat-stream hook.
 *
 * The pure event→state fold of `AgentStreamEvent[]` → `ChatUIState` lives in `./agent-stream-reducer`
 * (DOM-free, unit-testable) and is re-exported here so `./index.ts` and the tests keep importing it
 * from this module. This file owns only the stateful part: the `busy`/`pendingAction` transitions and
 * the client fetch helpers in `./actions`.
 *
 * Rules: NEVER throws to the UI (failures fold into `error` + a synthetic `error` event); never
 * renders chain-of-thought; the browser never executes a banking op (confirm/verify/cancel/recover
 * POST to `./app` routes which re-validate + execute server-side).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentStreamEvent,
  ChatMessage,
  ChatTurnResponse,
  ToolEventView,
} from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ChatEndpoints } from './actions';
import type { TaskControlAction } from './cards';
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
import {
  acceptsChatResponse,
  beginAgentRequest,
  initialChatUIState,
  nextLocalId,
  pickAttention,
  pickPendingAction,
  reconcileInterruptedHistory,
  reduceAgentEvents,
  restoreActionAttention,
  settleAction,
  upsertPlan,
  visibleRefs,
  type ChatUIState,
  type PendingHumanDecision,
  type PendingReconciliation,
} from './agent-stream-reducer';
import { redactRequest } from '@/lib/sensitive';
import type { ChatHistoryPage } from '@/lib/contracts/chat-history';
import { acceptsHistoryPage, mergeHistoryPage, type ChatHistoryState } from './history';
import { requestLatestHistory, requestOlderHistory } from './history-request';
import type { ErrorCode } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/LocaleProvider';

// Re-export the pure fold (state shape + every reducer helper) so existing importers of this module
// — including `./index.ts` — keep working unchanged.
export * from './agent-stream-reducer';

export interface UseAgentStreamResult {
  messages: ChatMessage[];
  toolEvents: ToolEventView[];
  activePlan?: TaskPlan;
  pendingAction?: PendingHumanDecision;
  /** Restored out-of-band actions (processing / recoverable / needs_reconciliation) — never re-invoked. */
  pendingReconciliations: PendingReconciliation[];
  streamingText: string;
  replyPhase?: 'generating' | 'checking' | 'repairing';
  busy: boolean;
  /** True while the mount-time pending-actions read (`GET /api/actions`) is in flight. */
  restoring: boolean;
  /** Consecutive failed MFA attempts for the ACTIVE decision (reset when it settles/changes). */
  mfaAttempts: number;
  error?: string;
  errorCode?: ErrorCode;
  history?: ChatHistoryState;
  loadingHistory: boolean;
  historyError?: 'chat.history.failed' | 'chat.history.changed';
  loadOlder(): Promise<boolean>;
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
  initialHistory?: ChatHistoryPage;
  /**
   * Current conversation's plan selected by the server. Historical browser hints are not used.
   */
  taskId?: string;
}

/** SAFE, single-line user-facing message from any throwable (never a raw stack). */
function errorMessage(_error: unknown): string {
  return 'The request could not be completed. Reload the conversation to check its status.';
}

export function useAgentStream(o?: UseAgentStreamOptions): UseAgentStreamResult {
  const endpoints = o?.endpoints ?? DEFAULT_ENDPOINTS;
  const taskId = o?.taskId;
  const initialSessionId = o?.sessionId;
  const [state, setState] = useState<ChatUIState>(() =>
    initialChatUIState({
      ...(o?.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
      messages: o?.initialMessages ?? [],
      ...(o?.initialHistory ? { messages: o.initialHistory.messages, history: {
        hasMore: o.initialHistory.hasMore, nextCursor: o.initialHistory.nextCursor,
        revision: o.initialHistory.revision, historyGeneration: o.initialHistory.historyGeneration,
      } } : {}),
    }),
  );

  // Keep the newest endpoints reachable from the one-shot recovery effect without re-running it on
  // every render when a caller passes an inline `endpoints` object.
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;
  const stateRef = useRef(state);
  stateRef.current = state;
  // The reducer renders security refusals through the message catalog, so it needs the CURRENT
  // translator. A ref keeps every `useCallback([])` identity stable across a language switch.
  const { t } = useI18n();
  const translatorRef = useRef(t);
  translatorRef.current = t;
  const historyRequestRef = useRef(0);
  const historyAbortRef = useRef<AbortController | undefined>(undefined);
  const historyBusyRef = useRef(false);
  const historyGenerationRef = useRef(o?.initialHistory?.historyGeneration);
  const requestRevisionRef = useRef(0);
  const operationBusyRef = useRef(false);
  const sendingRef = useRef(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<'chat.history.failed' | 'chat.history.changed'>();

  // Language and developer preference refreshes keep loaded history and drafts. A chat reset
  // changes the generation and fences every response issued for the previous conversation.
  useEffect(() => {
    const page = o?.initialHistory;
    if (!page || page.historyGeneration === historyGenerationRef.current) return;
    historyGenerationRef.current = page.historyGeneration;
    requestRevisionRef.current++;
    operationBusyRef.current = false;
    sendingRef.current = false;
    historyRequestRef.current++;
    historyAbortRef.current?.abort();
    historyBusyRef.current = false;
    setLoadingHistory(false); setHistoryError(undefined);
    setState(initialChatUIState({ sessionId: initialSessionId, messages: page.messages, history: {
      hasMore: page.hasMore, nextCursor: page.nextCursor, revision: page.revision, historyGeneration: page.historyGeneration,
    } }));
  }, [o?.initialHistory, initialSessionId]);

  useEffect(() => () => { historyRequestRef.current++; requestRevisionRef.current++; historyAbortRef.current?.abort(); }, []);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const history = stateRef.current.history;
    if (historyBusyRef.current || !history?.hasMore || !history.nextCursor) return false;
    historyBusyRef.current = true;
    const request = ++historyRequestRef.current;
    const abort = new AbortController(); historyAbortRef.current = abort;
    setLoadingHistory(true); setHistoryError(undefined);
    try {
      const endpoint = endpointsRef.current.history ?? '/api/chat/history';
      const result = await requestOlderHistory(endpoint, history.nextCursor, abort.signal);
      if (request !== historyRequestRef.current) return false;
      if (result.kind !== 'page') { setHistoryError(result.kind === 'changed' ? 'chat.history.changed' : 'chat.history.failed'); return false; }
      const page = result.page;
      if (!acceptsHistoryPage(stateRef.current.history, page)) { setHistoryError('chat.history.changed'); return false; }
      stateRef.current = mergeHistoryPage(stateRef.current, page);
      setState(previous => mergeHistoryPage(previous, page));
      return true;
    } catch {
      if (request === historyRequestRef.current && !abort.signal.aborted) setHistoryError('chat.history.failed');
      return false;
    } finally {
      if (request === historyRequestRef.current) { historyBusyRef.current = false; setLoadingHistory(false); }
    }
  }, []);

  // Refresh recovery uses the server-selected plan for the current conversation. A failed fetch never
  // clobbers a plan a live `plan_update` already delivered.
  useEffect(() => {
    if (initialSessionId === undefined) return;
    const planId = taskId;
    if (planId === undefined) return;
    let alive = true;
    const revision = requestRevisionRef.current;
    void (async () => {
      const plan = await fetchTaskPlan(planId, endpointsRef.current);
      if (!alive || plan === undefined || revision !== requestRevisionRef.current) return;
      setState((prev) => (revision !== requestRevisionRef.current || prev.activePlan ? prev : upsertPlan(prev, plan)));
    })();
    return () => {
      alive = false;
    };
  }, [taskId, initialSessionId, o?.initialHistory?.historyGeneration]);

  // ACTIVE refresh restore: on mount, rebuild the pending human decision from the server so a
  // reloaded page still shows the confirm/MFA card for an in-flight action. Best-effort: a
  // stale/unmounted/aborted or failed read is ignored and NEVER clobbers a decision a live event
  // already delivered (checked via a functional `setState`). `restoring` tracks the read in flight.
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (initialSessionId === undefined) { setRestoring(false); return; }
    // Always read for a known session, even when a live decision already exists.
    // A live decision must never be clobbered
    // (guarded in the functional `setState` below), and an out-of-band row — which carries no live
    // decision of its own — must still be surfaced for manual reconciliation / recovery.
    let alive = true;
    const revision = requestRevisionRef.current;
    const abort = new AbortController();
    setRestoring(true);
    void (async () => {
      try {
        const refs = await fetchPendingActions(endpointsRef.current, abort.signal);
        if (!alive || abort.signal.aborted) return;
        setState(prev => alive && !abort.signal.aborted
          ? restoreActionAttention(prev, refs, revision, requestRevisionRef.current) : prev);
      } finally { if (alive) setRestoring(false); }
    })();
    return () => {
      alive = false;
      abort.abort();
    };
  }, [initialSessionId, o?.initialHistory?.historyGeneration]);

  // Reset the MFA attempt counter whenever the active decision clears or changes (a success, a
  // cancel, or a NEW action). A failed verify keeps the SAME actionId/kind, so the count survives.
  const pendingActionKey = state.pendingAction?.actionId;
  const pendingActionKind = state.pendingAction?.kind;
  useEffect(() => {
    setState((prev) => (prev.mfaAttempts === 0 ? prev : { ...prev, mfaAttempts: 0 }));
  }, [pendingActionKey, pendingActionKind]);

  /** Fold a batch of events into the UI state. */
  const applyEvents = useCallback((events: AgentStreamEvent[]) => {
    if (!operationBusyRef.current) requestRevisionRef.current++;
    setState((prev) => reduceAgentEvents(prev, events, translatorRef.current));
  }, []);

  /**
   * Shared "run one turn" path: flip `busy`, run `load()`, fold the returned events and settle
   * `pendingAction` (kept only if the turn reported an `error`). Never throws to the UI.
   */
  const pull = useCallback(async (load: (onEvent: (event: AgentStreamEvent) => void) => Promise<ChatTurnResponse>, settlesDecision = true, actionId?: string) => {
    if (operationBusyRef.current) return;
    operationBusyRef.current = true;
    const generation = historyGenerationRef.current;
    const revision = ++requestRevisionRef.current;
    const acceptsResponse = () => acceptsChatResponse(generation, historyGenerationRef.current, revision, requestRevisionRef.current);
    const startedAt = Date.now();
    setState(beginAgentRequest);
    const delivered = new Set<AgentStreamEvent>();
    const onEvent = (event: AgentStreamEvent) => {
      if (!acceptsResponse()) return;
      delivered.add(event);
      setState(previous => acceptsResponse()
        ? reduceAgentEvents(previous, [event], translatorRef.current) : previous);
    };
    try {
      const res = await load(onEvent);
      if (!acceptsResponse()) return;
      const events = res.events ?? [];
      const interrupted = events.some(event => event.type === 'error' &&
        ['The response stream ended before completion. Inspect the saved run before retrying.',
          'The response stream was interrupted. Inspect the saved run before retrying.'].includes(event.message));
      const saved = interrupted ? await requestLatestHistory(endpointsRef.current.history ?? '/api/chat/history', new AbortController().signal) : undefined;
      if (!acceptsResponse()) return;
      setState((prev) => {
        if (!acceptsResponse()) return prev;
        // Seed the (server-confirmed) sessionId, then let a `session` event take precedence.
        const base = res.sessionId ? { ...prev, sessionId: res.sessionId } : prev;
        // Fold FIRST so a settlement signal (`action_settled`) still sees the decision it belongs to,
        // then apply the generic settle rule: a non-error turn clears the decision it acted on.
        let reduced = reduceAgentEvents(base, events.filter(event => !delivered.has(event)), translatorRef.current);
        if (saved?.kind === 'page') {
          reduced = reconcileInterruptedHistory(reduced, saved.page, startedAt, translatorRef.current);
        }
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
        return { ...reduced, ...(clearPending ? { pendingAction: undefined } : {}), busy: false, replyPhase: undefined };
      });
    } catch (e) {
      if (!acceptsResponse()) return;
      const message = errorMessage(e);
      setState((prev) => ({
        ...reduceAgentEvents(prev, [{ type: 'error', message }], translatorRef.current),
        busy: false,
        replyPhase: undefined,
      }));
    } finally { if (acceptsResponse()) operationBusyRef.current = false; }
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (sendingRef.current || operationBusyRef.current) return;
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
      if (operationBusyRef.current) return;
      const generation = historyGenerationRef.current;
      const revision = requestRevisionRef.current + 1;
      await pull(() => verifyAction(actionId, code, endpoints), true, actionId);
      // A WRONG code keeps the SAME `mfa` decision active and sets `error` — count the attempt so the
      // MFA card can show "第 N 次尝试". A success/cancel clears `pendingAction` (and the reset effect
      // zeroes the counter); a new action changes actionId/kind, which also resets it.
      setState((prev) =>
        acceptsChatResponse(generation, historyGenerationRef.current, revision, requestRevisionRef.current) &&
          prev.pendingAction?.kind === 'mfa' && prev.pendingAction.actionId === actionId && prev.error !== undefined
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
   * browser never replays a banking op itself. The settlement event updates the attention entry:
   * final known outcomes remove recovery controls; uncertain outcomes remain visible for manual
   * reconciliation. A transport failure leaves the entry available and surfaces a safe error.
   */
  const recover = useCallback(
    (actionId: string) => pull(() => recoverAction(actionId, endpoints), true, actionId),
    [pull, endpoints],
  );

  /**
   * Steer the running plan (`pause`/`resume`/`cancel`/`retry`) via `POST /api/tasks/:id`. Defaults
   * `planId` to the latest plan. Historical controls supply their own plan id. Folds the returned
   * snapshot into that plan's owning historical card. A failed control surfaces a SAFE `error` and
   * NEVER throws to the UI.
   */
  const controlTask = useCallback(
    async (action: TaskControlAction, planId?: string) => {
      if (operationBusyRef.current) return;
      const id = planId ?? state.activePlan?.id;
      if (id === undefined) {
        setState((prev) => ({ ...prev, error: '当前没有可控制的任务计划' }));
        return;
      }
      operationBusyRef.current = true;
      const generation = historyGenerationRef.current;
      const revision = ++requestRevisionRef.current;
      const acceptsResponse = () => acceptsChatResponse(generation, historyGenerationRef.current, revision, requestRevisionRef.current);
      setState(beginAgentRequest);
      try {
      const plan = await controlTaskRequest(id, action, endpoints);
      if (!acceptsResponse()) return;
      if (plan === undefined) {
        setState((prev) => ({ ...prev, busy: false, replyPhase: undefined, error: errorMessage(undefined) }));
        return;
      }
      const refs = await fetchPendingActions(endpoints);
      if (!acceptsResponse()) return;
      setState((prev) => {
        if (!acceptsResponse()) return prev;
        let next = upsertPlan(prev, plan);
        if (plan.status === 'cancelled' && next.pendingAction && !refs.some(ref => ref.id === next.pendingAction!.actionId)) {
          next = settleAction(next, { type: 'action_settled', actionId: next.pendingAction.actionId, status: 'cancelled' });
        }
        const visible = visibleRefs(next, refs);
        return { ...next, pendingAction: pickPendingAction(visible), pendingReconciliations: pickAttention(visible), busy: false, replyPhase: undefined };
      });
      } finally { if (acceptsResponse()) operationBusyRef.current = false; }
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
    replyPhase: state.replyPhase,
    busy: state.busy,
    restoring,
    mfaAttempts: state.mfaAttempts,
    error: state.error,
    errorCode: state.errorCode,
    history: state.history,
    loadingHistory,
    historyError,
    loadOlder,
    applyEvents,
    send,
    confirm,
    verify,
    cancel,
    recover,
    controlTask,
  };
}

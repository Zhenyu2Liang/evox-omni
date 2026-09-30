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
 * renders chain-of-thought; the browser never executes a banking op (confirm/verify/cancel POST to
 * `./app` routes which re-validate + execute server-side).
 */
import { useCallback, useState } from 'react';
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
import type { ChatEndpoints } from './actions';
import {
  DEFAULT_ENDPOINTS,
  cancelAction,
  confirmAction,
  sendChatTurn,
  verifyAction,
} from './actions';

/**
 * The summary for an MFA prompt. The `mfa_required` event carries no tool name, so `toolName` is
 * the actual gated tool the stream reported as blocked (omitted when the stream carried none —
 * never invented).
 */
export interface MfaActionSummary extends Omit<PendingActionSummary, 'toolName'> {
  toolName?: ToolName;
}

export interface UseAgentStreamResult {
  messages: ChatMessage[];
  toolEvents: ToolEventView[];
  activePlan?: TaskPlan;
  pendingAction?: { summary: PendingActionSummary | MfaActionSummary; actionId: string };
  streamingText: string;
  busy: boolean;
  error?: string;
  applyEvents(events: AgentStreamEvent[]): void; // fold a batch (used by actions + SSE)
  send(text: string): Promise<void>; // POST /api/chat, fold response
  confirm(actionId: string): Promise<void>; // POST /api/actions/:id/confirm
  verify(actionId: string, code: string): Promise<void>; // POST .../verify
  cancel(actionId: string): Promise<void>; // POST .../cancel
}

export interface UseAgentStreamOptions {
  sessionId?: string;
  endpoints?: ChatEndpoints;
  initialMessages?: ChatMessage[];
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
  pendingAction?: { summary: PendingActionSummary | MfaActionSummary; actionId: string };
  streamingText: string;
  busy: boolean;
  error?: string;
  currentAssistantId?: string;
  lastBlockedToolName?: ToolName;
}

/** A fresh `ChatUIState` (empty arrays, empty streamingText, busy false) merged with `overrides`. */
export function initialChatUIState(overrides: Partial<ChatUIState> = {}): ChatUIState {
  return {
    messages: [],
    toolEvents: [],
    streamingText: '',
    busy: false,
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

// --- pure reducer helpers ---------------------------------------------------------------------

/** Replace the message with the same `id`, else append (immutable). */
function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
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

/** Append a card to the target assistant message, creating a minimal one if none exists. */
function attachCard(state: ChatUIState, card: ChatCard): ChatUIState {
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
    m.id === targetId ? { ...m, cards: [...(m.cards ?? []), card] } : m,
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

/** Fold ONE event into the state (immutable — returns a new state object). */
function applyEvent(state: ChatUIState, event: AgentStreamEvent): ChatUIState {
  switch (event.type) {
    case 'session':
      return { ...state, sessionId: event.sessionId };

    case 'message_start':
      return {
        ...state,
        messages: upsertMessage(state.messages, event.message),
        currentAssistantId: event.message.id,
      };

    case 'text_delta':
      return { ...state, streamingText: state.streamingText + event.delta };

    case 'message_end':
      return {
        ...state,
        messages: upsertMessage(state.messages, event.message),
        streamingText: '',
        currentAssistantId: undefined,
      };

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
      return { ...state, activePlan: event.plan };

    case 'confirmation_required':
      return { ...state, pendingAction: { summary: event.action, actionId: event.actionId } };

    case 'mfa_required':
      return {
        ...state,
        pendingAction: { actionId: event.actionId, summary: mfaSummary(state, event.hint) },
      };

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

// --- stateful hook ----------------------------------------------------------------------------

export function useAgentStream(o?: UseAgentStreamOptions): UseAgentStreamResult {
  const endpoints = o?.endpoints ?? DEFAULT_ENDPOINTS;
  const [state, setState] = useState<ChatUIState>(() =>
    initialChatUIState({
      ...(o?.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
      messages: o?.initialMessages ?? [],
    }),
  );

  /** Fold a batch of events into the UI state. */
  const applyEvents = useCallback((events: AgentStreamEvent[]) => {
    setState((prev) => reduceAgentEvents(prev, events));
  }, []);

  /**
   * Shared "run one turn" path: flip `busy`, run `load()`, fold the returned events and settle
   * `pendingAction` (kept only if the turn reported an `error`). Never throws to the UI.
   */
  const pull = useCallback(async (load: () => Promise<ChatTurnResponse>) => {
    setState((prev) => ({ ...prev, busy: true, error: undefined }));
    try {
      const res = await load();
      const events = res.events ?? [];
      setState((prev) => {
        // Seed the (server-confirmed) sessionId, then let a `session` event take precedence.
        const base = res.sessionId ? { ...prev, sessionId: res.sessionId } : prev;
        const settled = events.some((e) => e.type === 'error')
          ? base
          : { ...base, pendingAction: undefined };
        return { ...reduceAgentEvents(settled, events), busy: false };
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
      const userMessage: ChatMessage = {
        id: nextLocalId('user'),
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      setState((prev) => ({ ...prev, messages: [...prev.messages, userMessage], error: undefined }));
      const sessionId = state.sessionId;
      await pull(() =>
        sendChatTurn(
          sessionId !== undefined ? { sessionId, message: text } : { message: text },
          endpoints,
        ),
      );
    },
    [state.sessionId, endpoints, pull],
  );

  const confirm = useCallback(
    (actionId: string) => pull(() => confirmAction(actionId, endpoints)),
    [pull, endpoints],
  );
  const verify = useCallback(
    (actionId: string, code: string) => pull(() => verifyAction(actionId, code, endpoints)),
    [pull, endpoints],
  );
  const cancel = useCallback(
    (actionId: string) => pull(() => cancelAction(actionId, endpoints)),
    [pull, endpoints],
  );

  return {
    messages: state.messages,
    toolEvents: state.toolEvents,
    activePlan: state.activePlan,
    pendingAction: state.pendingAction,
    streamingText: state.streamingText,
    busy: state.busy,
    error: state.error,
    applyEvents,
    send,
    confirm,
    verify,
    cancel,
  };
}

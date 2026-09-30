'use client';

/**
 * `useAgentStream.ts` — the event→state fold of `AgentStreamEvent[]` → chat UI state.
 *
 * DESIGN-STUB phase: signatures are frozen; the fold/reducer body lands in the implementation phase.
 */
import type { AgentStreamEvent, ChatMessage, ToolEventView } from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ChatEndpoints } from './actions';

export interface UseAgentStreamResult {
  messages: ChatMessage[];
  toolEvents: ToolEventView[];
  activePlan?: TaskPlan;
  pendingAction?: { summary: PendingActionSummary; actionId: string };
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

export function useAgentStream(o?: UseAgentStreamOptions): UseAgentStreamResult {
  return {
    messages: [],
    toolEvents: [],
    streamingText: '',
    busy: false,
    applyEvents: () => {},
    send: async () => {},
    confirm: async () => {},
    verify: async () => {},
    cancel: async () => {},
  };
}

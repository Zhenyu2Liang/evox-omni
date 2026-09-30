'use client';

/**
 * `actions.ts` — client-side fetch contract for the `./app` API routes.
 *
 * DESIGN-STUB phase: signatures are frozen; the fetch bodies land in the implementation phase.
 */
import type { ChatTurnRequest, ChatTurnResponse } from '@/lib/contracts/agent';

export interface ChatEndpoints {
  chat: string; // default '/api/chat'
  confirm: (actionId: string) => string; // default `/api/actions/${id}/confirm`
  verify: (actionId: string) => string; // default `/api/actions/${id}/verify`
  cancel: (actionId: string) => string; // default `/api/actions/${id}/cancel`
}

export const DEFAULT_ENDPOINTS: ChatEndpoints = {
  chat: '/api/chat',
  confirm: (actionId) => `/api/actions/${actionId}/confirm`,
  verify: (actionId) => `/api/actions/${actionId}/verify`,
  cancel: (actionId) => `/api/actions/${actionId}/cancel`,
};

export function sendChatTurn(
  req: ChatTurnRequest,
  endpoints?: ChatEndpoints,
): Promise<ChatTurnResponse> {
  throw new Error('NOT_IMPLEMENTED');
}

export function confirmAction(
  actionId: string,
  endpoints?: ChatEndpoints,
): Promise<ChatTurnResponse> {
  throw new Error('NOT_IMPLEMENTED');
}

export function verifyAction(
  actionId: string,
  code: string,
  endpoints?: ChatEndpoints,
): Promise<ChatTurnResponse> {
  throw new Error('NOT_IMPLEMENTED');
}

export function cancelAction(
  actionId: string,
  endpoints?: ChatEndpoints,
): Promise<ChatTurnResponse> {
  throw new Error('NOT_IMPLEMENTED');
}

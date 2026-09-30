'use client';

/**
 * `ChatWindow.tsx` — the container: message list + composer; owns `useAgentStream`.
 *
 * DESIGN-STUB phase: renders nothing; the real surface lands in the implementation phase.
 */
import type { ChatMessage } from '@/lib/contracts/agent';
import type { ChatEndpoints } from './actions';

export interface ChatWindowProps {
  sessionId?: string;
  initialMessages?: ChatMessage[];
  endpoints?: ChatEndpoints;
  className?: string;
}

export function ChatWindow(p: ChatWindowProps) {
  return null;
}

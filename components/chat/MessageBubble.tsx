'use client';

/**
 * `MessageBubble.tsx` — one message; renders text + any cards via `./cards/CardRenderer` + tool events.
 *
 * DESIGN-STUB phase: renders nothing; the real bubble lands in the implementation phase.
 */
import type { ChatMessage } from '@/lib/contracts/agent';
import type { CardActionHandlers } from './cards';

export interface MessageBubbleProps {
  message: ChatMessage;
  action?: CardActionHandlers;
  className?: string;
}

export function MessageBubble(p: MessageBubbleProps) {
  return null;
}

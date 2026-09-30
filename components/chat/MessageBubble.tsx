'use client';

/**
 * `MessageBubble.tsx` — one message; renders text + any cards via `./cards/CardRenderer` + tool events.
 *
 * Presentational only: no chain-of-thought and no MFA code are ever rendered. Cards are rendered
 * EXCLUSIVELY through `CardRenderer` (never hand-parsed here), so adding/removing a `ChatCard`
 * variant stays a single compile-time concern in the card node.
 */
import type { ChatMessage, ChatRole } from '@/lib/contracts/agent';
import type { CardActionHandlers } from './cards';
import { CardRenderer } from './cards';
import { ToolEventList } from './ToolEventList';

export interface MessageBubbleProps {
  message: ChatMessage;
  action?: CardActionHandlers;
  className?: string;
}

/** Outer alignment per role. */
const ALIGN: Record<ChatRole, string> = {
  user: 'justify-end',
  assistant: 'justify-start',
  system: 'justify-center',
  tool: 'justify-start',
};

/** Inner bubble styling per role. */
const BUBBLE: Record<ChatRole, string> = {
  user: 'bg-banking-accent text-white rounded-2xl',
  assistant: 'bg-white text-banking-navy border border-banking-light rounded-2xl shadow-sm',
  system: 'bg-banking-light text-gray-500 text-center text-xs rounded-xl',
  tool: 'bg-banking-light text-gray-500 text-xs rounded-xl',
};

export function MessageBubble({ message, action, className }: MessageBubbleProps) {
  const cards = message.cards ?? [];
  const toolEvents = message.toolEvents ?? [];
  const hasBody = message.content.length > 0 || cards.length > 0 || toolEvents.length > 0;

  return (
    <div className={`flex w-full ${ALIGN[message.role]} ${className ?? ''}`.trim()}>
      <div className={`max-w-[85%] px-4 py-3 space-y-2 ${BUBBLE[message.role]}`}>
        {hasBody && (
          <>
            {message.content.length > 0 && (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {message.content}
              </p>
            )}
            {toolEvents.length > 0 && <ToolEventList events={toolEvents} />}
            {cards.map((card, i) => (
              <CardRenderer key={i} card={card} action={action} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

'use client';

/**
 * `MessageBubble.tsx` — one chronological prose, tool, or workflow entry.
 *
 * Presentational only: no chain-of-thought and no MFA code are ever rendered. Cards are rendered
 * EXCLUSIVELY through `CardRenderer` (never hand-parsed here), so adding/removing a `ChatCard`
 * variant stays a single compile-time concern in the card node.
 */
import type { ChatMessage, ChatRole } from '@/lib/contracts/agent';
import type { CardActionHandlers } from './cards';
import { CardRenderer } from './cards';
import { ToolEventList } from './ToolEventList';
import { AssistantMarkdown } from './AssistantMarkdown';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { isInternalDiagnostic, safePublicText } from '@/lib/public-text';

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
  user: 'bg-banking-deep text-white rounded-2xl rounded-br-md',
  assistant: 'bg-white text-banking-deep border border-slate-200/80 rounded-2xl rounded-tl-md shadow-xs',
  system: 'bg-banking-light text-gray-500 text-center text-xs rounded-xl',
  tool: 'bg-banking-light text-gray-500 text-xs rounded-xl',
};

export function MessageBubble({ message, action, className }: MessageBubbleProps) {
  const { t } = useI18n();
  const cards = message.cards ?? [];
  const toolEvents = message.toolEvents ?? [];
  const isBusinessEntry = message.role === 'tool' || message.role === 'system';
  const hasBody = message.content.length > 0 || isBusinessEntry && (cards.length > 0 || toolEvents.length > 0);
  // A `system` notice is a security refusal. The live text is already the typed catalog rendering
  // produced by `./agent-stream-reducer` (through `securityNotice`); a refusal restored from saved
  // history can still be the raw internal payload, so anything the public-text funnel classifies as
  // an internal diagnostic is replaced by the generic public notice (never cleaned by hand here).
  const systemText = message.role === 'system' && isInternalDiagnostic(message.content)
    ? safePublicText(message.content, t, 'chat.error.securityDenied')
    : message.content;
  if (!hasBody) return null;

  if (message.role === 'tool') return (
    <div data-message-role="tool" data-message-id={message.id} className={`min-w-0 w-[94%] max-w-[52rem] space-y-3 sm:ml-12 sm:w-[86%] ${className ?? ''}`.trim()}>
      <p className="text-[11px] font-medium tracking-wide text-banking-navy/70">{t('chat.message.activity')}</p>
      <ToolEventList events={toolEvents} compact={cards.length > 0} />
      {cards.map((card, index) => <CardRenderer key={index} card={card} action={action} />)}
    </div>
  );

  return (
    <div data-message-role={message.role} data-message-id={message.id} className={`flex min-w-0 w-full items-start gap-2 sm:gap-3 ${ALIGN[message.role]} ${className ?? ''}`.trim()}>
      {message.role === 'assistant' ? <span aria-hidden="true" className="mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-banking-accent/10 text-banking-accent sm:h-9 sm:w-9">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="13" rx="4" /><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" /></svg>
      </span> : null}
      <div className={`min-w-0 ${message.role === 'user' ? 'max-w-[min(80%,40rem)]' : message.role === 'assistant' ? 'max-w-[min(88%,52rem)]' : 'max-w-[88%]'} space-y-1.5`}>
        {message.role === 'assistant' || message.role === 'user' ? <p className={`px-1 text-[11px] font-medium text-banking-navy/70 ${message.role === 'user' ? 'text-right' : ''}`}>
          {t(message.role === 'user' ? 'chat.message.user' : 'chat.message.assistant')}
        </p> : null}
        <div className={`min-w-0 space-y-3 px-4 py-3 sm:px-5 sm:py-4 ${BUBBLE[message.role]}`}>
        {hasBody && (
          <>
            {message.content.length > 0 && (message.role === 'assistant' ? (
              <AssistantMarkdown text={message.content} />
            ) : (
              <p data-message-content="true" className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {systemText}
              </p>
            ))}
            {isBusinessEntry && cards.map((card, i) => (
              <CardRenderer key={i} card={card} action={action} />
            ))}
            {isBusinessEntry && toolEvents.length > 0 && <ToolEventList events={toolEvents} compact={cards.length > 0} />}
          </>
        )}
        </div>
      </div>
      {message.role === 'user' ? <span aria-hidden="true" className="mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-banking-deep text-white sm:h-9 sm:w-9">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg>
      </span> : null}
    </div>
  );
}

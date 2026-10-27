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
import { ChatAvatar } from './ChatAvatar';
import { isVisibleChatMessage } from './message-day';
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
  const hasBody = isVisibleChatMessage(message);
  // A `system` notice is a security refusal. The live text is already the typed catalog rendering
  // produced by `./agent-stream-reducer` (through `securityNotice`); a refusal restored from saved
  // history can still be the raw internal payload, so anything the public-text funnel classifies as
  // an internal diagnostic is replaced by the generic public notice (never cleaned by hand here).
  const systemText = message.role === 'system' && isInternalDiagnostic(message.content)
    ? safePublicText(message.content, t, 'chat.error.securityDenied')
    : message.content;
  if (!hasBody) return null;

  const approvals = cards.filter(card => card.type === 'confirmation' || card.type === 'mfa');
  const groupedResult = approvals.length === 1 && cards.some(card => !['confirmation', 'mfa', 'plan'].includes(card.type));
  const renderedCards = cards.map((card, index) => <CardRenderer key={index} card={card} action={action} />);
  const businessCards = cards.filter(card => card.type !== 'confirmation' && card.type !== 'mfa');
  const singleBankCard = businessCards.length === 1 && businessCards[0].type === 'cards' &&
    Array.isArray(businessCards[0].data) && businessCards[0].data.length === 1;

  if (message.role === 'tool') return (
    <div data-message-role="tool" data-message-id={message.id} data-single-bank-card={singleBankCard ? 'true' : undefined}
      className={`min-w-0 w-[94%] space-y-3 sm:ml-12 ${singleBankCard ? 'max-w-[28rem] sm:w-full' : 'max-w-[52rem] sm:w-[86%]'} ${className ?? ''}`.trim()}>
      <p className="text-[11px] font-medium tracking-wide text-banking-navy/70">{t('chat.message.activity')}</p>
      <ToolEventList events={toolEvents} compact={cards.length > 0} />
      {groupedResult ? <div data-operation-record className="overflow-hidden rounded-2xl border border-slate-200 bg-white [&_[data-approval-history]]:rounded-none [&_[data-approval-history]]:border-0 [&>[data-chat-card-type]+[data-chat-card-type]]:border-t [&>[data-chat-card-type]+[data-chat-card-type]]:border-slate-100 [&>[data-chat-card-type]>div]:rounded-none [&>[data-chat-card-type]>div]:shadow-none [&>[data-chat-card-type]>div]:ring-0">
        {renderedCards}
      </div> : renderedCards}
    </div>
  );

  return (
    <div data-message-role={message.role} data-message-id={message.id} className={`flex min-w-0 w-full items-start gap-2 sm:gap-3 ${ALIGN[message.role]} ${className ?? ''}`.trim()}>
      {message.role === 'assistant' ? <ChatAvatar role="assistant" /> : null}
      <div className={`min-w-0 ${message.role === 'user' ? 'max-w-[min(80%,40rem)]' : message.role === 'assistant' ? 'max-w-[min(88%,52rem)]' : 'max-w-[88%]'} space-y-1.5`}>
        {message.role === 'assistant' || message.role === 'user' ? <p className={`px-1 text-[11px] font-medium text-banking-navy/70 ${message.role === 'user' ? 'text-right' : ''}`}>
          {t(message.role === 'user' ? 'chat.message.user' : 'chat.message.assistant')}
        </p> : null}
        <div className={`min-w-0 space-y-3 px-4 py-3 sm:px-5 sm:py-4 ${BUBBLE[message.role]}`}>
        {hasBody && (
          <>
            {message.content.length > 0 && (message.role === 'assistant' ? (
              message.financialSummary ? <div data-financial-summary="true" className="space-y-3">
                <AssistantMarkdown text={message.financialSummary} />
                <details data-result-explanation className="border-t border-slate-100 pt-2">
                  <summary className="cursor-pointer text-xs font-medium text-banking-interactive hover:text-banking-accent">{t('business.presentation.resultExplanation')}</summary>
                  <div className="mt-3"><AssistantMarkdown text={message.content} /></div>
                </details>
              </div> : <AssistantMarkdown text={message.content} />
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
      {message.role === 'user' ? <ChatAvatar role="user" /> : null}
    </div>
  );
}

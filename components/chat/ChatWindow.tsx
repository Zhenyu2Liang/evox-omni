'use client';

/**
 * `ChatWindow.tsx` — the container: message list + live plan + active human-decision card + composer.
 * It owns `useAgentStream`.
 *
 * The browser NEVER executes a banking operation directly: the confirm/verify/cancel callbacks only
 * invoke the hook, which POSTs to the `./app` action routes where the server re-validates the
 * original args and executes. No chain-of-thought is rendered here — only messages, cards, plan
 * steps and tool status.
 *
 * Plans remain in their owning tool message and receive subsequent node updates in place.
 * Only an actionable plan without a historical owner can use the fallback plan surface.
 * The active decision lives in the composer dock. Historical authorization cards are read-only.
 *
 * `taskId` (optional) enables refresh recovery of the server-selected actionable plan. Historical
 * snapshots are supplied in the persisted transcript; browser storage never selects a plan.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { ChatEndpoints } from './actions';
import type { CardActionHandlers } from './cards';
import { useAgentStream } from './useAgentStream';
import { PlanCard, ReconciliationCard } from './cards';
import { ApprovalRequest } from './ApprovalRequest';
import { MessageBubble } from './MessageBubble';
import { presentationMessages } from './presentation-messages';
import { isVisibleChatMessage, messageDay, MessageDayDivider } from './message-day';
import { StreamingText } from './StreamingText';
import { Composer } from './Composer';
import { ChatWelcome } from './ChatWelcome';
import { Spinner } from '../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { publicToolError } from '@/lib/tool-feedback';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { historyPlan, isActionablePlan } from '@/lib/chat-plan-history';
import type { ChatHistoryPage } from '@/lib/contracts/chat-history';
import { captureHistoryAnchor, restoreHistoryAnchor, type ScrollAnchor } from './history';
import type { ErrorCode } from '@/lib/errors';

export interface ChatWindowProps {
  sessionId?: string;
  initialMessages?: ChatMessage[];
  initialHistory?: ChatHistoryPage;
  endpoints?: ChatEndpoints;
  /** Server-selected actionable plan to recover on mount. */
  taskId?: string;
  className?: string;
}

/** Unknown runtime failures remain developer diagnostics, while public business reasons survive. */
export function ChatErrorFeedback({ message, code, showNotice = true }: { message?: string; code?: ErrorCode; showNotice?: boolean }) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
  if (!message) return null;
  return <>
    {showNotice ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-banking-danger">
      {publicToolError(message, t, 'chat.error.request', code)}
    </div> : null}
    {developerMode ? <details data-chat-error-diagnostics="true" className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-banking-navy">
      <summary>{t('chat.diagnostics.detail')}</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words">{String(sanitizeToolArguments(message))}</pre>
    </details> : null}
  </>;
}

export function ChatWindow({
  sessionId,
  initialMessages,
  initialHistory,
  endpoints,
  taskId,
  className,
}: ChatWindowProps) {
  const { t } = useI18n();
  const stream = useAgentStream({ sessionId, initialMessages, initialHistory, endpoints, taskId });
  const localizedError = stream.error ? publicToolError(stream.error, t, 'chat.error.request', stream.errorCode) : undefined;
  const listRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const anchorRef = useRef<ScrollAnchor | undefined>(undefined);
  const loadingEarlierRef = useRef(false);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const previousLatestRef = useRef<string | undefined>(undefined);
  const previousStreamingRef = useRef('');
  const [draft, setDraft] = useState<{ content: string }>();

  const pending = stream.pendingAction;
  const visibleMessages = presentationMessages(stream.messages, pending?.actionId).filter(isVisibleChatMessage);
  const detachedPlan = stream.activePlan && isActionablePlan(stream.activePlan) &&
    !historyPlan(visibleMessages, stream.activePlan.id) ? stream.activePlan : undefined;

  const lastMessageId =
    visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1].id : undefined;
  // Only the newest reply may offer a planning retry. Starting any new turn retires old buttons.
  const retryRequest = visibleMessages.at(-1)?.role === 'assistant' ? visibleMessages.at(-1)?.retryRequest : undefined;

  // Follow new content only while the reader is already near the end.
  useLayoutEffect(() => {
    followLatestRef.current = true; anchorRef.current = undefined;
    setFollowingLatest(true); setHasNewMessages(false);
  }, [initialHistory?.historyGeneration]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && anchorRef.current && !stream.loadingHistory) {
      restoreHistoryAnchor(el, anchorRef.current);
      anchorRef.current = undefined;
      return;
    }
    const hasContent = visibleMessages.length > 0 || stream.streamingText.length > 0 || pending !== undefined ||
      stream.activePlan !== undefined || stream.pendingReconciliations.length > 0;
    if (el && followLatestRef.current && hasContent) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastMessageId, visibleMessages.length, stream.messages, stream.streamingText, pending, stream.activePlan, stream.pendingReconciliations, stream.loadingHistory]);

  useEffect(() => {
    if (!followLatestRef.current && ((previousLatestRef.current !== undefined && previousLatestRef.current !== lastMessageId) ||
        (stream.streamingText.length > 0 && stream.streamingText !== previousStreamingRef.current))) setHasNewMessages(true);
    previousLatestRef.current = lastMessageId;
    previousStreamingRef.current = stream.streamingText;
  }, [lastMessageId, stream.streamingText]);

  async function loadEarlier() {
    if (loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    const list = listRef.current;
    anchorRef.current = list ? captureHistoryAnchor(list) : undefined;
    followLatestRef.current = false;
    setFollowingLatest(false);
    try { if (!await stream.loadOlder()) anchorRef.current = undefined; }
    finally { loadingEarlierRef.current = false; }
  }

  function showLatest() {
    followLatestRef.current = true;
    setFollowingLatest(true); setHasNewMessages(false);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }

  function send(text: string) {
    followLatestRef.current = true;
    setFollowingLatest(true); setHasNewMessages(false);
    void stream.send(text);
  }

  const action: CardActionHandlers = {
    actionId: pending?.actionId,
    onConfirm: (id) => void stream.confirm(id),
    onVerify: (id, code) => void stream.verify(id, code),
    onCancel: (id) => void stream.cancel(id),
    onFreeze: (anomaly, cardId) => void stream.send(t('chat.freezePrompt', {
      transactionId: anomaly.transaction.id, merchant: anomaly.transaction.merchant, cardId,
    })),
    onTaskControl: (a, planId) => void stream.controlTask(a, planId),
    onRecover: (id) => void stream.recover(id),
    mfaAttempts: stream.mfaAttempts,
    busy: stream.busy,
    error: localizedError,
  };

  const hasConversation = visibleMessages.length > 0 || stream.streamingText.length > 0;
  const isEmpty =
    !hasConversation &&
    pending === undefined &&
    stream.activePlan === undefined &&
    stream.pendingReconciliations.length === 0;

  return (
    <div className={`flex min-h-0 min-w-0 flex-col bg-banking-light [container-type:size] ${className ?? ''}`.trim()}>
      <div ref={listRef} onScroll={() => {
        const list = listRef.current;
        if (list) {
          const latest = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
          followLatestRef.current = latest; setFollowingLatest(latest);
          if (latest) setHasNewMessages(false);
        }
      }} data-chat-scroll="true" className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] px-3 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-6xl space-y-6">
        {stream.history?.hasMore && <div className="flex flex-col items-center gap-2" data-history-controls="true">
          <button type="button" data-load-history="true" disabled={stream.loadingHistory || stream.historyError === 'chat.history.changed'}
            onClick={() => void loadEarlier()} className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-banking-navy disabled:opacity-50">
            {t(stream.loadingHistory ? 'chat.history.loading' : stream.historyError === 'chat.history.failed' ? 'chat.history.retry' : 'chat.history.loadEarlier')}
          </button>
          {stream.historyError && <p role="alert" className="text-center text-sm text-banking-danger">{t(stream.historyError)}</p>}
        </div>}
        {stream.history && !stream.history.hasMore && visibleMessages.length > 0 && <p data-history-complete="true" className="text-center text-xs text-banking-navy/70">{t('chat.history.complete')}</p>}
        <ChatErrorFeedback message={stream.error} code={stream.errorCode} showNotice={!pending} />
        {isEmpty && stream.restoring ? (
          <div role="status" className="flex flex-col items-center justify-center gap-3 py-16">
            <Spinner />
            <p className="text-sm text-banking-navy">{t('chat.restoring')}</p>
          </div>
        ) : isEmpty ? (
          <ChatWelcome disabled={stream.busy || stream.restoring} onSelect={content => setDraft({ content })} />
        ) : (
          <>
            {visibleMessages.map((m, index) => {
              const day = messageDay(m.timestamp);
              const startsDay = day !== undefined && (index === 0 || day !== messageDay(visibleMessages[index - 1].timestamp));
              return <Fragment key={m.id}>
                {startsDay ? <MessageDayDivider day={day} /> : null}
                <MessageBubble message={m} action={action} />
              </Fragment>;
            })}
            {stream.busy && (
              <div role="status" aria-label={t('chat.responding')} className="max-w-[min(88%,52rem)] rounded-2xl border border-slate-200/80 bg-white px-5 py-4 sm:ml-12">
                <StreamingText text={stream.streamingText} active phase={stream.replyPhase} />
              </div>
            )}
            {detachedPlan !== undefined && (
              <PlanCard plan={detachedPlan} onControl={a => action.onTaskControl?.(a, detachedPlan.id)} busy={stream.busy} />
            )}
            {stream.pendingReconciliations.map((r) => (
              <ReconciliationCard
                key={r.actionId}
                action={r.summary}
                actionId={r.actionId}
                attention={r.attention}
                onRecover={action.onRecover}
                busy={stream.busy}
                error={localizedError}
              />
            ))}
          </>
        )}
        </div>
      </div>

      <div data-chat-composer-dock="true" className="shrink-0 border-t border-slate-200/60 bg-banking-light px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pt-4">
        <div className="mx-auto w-full max-w-6xl">
        {!followingLatest && !pending && <button type="button" data-chat-latest="true" onClick={showLatest}
          className="mb-3 min-h-11 rounded-xl border border-banking-accent/30 bg-white px-4 py-2 text-sm font-medium text-banking-accent">
          {t(hasNewMessages ? 'chat.history.newMessages' : 'chat.history.latest')}
        </button>}
        {retryRequest && !pending && stream.pendingReconciliations.length === 0 && (
          <button type="button" disabled={stream.busy || stream.restoring}
            className="mb-3 rounded-xl border border-banking-accent/30 bg-white px-3 py-2 text-sm text-banking-accent disabled:opacity-50"
            onClick={() => send(retryRequest)}>{t('chat.retryPlanning')}</button>
        )}
        {pending && <ApprovalRequest key={pending.actionId} pending={pending} action={action} busy={stream.busy}
          error={localizedError} attempts={stream.mfaAttempts} maxAttempts={MFA_MAX_ATTEMPTS} />}
        <Composer onSend={send} draft={draft} busy={stream.busy} disabled={stream.restoring} className={pending ? '[&_textarea]:max-h-16' : undefined} />
        {!pending && <p className="mt-2.5 text-center text-[11px] leading-4 text-banking-navy/80">{t('chat.composer.help')}</p>}
        </div>
      </div>
    </div>
  );
}

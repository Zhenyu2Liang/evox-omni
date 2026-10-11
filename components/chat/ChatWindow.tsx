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
 * Two surfaces are driven by hook STATE (not by inline cards):
 *  - the LIVE plan (`stream.activePlan`) rendered via `PlanCard`, so node statuses advance as
 *    `plan_update` events arrive;
 *  - the active human decision (`stream.pendingAction`) rendered via `ConfirmationCard` (YELLOW) or
 *    `MfaCard` (RED). When the agent ALSO emitted a matching inline `confirmation`/`mfa` card, that
 *    duplicate is suppressed so exactly ONE human-decision card is visible for the active action.
 *
 * `taskId` (optional) enables refresh recovery: the hook re-fetches that plan (or the last-seen plan
 * id remembered in `sessionStorage`) so a reloaded page restores the live plan.
 */
import { useEffect, useRef } from 'react';
import type { ChatCard, ChatMessage } from '@/lib/contracts/agent';
import type { ChatEndpoints } from './actions';
import type { CardActionHandlers } from './cards';
import type { PendingHumanDecision } from './useAgentStream';
import { useAgentStream } from './useAgentStream';
import { decisionKey } from './decisionKey';
import { asTerminalStatus } from './cards/confirmationStatus';
import { ConfirmationCard, MfaCard, PlanCard, ReconciliationCard } from './cards';
import { MessageBubble } from './MessageBubble';
import { StreamingText } from './StreamingText';
import { ToolEventList } from './ToolEventList';
import { Composer } from './Composer';
import { EmptyState, Spinner } from '../ui';

export interface ChatWindowProps {
  sessionId?: string;
  initialMessages?: ChatMessage[];
  endpoints?: ChatEndpoints;
  /** Plan id to recover on mount (refresh recovery); defaults to the last-seen plan id. */
  taskId?: string;
  className?: string;
}

/** Does an inline card already represent the SAME active decision as the pending action? */
function isDuplicateDecisionCard(card: ChatCard, pending: PendingHumanDecision): boolean {
  if (card.type === 'mfa' && pending.kind === 'mfa') {
    return card.actionId === pending.actionId;
  }
  if (card.type === 'confirmation' && pending.kind === 'confirmation') {
    return decisionKey(card.action) === decisionKey(pending.summary);
  }
  return false;
}

/**
 * Drop the inline `confirmation`/`mfa` card that duplicates the active pending action (it is
 * rendered ONCE, from `stream.pendingAction`). A message left empty by the removal is dropped too,
 * so no empty bubble appears; unrelated/older decision cards are preserved.
 */
function withoutDuplicateDecisionCard(
  messages: ChatMessage[],
  pending: PendingHumanDecision,
): ChatMessage[] {
  let changed = false;
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const cards = message.cards ?? [];
    const kept = cards.filter((card) => !isDuplicateDecisionCard(card, pending));
    if (kept.length === cards.length) {
      result.push(message);
      continue;
    }
    changed = true;
    const emptied =
      message.content.length === 0 && kept.length === 0 && (message.toolEvents?.length ?? 0) === 0;
    if (!emptied) result.push({ ...message, cards: kept });
  }
  return changed ? result : messages;
}

interface PendingDecisionCardProps {
  pending: PendingHumanDecision;
  action: CardActionHandlers;
  busy?: boolean;
  error?: string;
  /** Failed MFA attempts for the active decision (shown on the MFA card). */
  attempts?: number;
}

/** The ONE active human-decision card: confirm/verify/cancel all POST to the `./app` routes. */
function PendingDecisionCard({ pending, action, busy, error, attempts }: PendingDecisionCardProps) {
  if (pending.kind === 'confirmation') {
    const runtime = pending.summary as unknown as { status?: unknown; message?: unknown };
    return (
      <ConfirmationCard
        action={pending.summary}
        actionId={pending.actionId}
        onConfirm={action.onConfirm}
        onCancel={action.onCancel}
        busy={busy}
        error={error}
        status={asTerminalStatus(runtime.status)}
        statusMessage={typeof runtime.message === 'string' ? runtime.message : undefined}
      />
    );
  }

  const { actionId, hint } = pending;
  return (
    <MfaCard
      actionId={actionId}
      action={pending.summary}
      hint={hint}
      onSubmit={(code) => action.onVerify?.(actionId, code)}
      onCancel={action.onCancel}
      busy={busy}
      error={error}
      attempts={attempts}
    />
  );
}

export function ChatWindow({
  sessionId,
  initialMessages,
  endpoints,
  taskId,
  className,
}: ChatWindowProps) {
  const stream = useAgentStream({ sessionId, initialMessages, endpoints, taskId });
  const listRef = useRef<HTMLDivElement>(null);

  const pending = stream.pendingAction;
  const visibleMessages = pending
    ? withoutDuplicateDecisionCard(stream.messages, pending)
    : stream.messages;

  const lastMessageId =
    visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1].id : undefined;

  // Auto-scroll the list to the bottom as new content arrives.
  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastMessageId, stream.streamingText, pending, stream.activePlan, stream.pendingReconciliations]);

  const action: CardActionHandlers = {
    actionId: pending?.actionId,
    onConfirm: (id) => void stream.confirm(id),
    onVerify: (id, code) => void stream.verify(id, code),
    onCancel: (id) => void stream.cancel(id),
    onFreeze: (anomaly, cardId) => void stream.send(`交易 ${anomaly.transaction.id}（${anomaly.transaction.merchant}）触发安全提醒。我选择冻结卡片 ${cardId}，请生成确认卡。`),
    onTaskControl: (a) => void stream.controlTask(a),
    onRecover: (id) => void stream.recover(id),
    mfaAttempts: stream.mfaAttempts,
    busy: stream.busy,
    error: stream.error,
  };

  const hasConversation = visibleMessages.length > 0 || stream.streamingText.length > 0;
  const isEmpty =
    !hasConversation &&
    pending === undefined &&
    stream.activePlan === undefined &&
    stream.pendingReconciliations.length === 0;

  return (
    <div className={`flex h-full min-h-0 flex-col bg-banking-light ${className ?? ''}`.trim()}>
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {stream.error && !pending ? <p role="alert" className="text-banking-danger">{stream.error}</p> : null}
        {isEmpty && stream.restoring ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10">
            <Spinner />
            <p className="text-sm text-banking-navy/60">正在恢复会话状态…</p>
          </div>
        ) : isEmpty ? (
          <EmptyState
            title="开始与 AI 银行助手对话"
            description="用自然语言描述你的需求，例如「查一下我的余额」或「给张伟转账 200 元」。"
          />
        ) : (
          <>
            {visibleMessages.map((m) => (
              <MessageBubble key={m.id} message={m} action={action} />
            ))}
            {stream.streamingText.length > 0 && (
              <StreamingText text={stream.streamingText} active={stream.busy} />
            )}
            {stream.activePlan !== undefined && (
              <PlanCard plan={stream.activePlan} onControl={action.onTaskControl} busy={stream.busy} />
            )}
            {pending !== undefined && (
              <PendingDecisionCard
                pending={pending}
                action={action}
                busy={stream.busy}
                error={stream.error}
                attempts={stream.mfaAttempts}
              />
            )}
            {stream.pendingReconciliations.map((r) => (
              <ReconciliationCard
                key={r.actionId}
                action={r.summary}
                actionId={r.actionId}
                attention={r.attention}
                onRecover={action.onRecover}
                busy={stream.busy}
                error={stream.error}
              />
            ))}
          </>
        )}
      </div>

      {stream.toolEvents.length > 0 && (
        <div className="border-t border-banking-light bg-white/70 px-4 py-3">
          <ToolEventList events={stream.toolEvents} />
        </div>
      )}

      <div className="border-t border-banking-light bg-white p-3">
        <Composer onSend={stream.send} busy={stream.busy} disabled={stream.busy} />
      </div>
    </div>
  );
}

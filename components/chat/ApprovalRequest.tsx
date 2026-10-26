'use client';

import { useEffect, useRef } from 'react';
import type { CardActionHandlers } from './cards';
import { ConfirmationCard, MfaCard } from './cards';
import type { PendingHumanDecision } from './useAgentStream';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { ApprovalProgress } from './cards/ApprovalProgress';

/** The sole actionable permission surface, outside the scrollable transcript. */
export function ApprovalRequest({ pending, action, busy, error, attempts, maxAttempts }: {
  pending: PendingHumanDecision;
  action: CardActionHandlers;
  busy?: boolean;
  error?: string;
  attempts?: number;
  maxAttempts?: number;
}) {
  const { t } = useI18n();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [pending.actionId, pending.kind]);
  return <section ref={panel} tabIndex={-1} aria-label={t(pending.kind === 'mfa' ? 'chat.approval.verification' : 'chat.approval.confirmation')}
    data-approval-request="true" data-action-id={pending.actionId} data-kind={pending.kind}
    className="mb-3 flex max-h-[min(45cqh,28rem)] flex-col overflow-hidden rounded-2xl border border-banking-accent/25 bg-white p-2 shadow-lg shadow-banking-deep/10 outline-hidden focus-visible:ring-2 focus-visible:ring-banking-accent">
    <div className="shrink-0 px-1 pb-2 [@media(max-height:600px)]:hidden">
      <ApprovalProgress status={pending.kind === 'mfa' ? 'awaiting_mfa' : 'pending'} requiresMfa={pending.summary.requiresMfa} />
    </div>
    {pending.kind === 'confirmation' ? <ConfirmationCard
      action={pending.summary} actionId={pending.actionId} onConfirm={action.onConfirm} onCancel={action.onCancel} busy={busy} error={error}
    /> : <MfaCard key={pending.actionId} actionId={pending.actionId} action={pending.summary} hint={pending.hint ?? pending.summary.mfaHint}
      status={pending.status} statusMessage={pending.statusMessage}
      onSubmit={code => action.onVerify?.(pending.actionId, code)} onCancel={action.onCancel} busy={busy} error={error} attempts={attempts} maxAttempts={maxAttempts} />}
  </section>;
}

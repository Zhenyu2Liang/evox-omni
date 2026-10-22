'use client';

import Link from 'next/link';
import type { PendingActionStatus, PendingActionSummary } from '@/lib/contracts/security';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { localizeActionTitle } from '@/lib/i18n/display';
import { publicToolError } from '@/lib/tool-feedback';
import { securityNotice } from '@/lib/public-text';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';
import { Badge } from '../../ui';
import type { MessageKey } from '@/lib/i18n/shared';
import { ActionDetails } from './ActionDetails';

const STATUS_KEYS: Record<PendingActionStatus, MessageKey> = {
  pending: 'chat.approval.status.pending',
  awaiting_mfa: 'chat.approval.status.awaiting_mfa',
  confirmed: 'chat.approval.status.confirmed',
  executed: 'chat.approval.status.executed',
  failed: 'chat.approval.status.failed',
  cancelled: 'chat.approval.status.cancelled',
  locked: 'chat.approval.status.locked',
  needs_reconciliation: 'chat.approval.status.needs_reconciliation',
};

/**
 * The typed facts of a LOCKED verification — the same derivation `MfaCard` uses, so the restored
 * history record explains the lock exactly like the live card does. The reason comes from the STATUS
 * through `lib/public-text`; the raw `message` stays developer-only.
 */
const LOCKED_NOTICE = { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted' } as const;

export interface ApprovalRecordProps {
  action?: Omit<PendingActionSummary, 'toolName'>;
  actionId?: string;
  verification?: boolean;
  status?: unknown;
  message?: string;
  className?: string;
}

/** A read-only state transition. Permission controls exist exclusively in the request dock. */
export function ApprovalRecord({ action, actionId, verification = false, status, message, className }: ApprovalRecordProps) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
  const initial = verification || action?.requiresMfa ? 'awaiting_mfa' : 'pending';
  const current = typeof status === 'string' && Object.hasOwn(STATUS_KEYS, status) ? status as PendingActionStatus : initial;
  const tone = current === 'executed' ? 'success' : ['failed', 'locked'].includes(current) ? 'danger'
    : current === 'cancelled' ? 'neutral' : 'warn';
  return <section data-approval-history="true" data-action-id={actionId} data-status={current}
    className={`overflow-hidden rounded-xl border border-slate-200 bg-white ${className ?? ''}`}>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <h3 className="text-sm font-semibold text-banking-deep">{action ? localizeActionTitle(action.title, t) : t('chat.approval.verification')}</h3>
      <Badge tone={tone}>{t(STATUS_KEYS[current])}</Badge>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-xs">
      <div data-approval-stage="previous" data-stage-status={initial} className="text-banking-navy/70">
        <span className="mr-1.5">{t('chat.approval.previous')}</span>{t(STATUS_KEYS[initial])}
      </div>
      <span aria-hidden="true" className="text-slate-400">→</span>
      <div role="status" data-approval-stage="current" data-stage-status={current} className="font-medium text-banking-deep">
        <span className="mr-1.5 font-normal text-banking-navy/70">{t('chat.approval.current')}</span>{t(STATUS_KEYS[current])}
      </div>
    </div>
    {action && (action.fields.length > 0 || action.amount !== undefined) ? <details className="border-t border-slate-100 px-4 py-3">
      <summary className="cursor-pointer text-xs font-medium text-banking-navy">{t('chat.approval.details')}</summary>
      <div className="mt-3"><ActionDetails action={action} /></div>
    </details> : null}
    {current === 'failed' ? <p className="px-4 pb-3 text-sm text-banking-danger">{publicToolError(message, t)}</p> : null}
    {current === 'locked' ? <div className="flex flex-col items-start gap-1 px-4 pb-3" data-approval-locked="true">
      <p className="text-sm text-banking-danger">{securityNotice(LOCKED_NOTICE, t)}</p>
      <p className="text-xs text-banking-navy/70">{t('pages.security.unlockDescription')}</p>
      <Link href="/security" className="text-sm text-banking-accent underline">{t('pages.security.title')}</Link>
    </div> : null}
    {current === 'needs_reconciliation' ? <p className="px-4 pb-3 text-sm text-banking-navy">{t('cards.terminal.reconciliationExplanation')}</p> : null}
    {developerMode && message ? <details className="px-4 pb-3 text-xs text-banking-navy">
      <summary>{t('chat.diagnostics.detail')}</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words">{String(sanitizeToolArguments(message))}</pre>
    </details> : null}
  </section>;
}

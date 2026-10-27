'use client';

import { useI18n } from '@/lib/i18n/LocaleProvider';

/** Progress reports the current server state; it does not assert that consent was already given. */
export function ApprovalProgress({ status, requiresMfa }: { status: string; requiresMfa: boolean }) {
  const { t } = useI18n();
  const terminal = !['pending', 'awaiting_mfa', 'confirmed'].includes(status);
  const current = terminal || status === 'confirmed' ? 2 : status === 'awaiting_mfa' ? 1 : 0;
  const keys = ['business.presentation.checkDetails', 'business.presentation.verifyIdentity', 'business.presentation.result'] as const;
  return <ol data-approval-progress data-current-step={current + 1} className="grid grid-cols-3 gap-2 text-xs">
    {keys.map((key, index) => <li key={key} aria-current={index === current ? 'step' : undefined}
      className={`flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-2 ${index === current ? 'bg-banking-neutral font-semibold text-banking-interactive' : 'text-banking-navy'}`}>
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-current">{index + 1}</span>
      <span>{t(index === 1 && !requiresMfa ? 'business.presentation.noVerification' : key)}</span>
    </li>)}
  </ol>;
}

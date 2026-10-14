import type { ActivityRecord, ActivityStatus } from '@/lib/contracts/activity';
import { Badge, EmptyState } from '@/components';
import { formatDateTime } from '@/lib/date';
import type { Translator } from '@/lib/i18n/shared';

const STATUS_TONES: Record<ActivityStatus, 'info' | 'warn' | 'success' | 'danger' | 'neutral'> = {
  processing: 'info', blocked: 'danger', awaiting_confirmation: 'warn', awaiting_verification: 'warn',
  completed: 'success', incomplete: 'danger', cancelled: 'neutral', locked: 'danger', needs_review: 'warn',
};

/** Render only the closed business projection, including on narrow screens. */
export function ActivityHistory({ entries, t }: { entries: ActivityRecord[]; t: Translator }) {
  if (entries.length === 0) return <EmptyState title={t('pages.activity.emptyTitle')} description={t('pages.activity.emptyDescription')} />;
  return <ol className="space-y-3" data-operation-history="true">{entries.map(entry => <li key={entry.id} className="rounded-2xl border border-banking-light bg-white p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 className="font-semibold text-banking-deep">{t(`pages.activity.type.${entry.type}`)}</h2>
      <Badge tone={STATUS_TONES[entry.status]}>{t(`pages.activity.status.${entry.status}`)}</Badge>
    </div>
    <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-banking-navy">{t('pages.activity.column.time')}</dt><dd className="mt-1 text-gray-700"><time dateTime={new Date(entry.timestamp).toISOString()}>{formatDateTime(entry.timestamp)}</time></dd></div>
      <div><dt className="text-banking-navy">{t('pages.activity.column.verification')}</dt><dd className="mt-1 text-gray-700">{t(`pages.activity.verification.${entry.verification}`)}</dd></div>
    </dl>
  </li>)}</ol>;
}

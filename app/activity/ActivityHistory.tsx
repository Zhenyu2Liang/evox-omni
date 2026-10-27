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
  return <ol className="divide-y divide-banking-border/70 overflow-hidden rounded-2xl border border-banking-border bg-banking-surface" data-operation-history="true">{entries.map(entry => <li key={entry.id} data-operation-row className="px-4 py-3 sm:px-5">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h2 className="text-sm font-semibold text-banking-deep">{t(`pages.activity.type.${entry.type}`)}</h2>
      <Badge tone={STATUS_TONES[entry.status]}>{t(`pages.activity.status.${entry.status}`)}</Badge>
    </div>
    <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-banking-caption text-banking-navy">
      <div className="flex flex-wrap items-baseline gap-x-2"><dt>{t('pages.activity.column.time')}</dt><dd><time dateTime={new Date(entry.timestamp).toISOString()}>{formatDateTime(entry.timestamp)}</time></dd></div>
      <div className="flex flex-wrap items-baseline gap-x-2"><dt>{t('pages.activity.column.verification')}</dt><dd>{t(`pages.activity.verification.${entry.verification}`)}</dd></div>
    </dl>
  </li>)}</ol>;
}

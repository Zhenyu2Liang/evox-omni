'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import type { SecurityEvent } from '@/lib/contracts/audit';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';

export interface SecurityEventListProps {
  events: SecurityEvent[];
  emptyText?: ReactNode;
  className?: string;
}

const SEVERITY_TONE: Record<SecurityEvent['severity'], 'success' | 'warn' | 'danger'> = {
  high: 'danger',
  medium: 'warn',
  low: 'success',
};

const SEVERITY_LABEL: Record<SecurityEvent['severity'], MessageKey> = {
  high: 'security.events.high',
  medium: 'security.events.medium',
  low: 'security.events.low',
};

function formatTimestamp(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale);
}

export function SecurityEventList({ events, emptyText, className }: SecurityEventListProps) {
  const { t, locale } = useI18n();
  const rootClassName = ['space-y-3', className].filter(Boolean).join(' ');

  if (events.length === 0) {
    if (emptyText != null) {
      return <div className={rootClassName}>{emptyText}</div>;
    }
    return (
      <EmptyState
        className={rootClassName}
        title={t('security.events.empty')}
        description={t('security.events.emptyDescription')}
      />
    );
  }

  return (
    <ul className={rootClassName}>
      {events.map((event, index) => (
        <li
          key={event.id ?? index}
          data-security-event-kind={event.kind}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Badge tone={SEVERITY_TONE[event.severity]}>{t(SEVERITY_LABEL[event.severity])}</Badge>
              <span className="text-sm font-medium text-banking-deep">{t(`security.events.kind.${event.kind}`)}</span>
            </div>
            <time className="text-xs text-slate-500">{formatTimestamp(event.timestamp, locale)}</time>
          </div>
          <p className="mt-2 text-sm leading-5 text-slate-600">{event.message}</p>
        </li>
      ))}
    </ul>
  );
}

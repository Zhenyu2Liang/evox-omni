'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import { isInternalDiagnostic } from '@/lib/public-text';
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

/**
 * The renderable body of one event: its audit prose, or the structured `kind` label when the
 * message is empty or an internal diagnostic. `lib/public-text.ts` owns the diagnostic predicate —
 * this module never cleans strings itself, so a `__SECURITY_BLOCK__` payload, raw JSON or a stack
 * trace can never reach the DOM.
 */
function publicMessage(message: string | undefined, kindLabel: string): string {
  if (typeof message !== 'string') return kindLabel;
  return message.trim() !== '' && !isInternalDiagnostic(message) ? message : kindLabel;
}

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
      {events.map((event, index) => {
        const kindLabel = t(`security.events.kind.${event.kind}`);
        return (
          <li
            key={event.id ?? index}
            data-security-event-kind={event.kind}
            className="rounded-xl border border-banking-border bg-white p-4 shadow-xs"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Badge tone={SEVERITY_TONE[event.severity]}>{t(SEVERITY_LABEL[event.severity])}</Badge>
                <span className="text-sm font-medium text-banking-deep">{kindLabel}</span>
              </div>
              <time className="text-xs text-banking-navy">{formatTimestamp(event.timestamp, locale)}</time>
            </div>
            <p className="mt-2 text-sm leading-5 text-banking-navy">{publicMessage(event.message, kindLabel)}</p>
          </li>
        );
      })}
    </ul>
  );
}

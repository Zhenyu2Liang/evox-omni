'use client';

import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface CircuitBreakerStatusProps {
  tripped: boolean;
  failureCount?: number;
  maxAttempts?: number;
  className?: string;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function CircuitBreakerStatus({
  tripped,
  failureCount = 0,
  maxAttempts = MFA_MAX_ATTEMPTS,
  className,
}: CircuitBreakerStatusProps) {
  const { t } = useI18n();
  const safeMaxAttempts = maxAttempts > 0 ? maxAttempts : 0;
  const ratio = safeMaxAttempts > 0 ? clampRatio(failureCount / safeMaxAttempts) : 0;

  const dotClass = tripped ? 'bg-banking-danger' : 'bg-banking-success';
  const labelClass = tripped ? 'text-banking-danger' : 'text-banking-success';
  const barClass = tripped
    ? 'bg-banking-danger'
    : failureCount > 0
      ? 'bg-banking-warn'
      : 'bg-banking-success';

  return (
    <div
      className={[
        'rounded-2xl border bg-banking-surface p-5 shadow-xs',
        tripped ? 'border-banking-danger/40' : 'border-banking-border',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass}`} aria-hidden />
          <span className={`text-sm font-semibold ${labelClass}`}>
            {t(tripped ? 'security.breaker.locked' : 'security.breaker.normal')}
          </span>
        </div>
        <span className="text-banking-caption text-banking-navy">{t('security.breaker.title')}</span>
      </div>

      <p className="mt-2 text-sm leading-5 text-banking-navy">
        {t(tripped ? 'security.breaker.lockedDescription' : 'security.breaker.normalDescription')}
      </p>

      <div className="mt-4">
        <div className="flex items-center justify-between text-banking-caption text-banking-navy">
          <span>{t('security.breaker.failures')}</span>
          <span>
            {t('security.breaker.failureCount', { count: failureCount, max: safeMaxAttempts })}
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-banking-light">
          <div
            className={`h-full rounded-full transition-all ${barClass}`}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}

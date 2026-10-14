'use client';

/**
 * AnomalyBanner — read-model banner: suspicious-spend banner; optional action callbacks.
 *
 * Localized presentational component: the action callbacks are supplied by an ancestor
 * Client Component and simply invoked here; a button is only rendered when its callback is given.
 */
import type { AnomalyItem, AnomalySeverity } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';

export interface AnomalyBannerProps {
  anomaly: AnomalyItem;
  onAcknowledge?: () => void;
  onViewDetail?: () => void;
  onFreeze?: () => void;
  className?: string;
}

/** Severity → badge tone + human label (never a permission tier; that is `ui/StatusBadge`). */
const SEVERITY_META: Record<AnomalySeverity, { tone: BadgeProps['tone']; label: MessageKey }> = {
  low: { tone: 'warn', label: 'business.anomalies.low' },
  medium: { tone: 'warn', label: 'business.anomalies.medium' },
  high: { tone: 'danger', label: 'business.anomalies.high' },
};

/** Left accent colour reflecting how severe the flagged spend is. */
const SEVERITY_ACCENT: Record<AnomalySeverity, string> = {
  low: 'border-l-4 border-banking-warn',
  medium: 'border-l-4 border-banking-warn',
  high: 'border-l-4 border-banking-danger',
};

export function AnomalyBanner(props: AnomalyBannerProps) {
  const { t } = useI18n();
  const { anomaly, onAcknowledge, onViewDetail, onFreeze, className } = props;
  const { transaction, reason, severity } = anomaly;
  const meta = SEVERITY_META[severity];

  const rootCls = ['shadow-xs', SEVERITY_ACCENT[severity], className]
    .filter(Boolean)
    .join(' ');

  const title = (
    <span className="flex items-center gap-2">
      <span>{t('business.anomalies.title')}</span>
      <Badge tone={meta.tone}>{t(meta.label)}</Badge>
    </span>
  );

  return (
    <Card className={rootCls} title={title} description={reason}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-medium text-banking-deep">{transaction.merchant}</span>
        <Money amount={transaction.amount} signed />
        <span className="text-gray-500">{formatDateTime(transaction.occurredAt)}</span>
      </div>

      {(onAcknowledge || onViewDetail || onFreeze) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {onAcknowledge && (
            <Button variant="secondary" size="sm" onClick={onAcknowledge}>
              {t('business.anomalies.acknowledge')}
            </Button>
          )}
          {onViewDetail && (
            <Button variant="ghost" size="sm" onClick={onViewDetail}>
              {t('business.anomalies.details')}
            </Button>
          )}
          {onFreeze && (
            <Button variant="danger" size="sm" onClick={onFreeze}>
              {t('business.anomalies.freeze')}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

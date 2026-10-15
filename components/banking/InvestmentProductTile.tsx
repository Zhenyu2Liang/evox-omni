'use client';

/**
 * InvestmentProductTile — read-model tile: a product / holding (risk level, expected rate, term, amount).
 *
 * Localized presentational component with no data access — the
 * `ProductView` / optional `HoldingView` DTOs arrive via props. Booked money uses `ui/Money`;
 * estimates use `ui/DecimalMoney`. Risk levels use `ui/Badge` independently of permission tiers.
 */
import type { HoldingView, ProductView } from '@/banking-sdk';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import { DecimalMoney } from '../ui/DecimalMoney';
import { rateRatioToPercent } from '@/lib/decimal';
import { formatDateTime } from '@/lib/date';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';

export interface InvestmentProductTileProps {
  product: ProductView;
  holding?: HoldingView;
  className?: string;
}

/** Risk level → badge tone (lower risk = calmer colour). */
const RISK_TONE: Record<ProductView['riskLevel'], NonNullable<BadgeProps['tone']>> = {
  R1: 'success',
  R2: 'success',
  R3: 'warn',
  R4: 'danger',
  R5: 'danger',
};

/** Risk level translation keys. */
const RISK_LABEL: Record<ProductView['riskLevel'], MessageKey> = {
  R1: 'business.investments.risk.R1',
  R2: 'business.investments.risk.R2',
  R3: 'business.investments.risk.R3',
  R4: 'business.investments.risk.R4',
  R5: 'business.investments.risk.R5',
};

/** Formats a dimensionless annual yield ratio as a percentage for display. */
function formatRate(rate: string): string {
  return `${rateRatioToPercent(rate)}%`;
}

export function InvestmentProductTile({ product, holding, className }: InvestmentProductTileProps) {
  const { t } = useI18n();
  const cls = ['space-y-3', className].filter(Boolean).join(' ');
  // Recorded purchases are aggregation purchases (oldest → newest); `lastPurchaseAt` is the most
  // recent of them. `holding.amount` is the REMAINING booked principal after any partial
  // redemption, so the principal / market value / profit rows below already show the remainder.
  const purchases = holding?.purchases ?? [];
  const lastPurchaseAt = holding?.lastPurchaseAt
    ?? (purchases.length > 0 ? purchases[purchases.length - 1].at : undefined);

  return (
    <Card className={cls}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="font-medium text-banking-navy">{product.name}</div>
          <div className="text-xs text-banking-navy/60">{product.code}</div>
        </div>
        <Badge tone={RISK_TONE[product.riskLevel]}>
          {product.riskLevel} · {t(RISK_LABEL[product.riskLevel])}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-xs text-banking-navy/60">{t('business.investments.yield')}</div>
          <div className="text-sm font-semibold text-banking-success">
            {formatRate(product.annualYieldRate)}
          </div>
        </div>
        <div>
          <div className="text-xs text-banking-navy/60">{t('business.investments.term')}</div>
          <div className="text-sm font-semibold text-banking-deep">{t('business.investments.days', { count: product.termDays })}</div>
        </div>
        <div>
          <div className="text-xs text-banking-navy/60">{t('business.investments.minimum')}</div>
          <div className="text-sm font-semibold text-banking-deep">
            <Money amount={product.minAmount} />
          </div>
        </div>
      </div>

      {product.description ? (
        <p className="text-xs text-banking-navy/60">{product.description}</p>
      ) : null}

      {holding ? (
        <div className="space-y-1 border-t border-banking-light pt-2">
          <div className="text-xs text-banking-navy/60">{t('business.investments.holdings')}</div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-banking-navy/60">{t('business.investments.principal')}</span>
            <span className="font-medium text-banking-deep">
              <Money amount={holding.amount} />
            </span>
          </div>
          {holding.marketValue !== undefined ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-banking-navy/60">{t('business.investments.marketValue')}</span>
              <span className="font-medium text-banking-deep">
                <DecimalMoney amount={holding.marketValue} />
              </span>
            </div>
          ) : null}
          {holding.profit !== undefined ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-banking-navy/60">{t('business.investments.profit')}</span>
              <span className="font-medium text-banking-deep">
                <DecimalMoney amount={holding.profit} signed />
              </span>
            </div>
          ) : null}
          {lastPurchaseAt !== undefined ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-banking-navy/60">{t('business.investments.lastPurchase')}</span>
              <span className="text-banking-deep">{formatDateTime(lastPurchaseAt)}</span>
            </div>
          ) : null}
          {purchases.length > 0 ? (
            <div className="text-xs text-banking-navy/60">
              {t('business.investments.purchases')} · {t('business.investments.purchaseCount', { count: purchases.length })}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

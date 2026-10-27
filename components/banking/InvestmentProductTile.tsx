'use client';

/**
 * InvestmentProductTile — read-model tile: a product / holding (risk level, expected rate, term, amount).
 *
 * Localized presentational component with no data access — the
 * `ProductView` / optional `HoldingView` DTOs arrive via props. Booked money uses `ui/Money`;
 * estimates use `ui/DecimalMoney`. Risk levels use `ui/Badge` independently of permission tiers.
 * The holding block shows the 净值 + 份额 facts through `HoldingFacts`, so the tile and the chat card
 * report exactly the same SDK-derived values.
 */
import type { HoldingView, ProductView } from '@/banking-sdk';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import { rateRatioToPercent } from '@/lib/decimal';
import { formatDateTime } from '@/lib/date';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import { HoldingFacts, usesNetValueModel, valueBasisLabelKey } from './HoldingFacts';

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
  // recent of them. `holding.amount` is the REMAINING booked cost after any partial redemption, and
  // the 净值 + 份额 facts below are rendered from the SDK's derived values (never recomputed here).
  const purchases = holding?.purchases ?? [];
  const lastPurchaseAt = holding?.lastPurchaseAt
    ?? (purchases.length > 0 ? purchases[purchases.length - 1].at : undefined);
  const basisKey = holding === undefined ? undefined : valueBasisLabelKey(holding);

  return (
    <Card className={cls}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="font-medium text-banking-deep">{product.name}</div>
          <div className="inline-flex rounded-md bg-banking-lilac-soft px-2 py-0.5 text-xs text-banking-lilac">{product.code}</div>
        </div>
        <Badge tone={RISK_TONE[product.riskLevel]}>
          {product.riskLevel} · {t(RISK_LABEL[product.riskLevel])}
        </Badge>
      </div>

      {!holding ? <div className="grid grid-cols-3 gap-3">
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
      </div> : null}

      {!holding && product.description ? (
        <p className="text-xs text-banking-navy/60">{product.description}</p>
      ) : null}

      {holding ? (
        <div className="space-y-1 border-t border-banking-light pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-banking-navy/60">{t('business.investments.holdings')}</span>
            {basisKey !== undefined ? (
              <Badge tone={holding.valueBasis === 'HISTORICAL_DATA_INSUFFICIENT' ? 'warn' : 'info'}>
                {t(basisKey)}
              </Badge>
            ) : null}
          </div>
          {!usesNetValueModel(holding) ? <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-banking-navy/60">{t('business.investments.principal')}</span>
            <span className="font-medium text-banking-deep">
              <Money amount={holding.amount} />
            </span>
          </div> : null}
          <HoldingFacts holding={holding} layout="tile" section="summary" />
          <details data-holding-details className="mt-3 border-t border-banking-light pt-3">
            <summary className="cursor-pointer text-sm font-medium text-banking-interactive hover:text-banking-accent">{t('business.presentation.holdingDetails')}</summary>
            <div className="mt-3 space-y-2">
          <HoldingFacts holding={holding} layout="tile" section="details" />
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
          {purchases.length ? <ul className="space-y-1 text-xs text-banking-navy/70">{purchases.map((purchase, index) => <li key={index} className="flex flex-wrap justify-between gap-2"><span>{formatDateTime(purchase.at)}</span><Money amount={purchase.amount} /></li>)}</ul> : null}
          <p className="text-xs text-banking-navy/60">{t('business.investments.yield')} {formatRate(product.annualYieldRate)} · {t('business.investments.days', { count: product.termDays })}</p>
          </div></details>
          <p className="text-xs leading-relaxed text-banking-navy/60">
            {usesNetValueModel(holding) ? `${t('business.investments.profitScope')} ` : null}
            {t('business.investments.disclaimer')}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

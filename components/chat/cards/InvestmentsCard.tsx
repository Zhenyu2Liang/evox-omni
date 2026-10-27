'use client';

import type { HoldingView, ProductView } from '@/banking-sdk';
import { Badge, EmptyState, Money } from '../../ui';
import type { BadgeProps } from '../../ui/Badge';
import type { InvestmentsCardData } from './types';
import { addMoney } from '@/lib/money';
import { addDecimal, rateRatioToPercent } from '@/lib/decimal';
import { formatDateTime } from '@/lib/date';
import { DecimalMoney } from '../../ui/DecimalMoney';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import { HoldingFacts, usesNetValueModel, valueBasisLabelKey } from '../../banking/HoldingFacts';
import { ResultCard, ResultMetric } from './ResultCard';

export interface InvestmentsCardProps {
  data: InvestmentsCardData;
  className?: string;
}

/** One tile worth of data: a product descriptor paired with its holding (when held). */
interface TileEntry {
  key: string;
  product: ProductView;
  holding?: HoldingView;
}

/**
 * Pair each holding with its complete product metadata, then include unheld catalogue products.
 */
function buildEntries(data: InvestmentsCardData): TileEntry[] {
  const holdings = data.holdings ?? [];
  const entries: TileEntry[] = [];
  const products = new Map((data.products ?? []).map(product => [product.id, product]));
  const seen = new Set(holdings.map(holding => holding.productId));
  for (const holding of holdings) {
    if (!holding.product) throw new Error('Investment holding product metadata is missing.');
    const product = products.get(holding.productId) ?? holding.product;
    entries.push({ key: `holding-${holding.id}`, product, holding });
  }
  for (const product of data.products ?? []) {
    if (!seen.has(product.id)) entries.push({ key: product.id, product });
  }

  return entries;
}

const RISK_TONE: Record<ProductView['riskLevel'], NonNullable<BadgeProps['tone']>> = {
  R1: 'success', R2: 'success', R3: 'warn', R4: 'danger', R5: 'danger',
};
const RISK_LABEL: Record<ProductView['riskLevel'], MessageKey> = {
  R1: 'business.investments.risk.R1', R2: 'business.investments.risk.R2', R3: 'business.investments.risk.R3',
  R4: 'business.investments.risk.R4', R5: 'business.investments.risk.R5',
};

/** Product facts and holding estimates remain distinct from booked settlement values. */
function InvestmentResult({ product, holding }: { product: ProductView; holding?: HoldingView }) {
  const { t } = useI18n();
  // Recorded purchases are aggregation purchases (oldest → newest): a non-empty list means the
  // cost was topped up on an existing holding; `lastPurchaseAt` is the most recent of them.
  const purchases = holding?.purchases ?? [];
  const addedToExisting = purchases.length > 0;
  const lastPurchaseAt = holding?.lastPurchaseAt
    ?? (addedToExisting ? purchases[purchases.length - 1].at : undefined);
  const basisKey = holding === undefined ? undefined : valueBasisLabelKey(holding);
  return (
    <div data-investment-card="true" data-investment-holding-id={holding?.id ?? undefined} className="min-w-0 rounded-xl border border-banking-light bg-slate-50/60 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="break-words text-sm font-semibold text-banking-deep">{product.name}</div>
          <div className="mt-0.5 text-xs text-banking-navy/60">{product.code}</div>
        </div>
        <Badge tone={RISK_TONE[product.riskLevel]}>{product.riskLevel} · {t(RISK_LABEL[product.riskLevel])}</Badge>
      </div>
      {!holding ? <dl className="mt-3 grid gap-2 sm:grid-cols-3">
        <ResultMetric label={t('business.investments.yield')}><span className="text-banking-success">{rateRatioToPercent(product.annualYieldRate)}%</span></ResultMetric>
        <ResultMetric label={t('business.investments.term')}>{t('business.investments.days', { count: product.termDays })}</ResultMetric>
        <ResultMetric label={t('business.investments.minimum')}><Money amount={product.minAmount} /></ResultMetric>
      </dl> : null}
      {!holding && product.description ? <p className="mt-3 text-xs leading-relaxed text-banking-navy/60">{product.description}</p> : null}
      {holding ? (
        <div className="mt-3 border-t border-banking-light pt-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-banking-navy">{t('business.investments.holdings')}</span>
            <div className="flex flex-wrap items-center gap-2">
              {addedToExisting ? <Badge tone="success">{t('business.investments.addedToExisting')}</Badge> : null}
              {basisKey !== undefined ? (
                <Badge tone={holding.valueBasis === 'HISTORICAL_DATA_INSUFFICIENT' ? 'warn' : 'info'}>{t(basisKey)}</Badge>
              ) : null}
              <Badge tone={holding.status === 'HOLDING' ? 'info' : 'neutral'}>{t(holding.status === 'HOLDING' ? 'business.investments.holdingActive' : 'business.investments.holdingRedeemed')}</Badge>
            </div>
          </div>
          <dl className="space-y-2 text-xs">
            <HoldingFacts holding={holding} layout="card" section="summary" />
          </dl>
          <details data-holding-details className="mt-3 border-t border-banking-light pt-3">
            <summary className="cursor-pointer text-xs font-medium text-banking-interactive hover:text-banking-accent">{t('business.presentation.holdingDetails')}</summary>
          <dl className="mt-3 space-y-2 text-xs">
            {!usesNetValueModel(holding) ? <div className="flex flex-wrap justify-between gap-2"><dt>{t('business.investments.principal')}</dt><dd><Money amount={holding.amount} /></dd></div> : null}
            <HoldingFacts holding={holding} layout="card" section="details" />
            {lastPurchaseAt !== undefined ? <div className="flex flex-wrap justify-between gap-2"><dt className="text-banking-navy/60">{t('business.investments.lastPurchase')}</dt><dd className="font-medium text-banking-deep">{formatDateTime(lastPurchaseAt)}</dd></div> : null}
            {addedToExisting ? <div className="flex flex-wrap justify-between gap-2"><dt className="text-banking-navy/60">{t('business.investments.purchases')}</dt><dd className="font-medium text-banking-deep">{t('business.investments.purchaseCount', { count: purchases.length })}</dd></div> : null}
          </dl>
          {purchases.length ? <ul className="mt-3 space-y-1 text-xs text-banking-navy/70">{purchases.map((purchase, index) => <li key={index} className="flex flex-wrap justify-between gap-2"><span>{formatDateTime(purchase.at)}</span><Money amount={purchase.amount} /></li>)}</ul> : null}
          <p className="mt-3 text-xs text-banking-navy/60">{t('business.investments.yield')} {rateRatioToPercent(product.annualYieldRate)}% · {t('business.investments.days', { count: product.termDays })}</p>
          </details>
        </div>
      ) : null}
    </div>
  );
}

export function InvestmentsCard(p: InvestmentsCardProps) {
  const { t } = useI18n();
  const entries = buildEntries(p.data);
  const comparison = p.data.comparison;
  const comparisonProducts = comparison?.products ?? [];
  const holdings = (p.data.holdings ?? []).filter(holding => holding.status === 'HOLDING');
  const className = p.className ? `flex flex-col gap-3 ${p.className}` : 'flex flex-col gap-3';

  if (entries.length === 0 && comparisonProducts.length === 0) {
    return (
      <div className={className}>
        <ResultCard title={t('cards.investment.title')} marker="↗">
          <EmptyState title={t('cards.investment.empty.title')} description={t('cards.investment.empty.description')} />
        </ResultCard>
      </div>
    );
  }

  const investedAmount = holdings.reduce((sum, holding) => addMoney(sum, holding.amount), '0.00');
  const hasMarketValue = holdings.length > 0 && holdings.every((holding) => holding.marketValue !== undefined);
  const totalMarketValue = holdings.reduce((sum, holding) => addDecimal(sum, holding.marketValue ?? '0'), '0');
  const hasProfit = holdings.length > 0 && holdings.every((holding) => holding.profit !== undefined);
  const totalProfit = holdings.reduce((sum, holding) => addDecimal(sum, holding.profit ?? '0'), '0');
  // The return definitions only describe a holding the SDK actually valued by shares × net value.
  const heldEntries = entries.filter((entry): entry is TileEntry & { holding: HoldingView } => entry.holding !== undefined);
  const showReturnDefinitions = heldEntries.length > 0 && heldEntries.every(entry => usesNetValueModel(entry.holding));

  return (
    <div className={className}>
      {entries.length > 0 ? (
        <ResultCard title={t('cards.investment.title')} marker="↗">
          {holdings.length > 0 ? (
            <dl className="mb-3 grid gap-2 sm:grid-cols-3">
              <ResultMetric label={t('cards.investment.amount')}><Money amount={investedAmount} /></ResultMetric>
              {hasMarketValue ? (
                <ResultMetric label={t('cards.investment.marketValue')}><DecimalMoney amount={totalMarketValue} /></ResultMetric>
              ) : null}
              {hasProfit ? (
                <ResultMetric label={t('cards.investment.profit')}><DecimalMoney amount={totalProfit} signed /></ResultMetric>
              ) : null}
            </dl>
          ) : null}
          <div className="flex flex-col gap-3">
            {entries.map((entry) => (
              <InvestmentResult
                key={entry.key}
                product={entry.product}
                holding={entry.holding}
              />
            ))}
          </div>
          {showReturnDefinitions ? (
            <p className="mt-3 text-xs leading-relaxed text-banking-navy/60">
              {t('business.investments.profitScope')} {t('business.investments.disclaimer')}
            </p>
          ) : null}
        </ResultCard>
      ) : null}

      {comparisonProducts.length > 0 ? (
        <ResultCard title={t('cards.investment.compare')} marker="⇄">
          <div className="flex flex-col gap-3">
            {comparisonProducts.map((product) => {
              const isHighestRate = product.id === comparison?.highestRateId;
              const isLowestRisk = product.id === comparison?.lowestRiskId;
              return (
                <div key={product.id} className="flex flex-col gap-1">
                  {isHighestRate || isLowestRisk ? (
                    <div className="flex items-center gap-2">
                      {isHighestRate ? <Badge tone="success">{t('cards.investment.highestYield')}</Badge> : null}
                      {isLowestRisk ? <Badge tone="info">{t('cards.investment.lowestRisk')}</Badge> : null}
                    </div>
                  ) : null}
                  <InvestmentResult product={product} />
                </div>
              );
            })}
          </div>
        </ResultCard>
      ) : null}
    </div>
  );
}

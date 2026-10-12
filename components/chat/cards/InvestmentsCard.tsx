'use client';

import type { HoldingView, ProductView } from '@/banking-sdk';
import { InvestmentProductTile } from '../../banking';
import { Badge, Card, EmptyState, Money } from '../../ui';
import type { InvestmentsCardData } from './types';

export interface InvestmentsCardProps {
  data: InvestmentsCardData;
  className?: string;
}

/** One tile worth of data: a product descriptor paired with its holding (when held). */
interface TileEntry {
  key: string;
  product: ProductView;
  holding?: HoldingView;
  metadataKnown?: boolean;
}

/**
 * Minimal product descriptor for a holding whose product was not supplied in `data.products`, so the
 * holding can still be rendered through `InvestmentProductTile`. Only the identity fields are known
 * (name / risk level); product-only metadata defaults to `0`.
 */
function productFromHolding(h: HoldingView): ProductView {
  return {
    id: h.productId,
    code: h.productId,
    name: h.productName,
    riskLevel: h.riskLevel,
    expectedRate: 0,
    termDays: 0,
    minAmount: 0,
  };
}

/**
 * Build one entry per product, pairing each with its holding by `productId`; holdings whose product
 * is absent from `data.products` still get an entry (with a product derived from the holding).
 */
function buildEntries(data: InvestmentsCardData): TileEntry[] {
  const holdings = data.holdings ?? [];
  const entries: TileEntry[] = [];
  const products = new Map((data.products ?? []).map(product => [product.id, product]));
  const seen = new Set(holdings.map(holding => holding.productId));
  for (const holding of holdings) {
    const product = products.get(holding.productId) ?? holding.product;
    entries.push({ key: `holding-${holding.id}`, product: product ?? productFromHolding(holding), holding, metadataKnown: product !== undefined });
  }
  for (const product of data.products ?? []) {
    if (!seen.has(product.id)) entries.push({ key: product.id, product });
  }

  return entries;
}

/**
 * Chat card: investment products, the user's holdings, and an optional product comparison. Products
 * and holdings are rendered by the `banking` read-model `InvestmentProductTile` (never re-implemented
 * here); the comparison highlights the highest-rate / lowest-risk products via `ui/Badge`.
 */
export function InvestmentsCard(p: InvestmentsCardProps) {
  const entries = buildEntries(p.data);
  const comparison = p.data.comparison;
  const comparisonProducts = comparison?.products ?? [];
  const holdings = p.data.holdings ?? [];
  const className = p.className ? `flex flex-col gap-3 ${p.className}` : 'flex flex-col gap-3';

  if (entries.length === 0 && comparisonProducts.length === 0) {
    return (
      <div className={className}>
        <Card title="我的投资">
          <EmptyState title="暂无投资" description="当前没有可展示的投资产品或持仓。" />
        </Card>
      </div>
    );
  }

  const investedAmount = holdings.reduce((sum, h) => sum + h.amount, 0);
  const hasMarketValue = holdings.some((h) => h.marketValue !== undefined);
  const totalMarketValue = holdings.reduce((sum, h) => sum + (h.marketValue ?? h.amount), 0);
  const hasProfit = holdings.some((h) => h.profit !== undefined);
  const totalProfit = holdings.reduce((sum, h) => sum + (h.profit ?? 0), 0);

  return (
    <div className={className}>
      {entries.length > 0 ? (
        <Card title="我的投资">
          {holdings.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-banking-navy">
              <span>
                持仓金额 <Money amount={investedAmount} />
              </span>
              {hasMarketValue ? (
                <span>
                  持仓市值 <Money amount={totalMarketValue} />
                </span>
              ) : null}
              {hasProfit ? (
                <span>
                  累计收益 <Money amount={totalProfit} signed />
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-3">
            {entries.map((entry) => (
              <InvestmentProductTile
                key={entry.key}
                product={entry.product}
                holding={entry.holding}
                metadataKnown={entry.metadataKnown}
              />
            ))}
          </div>
        </Card>
      ) : null}

      {comparisonProducts.length > 0 ? (
        <Card title="产品对比">
          <div className="flex flex-col gap-3">
            {comparisonProducts.map((product) => {
              const isHighestRate = product.id === comparison?.highestRateId;
              const isLowestRisk = product.id === comparison?.lowestRiskId;
              return (
                <div key={product.id} className="flex flex-col gap-1">
                  {isHighestRate || isLowestRisk ? (
                    <div className="flex items-center gap-2">
                      {isHighestRate ? <Badge tone="success">最高收益</Badge> : null}
                      {isLowestRisk ? <Badge tone="info">最低风险</Badge> : null}
                    </div>
                  ) : null}
                  <InvestmentProductTile product={product} />
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

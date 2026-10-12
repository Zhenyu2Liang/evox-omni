/**
 * InvestmentProductTile — read-model tile: a product / holding (risk level, expected rate, term, amount).
 *
 * Server-safe presentational component: no `'use client'`, no hooks, no data access — the
 * `ProductView` / optional `HoldingView` DTOs arrive via props. Money renders only through
 * `ui/Money`; the investment risk level uses `ui/Badge` (non-permission-tier status).
 */
import type { HoldingView, ProductView } from '@/banking-sdk';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';

export interface InvestmentProductTileProps {
  product: ProductView;
  holding?: HoldingView;
  className?: string;
  metadataKnown?: boolean;
}

/** Risk level → badge tone (lower risk = calmer colour). */
const RISK_TONE: Record<ProductView['riskLevel'], NonNullable<BadgeProps['tone']>> = {
  R1: 'success',
  R2: 'success',
  R3: 'warn',
  R4: 'danger',
  R5: 'danger',
};

/** Risk level → descriptive Chinese label. */
const RISK_LABEL: Record<ProductView['riskLevel'], string> = {
  R1: '保守型',
  R2: '稳健型',
  R3: '平衡型',
  R4: '进取型',
  R5: '高风险',
};

/** Formats an annual percentage rate, e.g. `3.25` → `3.25%` (rates are not money). */
function formatRate(rate: number): string {
  return `${rate.toFixed(2)}%`;
}

export function InvestmentProductTile({ product, holding, className, metadataKnown = true }: InvestmentProductTileProps) {
  const cls = ['space-y-3', className].filter(Boolean).join(' ');

  return (
    <Card className={cls}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="font-medium text-banking-navy">{product.name}</div>
          <div className="text-xs text-banking-navy/60">{product.code}</div>
        </div>
        <Badge tone={RISK_TONE[product.riskLevel]}>
          {product.riskLevel} · {RISK_LABEL[product.riskLevel]}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-xs text-banking-navy/60">预期年化</div>
          <div className="text-sm font-semibold text-banking-success">
            {metadataKnown ? formatRate(product.expectedRate) : '待核对'}
          </div>
        </div>
        <div>
          <div className="text-xs text-banking-navy/60">期限</div>
          <div className="text-sm font-semibold text-banking-deep">{metadataKnown ? `${product.termDays} 天` : '待核对'}</div>
        </div>
        <div>
          <div className="text-xs text-banking-navy/60">起购</div>
          <div className="text-sm font-semibold text-banking-deep">
            {metadataKnown ? <Money amount={product.minAmount} /> : '待核对'}
          </div>
        </div>
      </div>

      {product.description ? (
        <p className="text-xs text-banking-navy/60">{product.description}</p>
      ) : null}

      {holding ? (
        <div className="space-y-1 border-t border-banking-light pt-2">
          <div className="text-xs text-banking-navy/60">我的持仓</div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-banking-navy/60">持有金额</span>
            <span className="font-medium text-banking-deep">
              <Money amount={holding.amount} />
            </span>
          </div>
          {holding.marketValue !== undefined ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-banking-navy/60">市值</span>
              <span className="font-medium text-banking-deep">
                <Money amount={holding.marketValue} />
              </span>
            </div>
          ) : null}
          {holding.profit !== undefined ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-banking-navy/60">收益</span>
              <span className="font-medium text-banking-deep">
                <Money amount={holding.profit} signed />
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

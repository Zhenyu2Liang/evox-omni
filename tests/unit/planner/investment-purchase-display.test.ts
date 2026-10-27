import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HoldingPurchase, HoldingView, ProductView } from '@/banking-sdk';
import { InvestmentProductTile } from '@/components/banking/InvestmentProductTile';
import { InvestmentsCard } from '@/components/chat/cards/InvestmentsCard';
import { LocaleProvider } from '@/lib/i18n/LocaleProvider';
import { translate } from '@/lib/i18n/shared';
import { formatDateTime } from '@/lib/date';
import { formatCNY } from '@/lib/money';
import { formatDecimalCNY } from '@/lib/decimal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// Business-zone (UTC+08:00) instants: the first purchase on 2026-10-01 and the top-up on 2026-10-14.
const FIRST = Date.UTC(2026, 9, 1, 1, 30);
const SECOND = Date.UTC(2026, 9, 14, 1, 30);

const PRODUCT: ProductView = {
  id: 'product-1',
  code: 'P001',
  name: 'Stable Income 90',
  riskLevel: 'R2',
  annualYieldRate: '0.0325',
  termDays: 90,
  minAmount: '1000.00',
};

const TOP_UP: HoldingPurchase = {
  amount: '2000.00',
  at: SECOND,
  totalPrincipal: '3000.00',
  marketValue: '3123.4567',
  newBalance: '5000.00',
  sourceAccountId: 'acct-1',
  executionKey: 'exec-1',
};

/**
 * A partially-redeemed holding that was also topped up: `amount` is the REMAINING booked principal,
 * while `marketValue` / `profit` are unrounded estimates. `purchases` runs oldest -> newest.
 */
const HOLDING: HoldingView = {
  product: PRODUCT,
  id: 'holding-1',
  productId: PRODUCT.id,
  productName: PRODUCT.name,
  riskLevel: PRODUCT.riskLevel,
  amount: '3000.00',
  marketValue: '3123.4567',
  profit: '123.4567',
  boughtAt: FIRST,
  status: 'HOLDING',
  lastPurchaseAt: SECOND,
  purchases: [{ ...TOP_UP, amount: '1000.00', at: FIRST, totalPrincipal: '1000.00' }, TOP_UP],
};

/** The same holding without any recorded purchase history (no top-up). */
const SOLO: HoldingView = { ...HOLDING, purchases: undefined, lastPurchaseAt: undefined };

function renderZh(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { initialLocale: 'zh-CN', children: node }),
  );
}

function renderTile(holding?: HoldingView): string {
  return renderZh(createElement(InvestmentProductTile, { product: PRODUCT, holding }));
}

function renderCard(holding: HoldingView): string {
  return renderZh(
    createElement(InvestmentsCard, { data: { products: [PRODUCT], holdings: [holding] } }),
  );
}

describe('investment purchase display', () => {
  describe('InvestmentProductTile', () => {
    it('shows the REMAINING principal plus estimated market value and return for a partially-redeemed holding', () => {
      const markup = renderTile(HOLDING);
      expect(markup).toContain(translate('zh-CN', 'business.investments.principal'));
      expect(markup).toContain(translate('zh-CN', 'business.investments.marketValue'));
      expect(markup).toContain(translate('zh-CN', 'business.investments.profit'));
      expect(markup).toContain(formatCNY('3000.00'));
      expect(markup).toContain(formatDecimalCNY('3123.4567'));
      expect(markup).toContain(formatDecimalCNY('123.4567'));
    });

    it('shows the latest purchase time and the purchase count when history exists', () => {
      const markup = renderTile(HOLDING);
      expect(markup).toContain(translate('zh-CN', 'business.investments.lastPurchase'));
      expect(markup).toContain(formatDateTime(SECOND));
      expect(markup).toContain(translate('zh-CN', 'business.investments.purchases'));
      expect(markup).toContain(
        translate('zh-CN', 'business.investments.purchaseCount', { count: 2 }),
      );
      expect(markup).toContain(formatDateTime(FIRST));
      expect(markup).toContain('data-holding-details');
    });

    it('derives the latest purchase time from the recorded purchases when lastPurchaseAt is absent', () => {
      const markup = renderTile({ ...HOLDING, lastPurchaseAt: undefined });
      expect(markup).toContain(formatDateTime(SECOND));
    });

    it('omits every purchase row for a holding with no recorded history', () => {
      const markup = renderTile(SOLO);
      expect(markup).toContain(formatCNY('3000.00'));
      expect(markup).not.toContain(translate('zh-CN', 'business.investments.lastPurchase'));
      expect(markup).not.toContain(translate('zh-CN', 'business.investments.purchases'));
    });

    it('renders no holdings block when there is no holding', () => {
      const markup = renderTile(undefined);
      expect(markup).not.toContain(translate('zh-CN', 'business.investments.holdings'));
      expect(markup).not.toContain(translate('zh-CN', 'business.investments.lastPurchase'));
    });
  });

  describe('InvestmentsCard', () => {
    it('marks a purchase that added to an existing holding and surfaces its time and count', () => {
      const markup = renderCard(HOLDING);
      expect(markup).toContain(translate('zh-CN', 'business.investments.addedToExisting'));
      expect(markup).toContain(formatDateTime(SECOND));
      expect(markup).toContain(
        translate('zh-CN', 'business.investments.purchaseCount', { count: 2 }),
      );
    });

    it('keeps the existing holding entries and adds no top-up markers for a plain holding', () => {
      const markup = renderCard(SOLO);
      expect(markup).toContain(PRODUCT.name);
      expect(markup).toContain(formatCNY('3000.00'));
      expect(markup).toContain(translate('zh-CN', 'business.investments.holdings'));
      expect(markup).toContain(translate('zh-CN', 'business.investments.holdingActive'));
      expect(markup).not.toContain(translate('zh-CN', 'business.investments.addedToExisting'));
      expect(markup).not.toContain(translate('zh-CN', 'business.investments.lastPurchase'));
    });
  });
});

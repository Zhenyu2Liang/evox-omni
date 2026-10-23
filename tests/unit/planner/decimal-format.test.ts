import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HoldingView } from '@/banking-sdk';
import { DecimalMoney } from '@/components/ui/DecimalMoney';
import { HoldingFacts, type HoldingFactsLayout } from '@/components/banking/HoldingFacts';

/** Render exact decimal text through the real display component so assertions run on the markup. */
function render(amount: string, signed = false): string {
  return renderToStaticMarkup(createElement(DecimalMoney, { amount, signed }));
}

describe('formatDecimalCNY display rendering', () => {
  it('renders positive, negative and zero with exactly two fraction digits', () => {
    expect(render('4118.906666666666666667')).toContain('¥4,118.91');
    expect(render('-4118.906666666666666667')).toContain('-¥4,118.91');
    expect(render('0')).toContain('¥0.00');
  });

  it('rounds HALF_UP at the cent boundary instead of following binary float toFixed', () => {
    // Proof there is no float path here: in JavaScript (1.005).toFixed(2) === '1.00' and
    // (2.675).toFixed(2) === '2.67', while exact HALF_UP decimal rounding yields '1.01' and '2.68'.
    expect(render('1.005')).toContain('¥1.01');
    expect(render('2.675')).toContain('¥2.68');
  });

  it('rounds very long fractions without losing the carry into the next unit', () => {
    expect(render('0.999999999999999999')).toContain('¥1.00');
    expect(render('9.999999999999999999')).toContain('¥10.00');
  });

  it('keeps thousands separators for large exact values', () => {
    expect(render('1234567890123.456')).toContain('¥1,234,567,890,123.46');
    expect(render('90071992547409.930000001')).toContain('¥90,071,992,547,409.93');
  });

  it('prefixes + only for signed positive profits and keeps the loss sign', () => {
    expect(render('4118.906666666666666667')).toContain('¥4,118.91');
    expect(render('118.906666666666666667', true)).toContain('+¥118.91');
    expect(render('-118.906666666666666667', true)).toContain('-¥118.91');
  });
});

/** One SDK-shaped holding: 净值 + 份额, a loss of 49.20 on 4000.00 remaining cost. */
function holdingView(profitRate: string | undefined): HoldingView {
  return {
    id: 'holding-loss',
    productId: 'prod_wenjiana',
    productName: '稳健理财A',
    riskLevel: 'R1',
    amount: '4000.00',
    shares: '4199.864825',
    latestNetValue: '0.9407',
    latestNetValueDate: Date.parse('2026-01-15T00:00:00Z'),
    marketValue: '3950.80',
    profit: '-49.20',
    profitRate,
    cumulativeProfit: '-49.20',
    valueBasis: 'NET_VALUE',
    boughtAt: Date.parse('2025-12-01T00:00:00Z'),
    status: 'HOLDING',
    product: {
      id: 'prod_wenjiana', code: 'P001', name: '稳健理财A', riskLevel: 'R1',
      annualYieldRate: '0.0325', termDays: 90, minAmount: '1000.00',
    },
  };
}

function renderFacts(profitRate: string | undefined, layout: HoldingFactsLayout = 'card'): string {
  return renderToStaticMarkup(createElement(HoldingFacts, { holding: holdingView(profitRate), layout }));
}

describe('HoldingFacts signed 持仓收益率 rendering', () => {
  it('renders a losing holding as a negative percentage instead of throwing', () => {
    // Regression: the nonnegative gate threw `Financial value must be nonnegative.` while rendering a
    // loss, which unmounted the whole client tree (white page, no chat composer).
    expect(() => renderFacts('-0.0123')).not.toThrow();
    expect(renderFacts('-0.0123')).toContain('-1.23%');
  });

  it('keeps the existing text for a profitable or flat holding', () => {
    expect(renderFacts('0.032575')).toContain('3.2575%');
    expect(renderFacts('0')).toContain('0%');
  });

  it('keeps the loss sign at full SDK precision and for both layouts', () => {
    expect(renderFacts('-0.029726666666666667')).toContain('-2.9726666666666667%');
    expect(renderFacts('-0.0123', 'tile')).toContain('-1.23%');
    // The money facts of the same loss keep their existing signed rendering.
    expect(renderFacts('-0.0123')).toContain('-¥49.20');
  });

  it('renders the explicit insufficient-history text when no rate was derived', () => {
    expect(renderFacts(undefined)).not.toContain('%');
  });
});

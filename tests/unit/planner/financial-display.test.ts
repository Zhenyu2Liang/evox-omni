import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Money } from '@/components/ui/Money';
import { DecimalMoney } from '@/components/ui/DecimalMoney';
import { ChartTooltip } from '@/components/charts/chartTheme';
import { InvestmentsCard } from '@/components/chat/cards/InvestmentsCard';
import { decisionKey } from '@/components/chat/decisionKey';
import type { HoldingView } from '@/banking-sdk';

describe('exact financial presentation', () => {
  it('renders the maximum supported minor-unit amount without losing its last cent', () => {
    const markup = renderToStaticMarkup(createElement(Money, { amount: '92233720368547758.07', signed: true }));
    expect(markup).toContain('+');
    expect(markup).toContain('92,233,720,368,547,758.07');
  });

  it('renders an exact tooltip amount independently of the lossy chart coordinate', () => {
    const markup = renderToStaticMarkup(createElement(ChartTooltip, { active: true, payload: [{
      name: 'Spending', value: Number('92233720368547758.07'), payload: { amount: '92233720368547758.07' },
    }] }));
    expect(markup).toContain('92,233,720,368,547,758.07');
  });

  it('aggregates holdings exactly before rendering', () => {
    const holdings: HoldingView[] = ['first', 'second'].map(id => ({
      id, productId: id, productName: id, riskLevel: 'R1', amount: '45035996273704.51', boughtAt: 0, status: 'HOLDING',
      product: { id, code: id, name: id, riskLevel: 'R1', annualYieldRate: '0.032575', termDays: 30, minAmount: '100.00' },
    }));
    const markup = renderToStaticMarkup(createElement(InvestmentsCard, { data: { holdings } }));
    expect(markup).toContain('90,071,992,547,409.02');
  });

  it('preserves sub-cent valuations and yields beyond integer basis points', () => {
    const holdings: HoldingView[] = ['first', 'second'].map(id => ({
      id, productId: id, productName: id, riskLevel: 'R1', amount: '1000.00',
      marketValue: '1000.00456789', profit: '0.00456789', boughtAt: 0, status: 'HOLDING',
      product: { id, code: id, name: id, riskLevel: 'R1', annualYieldRate: '0.032575',
        termDays: 30, minAmount: '100.00' },
    }));
    const markup = renderToStaticMarkup(createElement(InvestmentsCard, { data: { holdings } }));
    expect(markup).toContain('3.2575%');
    expect(markup).toContain('2,000.00913578');
    expect(markup).toContain('+¥0.00913578');
    expect(markup).toContain('1,000.00456789');
  });

  it('shows the sign of tiny estimated returns without rounding them to zero', () => {
    const positive = renderToStaticMarkup(createElement(DecimalMoney, { amount: '0.0000000001', signed: true }));
    const negative = renderToStaticMarkup(createElement(DecimalMoney, { amount: '-0.0000000001', signed: true }));
    expect(positive).toContain('+¥0.0000000001');
    expect(negative).toContain('-¥0.0000000001');
  });

  it('keeps distinct cent amounts in confirmation identity beyond number precision', () => {
    const common = { title: 'Transfer', toolName: 'transfer_money' as const, tier: 'RED' as const,
      fields: [], requiresMfa: true };
    expect(decisionKey({ ...common, amount: '92233720368547758.06' }))
      .not.toBe(decisionKey({ ...common, amount: '92233720368547758.07' }));
  });
});

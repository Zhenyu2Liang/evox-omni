import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MiniSparkline, SpendingBar, SpendingPie, SpendingTrend } from '@/components/charts';
import { chartScale, chartTicks } from '@/components/charts/chartTheme';

describe('native financial charts', () => {
  it('renders the exact maximum axis cents and a HALF_UP-rounded midpoint label', () => {
    const amount = '92233720368547758.07';
    const bar = renderToStaticMarkup(createElement(SpendingBar, {
      data: [{ category: 'Spending', amount, share: '100.00' }],
    }));
    const trend = renderToStaticMarkup(createElement(SpendingTrend, {
      data: [{ month: '2026-10', amount }],
    }));
    for (const markup of [bar, trend]) {
      expect(markup).toMatch(/<text[^>]*>¥92,233,720,368,547,758\.07<\/text>/);
      expect(markup).toMatch(/<text[^>]*>¥46,116,860,184,273,879\.04<\/text>/);
      expect(markup).not.toContain('46,116,860,184,273,879.035');
      expect(markup).not.toContain('92,233,720,368,547,758.08');
    }
  });

  it('rounds negative fractional cents HALF_UP to two decimals in axis labels', () => {
    expect(chartTicks(['-0.07']).map(tick => tick.label)).toEqual(['-¥0.07', '-¥0.04', '¥0.00']);
    expect(chartTicks(['-0.02', '0.01']).map(tick => tick.label))
      .toEqual(['-¥0.02', '-¥0.01', '¥0.01']);
    const markup = renderToStaticMarkup(createElement(SpendingTrend, {
      data: [{ month: '2026-10', amount: '-0.07' }],
    }));
    expect(markup).toMatch(/<text[^>]*>-¥0\.04<\/text>/);
  });

  it('retains exact cents in accessible labels and legends despite lossy coordinates', () => {
    const data = [{ category: 'Spending', amount: '92233720368547758.07', share: '100.00' }];
    for (const Chart of [SpendingBar, SpendingPie]) {
      const markup = renderToStaticMarkup(createElement(Chart, { data }));
      expect(markup).toContain('92,233,720,368,547,758.07');
      expect(markup).not.toContain('NaN');
      expect(markup).toContain('tabindex="0"');
    }
  });

  it('renders a one-month trend and sparkline without invalid coordinates', () => {
    const trend = renderToStaticMarkup(createElement(SpendingTrend, {
      data: [{ month: '2026-10', amount: '123.45' }],
    }));
    const sparkline = renderToStaticMarkup(createElement(MiniSparkline, { data: ['123.45'] }));
    for (const markup of [trend, sparkline]) {
      expect(markup).toContain('123.45');
      expect(markup).toContain('<circle');
      expect(markup).not.toMatch(/NaN|Infinity/);
    }
  });

  it('plots refunds below a shared zero baseline and spending above it', () => {
    const scale = chartScale([-20, 100], 20, 184);
    expect(scale.y(-20)).toBeGreaterThan(scale.y(0));
    expect(scale.y(100)).toBeLessThan(scale.y(0));
    const markup = renderToStaticMarkup(createElement(SpendingBar, {
      data: [{ category: 'Refund', amount: '-20.00', share: '0.00' },
        { category: 'Spending', amount: '100.00', share: '100.00' }],
    }));
    expect(markup).toContain('-¥20.00');
    expect(markup).not.toMatch(/NaN|Infinity/);
  });

  it('shows a neutral placeholder for empty and all-zero data', () => {
    for (const data of [[], [{ category: 'Spending', amount: '0.00', share: '0.00' }]]) {
      const markup = renderToStaticMarkup(createElement(SpendingPie, { data }));
      expect(markup).toContain('role="img"');
      expect(markup).not.toContain('<svg');
    }
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecimalMoney } from '@/components/ui/DecimalMoney';

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

import { describe, expect, it } from 'vitest';
import {
  addDecimal, compareDecimal, decimalText, divideDecimal, formatDecimalCNY,
  multiplyDecimal, rateRatioToPercent, subtractDecimal, valuationToMinor,
} from '@/lib/decimal';
import {
  addMoney, centsToMoney, formatCNY, MAX_MINOR_UNITS,
  moneyToCents, normalizeMoney, normalizeTransferAmount, percentageRatio, subtractMoney,
} from '@/lib/money';

describe('exact financial values', () => {
  it('preserves cent arithmetic and decimal JSON above the JavaScript integer range', () => {
    expect(subtractMoney(subtractMoney('0.30', '0.10'), '0.20')).toBe('0.00');
    expect(addMoney('90071992547409.93', '0.01')).toBe('90071992547409.94');
    expect(moneyToCents('90071992547409.93')).toBe(9_007_199_254_740_993n);
    expect(JSON.stringify({ amount: centsToMoney(MAX_MINOR_UNITS) })).toBe('{"amount":"92233720368547758.07"}');
    const combined = addMoney(centsToMoney(MAX_MINOR_UNITS), centsToMoney(MAX_MINOR_UNITS));
    expect(combined).toBe('184467440737095516.14');
    expect(formatCNY(combined)).toBe('¥184,467,440,737,095,516.14');
  });

  it('rejects fractional cents and every binary numeric input', () => {
    for (const input of ['0.005', '999.995', '1e3', '', 0.29, 100, Number.NaN, Number.POSITIVE_INFINITY, 90_071_992_547_409.94]) {
      expect(() => moneyToCents(input)).toThrow();
    }
    expect(() => moneyToCents('92233720368547758.08')).toThrow();
    expect(() => normalizeTransferAmount('0.00')).toThrow();
    expect(() => normalizeTransferAmount(0.29)).toThrow();
    expect(normalizeTransferAmount('0.29')).toBe('0.29');
    expect(normalizeMoney('000.29')).toBe('0.29');
    expect(() => normalizeMoney('')).toThrow();
    expect(() => normalizeMoney(null as unknown as string)).toThrow();
    expect(() => normalizeMoney(undefined as unknown as string)).toThrow();
  });

  it('formats booked money and summary percentages without lossy conversions', () => {
    expect(formatCNY('90071992547409.93')).toBe('¥90,071,992,547,409.93');
    expect(formatCNY('-0.20')).toBe('-¥0.20');
    expect(percentageRatio(1n, 3n)).toBe('33.33');
    expect(percentageRatio(-1n, 8n)).toBe('-12.50');
  });

  it('compares decimal values across scales, signs and numeric boundary representations', () => {
    expect(compareDecimal('1000.01', '1000.00')).toBe(1);
    expect(compareDecimal('0.20', 0.2)).toBe(0);
    expect(compareDecimal('90071992547409.93', '90071992547409.92')).toBe(1);
    expect(compareDecimal('-1.20', '-1.19')).toBe(-1);
    expect(compareDecimal('1e-3', '0.001')).toBe(0);
    expect(() => compareDecimal(90_071_992_547_409.94, '90071992547409.94')).toThrow();
  });

  it('preserves precision for rates, valuations and arithmetic independently of cents', () => {
    expect(rateRatioToPercent('0.032575')).toBe('3.2575');
    expect(subtractDecimal('1000.019876543210123456', '1000.01')).toBe('0.009876543210123456');
    expect(addDecimal('90071992547409.930000000000000001', '0.000000000000000001'))
      .toBe('90071992547409.930000000000000002');
    expect(multiplyDecimal('123.456789', '1.234567')).toBe('152.415677625363');
    expect(divideDecimal('325', '10000')).toBe('0.0325');
    expect(() => divideDecimal('1', '3')).toThrow();
    expect(() => divideDecimal('1', '0')).toThrow();
  });

  it('normalizes and bounds decimals without truncation or binary arithmetic', () => {
    expect(decimalText('000.03257500')).toBe('0.032575');
    expect(decimalText('-0.000')).toBe('0');
    expect(decimalText('1e-18')).toBe('0.000000000000000001');
    expect(() => decimalText(0.032575 as unknown as string)).toThrow();
    expect(() => decimalText(325n as unknown as string)).toThrow();
    for (const value of ['1e-19', '1e40', 'Infinity', 'NaN', '1.0000000000000000001']) {
      expect(() => decimalText(value)).toThrow();
    }
    expect(formatDecimalCNY('90071992547409.930000001')).toBe('¥90,071,992,547,409.930000001');
    expect(formatDecimalCNY('-0.000001')).toBe('-¥0.000001');
  });

  it('applies the CNY settlement policy only at the booked-money boundary', () => {
    expect(valuationToMinor('0.004999999999999999')).toBe(0n);
    expect(valuationToMinor('0.005')).toBe(1n);
    expect(valuationToMinor('92233720368547758.074')).toBe(MAX_MINOR_UNITS);
    expect(() => valuationToMinor('92233720368547758.075')).toThrow();
    expect(() => valuationToMinor('-0.001')).toThrow();
    expect(() => moneyToCents('0.005')).toThrow();
  });

  it.each(['1e-9999999999999999', '1e99999999999999999999', '0e99999999999999999999'])
    ('rejects the unsupported exponent in %s before Decimal can underflow to zero', value => {
      expect(() => decimalText(value)).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    });

  it('normalizes supported values even when a long mantissa needs a larger exponent', () => {
    expect(decimalText(`0.${'0'.repeat(119)}1e129`)).toBe('1000000000');
    expect(decimalText(`1${'0'.repeat(111)}e-129`)).toBe('0.000000000000000001');
  });
});

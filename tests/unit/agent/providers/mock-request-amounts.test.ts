import { describe, expect, it } from 'vitest';
import { requestedMoneyAmounts, isMoneyAmountReply } from '@/agent/providers/mock/request-amounts';
import fixtures from '@/tests/fixtures/request-amounts.zh-CN.json';

describe('mock amount script parsing', () => {
  it.each(['-10', '−10', '－10', '-¥10', '￥-10'])('retains the signed script value %s', raw => {
    expect(isMoneyAmountReply(raw)).toBe(true);
    expect(requestedMoneyAmounts(raw)).toEqual([{ raw, value: '-10', negative: true, zero: false }]);
  });

  it('excludes dates and resource selectors from mock money candidates', () => {
    expect(requestedMoneyAmounts(fixtures.resourceRequests[1]).map(amount => amount.value)).toEqual(['200']);
    expect(requestedMoneyAmounts('2026-10-14')).toEqual([]);
  });

  it('preserves exact decimal and ten-thousand units in mock fixtures', () => {
    expect(requestedMoneyAmounts('-0.0001\u4e07\u5143')[0].value).toBe('-1');
    expect(requestedMoneyAmounts('-0.00001\u4e07\u5143')[0].value).toBe('-0.1');
  });
});

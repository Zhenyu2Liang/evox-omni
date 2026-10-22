import { describe, expect, it } from 'vitest';
import { classifyInvestmentAction } from './investment-intents';
import { contentToText } from './conversation';

function redeemCall(text: string): { name: string; arguments: Record<string, unknown> } {
  const message = classifyInvestmentAction(text);
  const call = message?.content.find(part => part.type === 'toolCall');
  if (!call) throw new Error(`Expected a tool proposal for "${text}".`);
  return { name: call.name, arguments: call.arguments as Record<string, unknown> };
}

describe('classifyInvestmentAction redemption口径', () => {
  it.each([
    ['赎回稳健理财A 100元', { holdingId: 'holding_wenjiana', mode: 'AMOUNT', amount: '100.00' }],
    ['赎回稳健理财A 2000元', { holdingId: 'holding_wenjiana', mode: 'AMOUNT', amount: '2000.00' }],
    ['部分赎回100元', { holdingId: 'holding_wenjiana', mode: 'AMOUNT', amount: '100.00' }],
    ['取出稳健理财B 50元', { holdingId: 'holding_wenjib', mode: 'AMOUNT', amount: '50.00' }],
    ['赎回稳健理财A 一百元', { holdingId: 'holding_wenjiana', mode: 'AMOUNT', amount: '100.00' }],
  ] as const)('redeems by amount for %s', (text, args) => {
    const call = redeemCall(text);
    expect(call.name).toBe('redeem_investment');
    expect(call.arguments).toEqual(args);
    expect(call.arguments.redeemAmount).toBeUndefined();
  });

  it.each([
    ['赎回稳健理财A 100份', { holdingId: 'holding_wenjiana', mode: 'SHARES', shares: '100.000000' }],
    ['部分赎回50.5份', { holdingId: 'holding_wenjiana', mode: 'SHARES', shares: '50.500000' }],
    ['赎回货币基金 0.25份', { holdingId: 'holding_huobi', mode: 'SHARES', shares: '0.250000' }],
  ] as const)('redeems by shares for %s', (text, args) => {
    const call = redeemCall(text);
    expect(call.name).toBe('redeem_investment');
    expect(call.arguments).toEqual(args);
    expect(call.arguments.redeemAmount).toBeUndefined();
  });

  it.each([
    ['赎回稳健理财A', 'holding_wenjiana'],
    ['把稳健理财A全部赎回', 'holding_wenjiana'],
    ['取出稳健理财B', 'holding_wenjib'],
    ['取出货币基金', 'holding_huobi'],
  ] as const)('redeems every share without an amount for %s', (text, holdingId) => {
    const call = redeemCall(text);
    expect(call.name).toBe('redeem_investment');
    expect(call.arguments).toEqual({ holdingId, mode: 'ALL' });
  });

  it.each(['赎回2000', '赎回稳健理财A 2000'])(
    'asks for the口径 instead of treating a bare number as principal: %s', text => {
      const message = classifyInvestmentAction(text);
      expect(message?.content.some(part => part.type === 'toolCall')).toBe(false);
      const reply = contentToText(message?.content ?? []);
      expect(reply).toContain('按金额');
      expect(reply).toContain('按份额');
    });
});

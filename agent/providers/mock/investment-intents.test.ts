import { describe, expect, it } from 'vitest';
import { classifyInvestmentAction } from './investment-intents';

function redeemCall(text: string): { name: string; arguments: Record<string, unknown> } {
  const message = classifyInvestmentAction(text);
  const call = message?.content.find(part => part.type === 'toolCall');
  if (!call) throw new Error(`Expected a tool proposal for "${text}".`);
  return { name: call.name, arguments: call.arguments as Record<string, unknown> };
}

describe('classifyInvestmentAction partial redemption', () => {
  it.each([
    ['赎回稳健理财A 100元', { holdingId: 'holding_wenjiana', redeemAmount: '100' }],
    ['部分赎回100元', { holdingId: 'holding_wenjiana', redeemAmount: '100' }],
    ['取出稳健理财B 50元', { holdingId: 'holding_wenjib', redeemAmount: '50' }],
    ['赎回稳健理财A 一百元', { holdingId: 'holding_wenjiana', redeemAmount: '100' }],
  ] as const)('emits the principal portion for %s', (text, args) => {
    const call = redeemCall(text);
    expect(call.name).toBe('redeem_investment');
    expect(call.arguments).toEqual(args);
  });

  it.each([
    ['赎回稳健理财A', 'holding_wenjiana'],
    ['取出稳健理财B', 'holding_wenjib'],
    ['取出货币基金', 'holding_huobi'],
  ] as const)('keeps full redemption without an amount for %s', (text, holdingId) => {
    const call = redeemCall(text);
    expect(call.name).toBe('redeem_investment');
    expect(call.arguments.redeemAmount).toBeUndefined();
    expect(call.arguments).toEqual({ holdingId });
  });
});

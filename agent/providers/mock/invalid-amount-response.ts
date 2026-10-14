import { requestedSteps } from './request-steps';
import { requestedMoneyAmounts } from './request-amounts';
import messages from '../../messages/dialogue.zh-CN.json';
import conversationMessages from '../../messages/conversation.zh-CN.json';

const LABELS = { transfer_money: 'transfer', subscribe_investment: 'purchase',
  reserve_budget: 'budget', set_card_limit: 'limit', redeem_investment: 'redemption' } as const;

/** Explain a validated input error using its original signed token, never inferred tool arguments. */
export function renderInvalidAmountResponse(request = ''): string {
  for (const step of requestedSteps(request)) {
    if (!Object.hasOwn(LABELS, step.tool)) continue;
    const invalid = requestedMoneyAmounts(step.span).find(value => value.negative || value.zero && step.tool !== 'set_card_limit');
    if (invalid) return messages.invalidAmount[LABELS[step.tool as keyof typeof LABELS]].replace('{amount}', invalid.raw.trim());
  }
  const invalid = requestedMoneyAmounts(request).find(value => value.negative || value.zero);
  return invalid ? messages.invalidAmount.generic.replace('{amount}', invalid.raw.trim()) : conversationMessages.invalid_amount;
}

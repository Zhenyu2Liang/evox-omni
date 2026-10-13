import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { parseAmountOnly } from './amount-parser';
import { assistantTextBefore, findLastUserIndex, userTextBefore } from './conversation';
import { resolveCardId, resolveLimitCategory } from './card-intents';
import { extractProductName, resolveProductId } from './investment-intents';
import { toolCall } from './replies';

/** An amount answer completes only this model's immediately preceding clarification. */
export function classifyActionFollowUp(text: string, messages: Message[]): AssistantMessage | undefined {
  const amount = parseAmountOnly(text);
  if (amount == null) return undefined;
  const userIndex = findLastUserIndex(messages);
  const priorReply = assistantTextBefore(messages, userIndex);
  if (!priorReply) return undefined;
  const priorUser = userTextBefore(messages, userIndex);
  if (priorReply.includes('要把限额调整到多少') && priorUser) {
    return toolCall('set_card_limit', { cardId: resolveCardId(priorUser), category: resolveLimitCategory(priorUser), amount });
  }
  if ((/要申购.*多少钱/.test(priorReply) || (priorReply.includes('请补充金额') && /(申购|认购|购买)/.test(priorUser ?? ''))) && priorUser) {
    const productName = extractProductName(priorUser);
    if (productName) return toolCall('subscribe_investment', { productId: resolveProductId(productName), amount });
  }
  return undefined;
}

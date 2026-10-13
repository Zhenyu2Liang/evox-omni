import type { AssistantMessage } from '@earendil-works/pi-ai';
import { parseAmount } from './amount-parser';
import { plain, toolCall } from './replies';

export const demoCreditCardId = 'card_credit';
export const cardLimitCategories = ['娱乐', '餐饮', '购物', '出行', '生活', '居家', '教育', '医疗', '通讯', '其他'];
export const defaultCardLimitCategory = '娱乐';
const adjustmentVerb = '调整到|调整为|调整成|调整至|调到|调成|改成|改为|设置为|设为|限额为|设定为|限定为|限制为';
const adjustmentIntent = /(调整|改成|改为|设置为|设为|调到|调成|限额为|设定为|限定为|限制为)/;
const adjustmentAmount = new RegExp(`(?:${adjustmentVerb})\\s*(\\d+(?:\\.\\d+)?)`);

/** A plan threshold and a new limit are distinct financial values. */
export function parseCardLimitAdjustment(text: string): { category: string; amount: string } | undefined {
  if (!/(限额|额度)/.test(text)) return undefined;
  const match = text.match(adjustmentAmount);
  if (!match) return undefined;
  return { category: resolveLimitCategory(text), amount: match[1] };
}

export function resolveLimitCategory(text: string): string {
  return cardLimitCategories.find(category => text.includes(category)) ?? defaultCardLimitCategory;
}

export function resolveCardId(text: string): string {
  return /借记卡|储蓄卡/.test(text) ? 'card_debit' : demoCreditCardId;
}

export function classifyCardAction(text: string): AssistantMessage | undefined {
  if (/(限额|额度)/.test(text) && adjustmentIntent.test(text)) {
    const amount = text.match(adjustmentAmount)?.[1] ?? parseAmount(text);
    if (amount == null) return plain('请问要把限额调整到多少？例如“把娱乐限额调整到1500”。');
    return toolCall('set_card_limit', { cardId: resolveCardId(text), category: resolveLimitCategory(text), amount });
  }
  if (!/冻结/.test(text) || /被冻结|已冻结/.test(text)) return undefined;
  if (!/卡/.test(text)) return plain('请问要冻结哪张卡？例如“冻结我的信用卡”。');
  return toolCall('freeze_card', { cardId: resolveCardId(text) });
}

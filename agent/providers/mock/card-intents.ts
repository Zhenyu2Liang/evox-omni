import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { parseAmount } from './amount-parser';
import { plain, toolCall } from './replies';
import { inferConversationGuidance } from './conversation-guidance';
import { mockResourceRows } from './resource-resolution';
import { findLastUserIndex } from './conversation';
import messagesText from './messages.zh-CN.json';

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

export function isBulkCardFreezeRequest(text: string): boolean {
  if (/\u5982\u679c|\u4ec5\u5f53|\u53ea\u6709|\bif\b/i.test(text)) return false;
  return /^(?:plan and )?freeze all my (?:bank )?cards[.!?]?$/i.test(text) ||
    /\u51bb\u7ed3/.test(text) && /(?:\u5168\u90e8|\u6240\u6709|\u4e24\u5f20)/.test(text) && /\u5361/.test(text);
}

export function classifyCardFreezePlan(text: string, messages: Message[] = []): AssistantMessage | undefined {
  if (!isBulkCardFreezeRequest(text)) return;
  const cards = mockResourceRows('card', messages, findLastUserIndex(messages));
  if (cards === undefined) return toolCall('get_cards', {});
  if (cards.length === 0) return plain(messagesText.noCardsAvailable);
  if (/\u4e24\u5f20/.test(text) && !/\u5168\u90e8|\u6240\u6709/.test(text) && cards.length !== 2) {
    return plain(messagesText.resourceSelectionRequired);
  }
  return toolCall('submit_plan', { goal: text, nodes: cards.map((card, index) => ({
    id: `freeze_${index + 1}`, name: `Freeze ${typeof card.type === 'string' ? card.type.toLowerCase() : 'bank'} card ${typeof card.numberMasked === 'string' ? card.numberMasked : index + 1}`,
    dependencies: [], kind: 'tool', tool: 'freeze_card', args: { cardId: card.id },
  })) });
}

export function classifyCardAction(text: string): AssistantMessage | undefined {
  if (inferConversationGuidance(text) === 'card_management_required') {
    return plain(JSON.stringify({ guidance: { code: 'card_management_required' } }));
  }
  // Virtual-card application is agent-available, so propose the capability instead of page-only guidance.
  if (/虚拟卡/.test(text) && /(?:申请|开办|办理|开通|创建|添加|新增|申领)/.test(text) ||
      /\bvirtual\s+card\b/i.test(text) && /\b(?:apply|create|add|issue|open|request|get)\b/i.test(text)) {
    return toolCall('apply_virtual_card', {});
  }
  if (/(限额|额度)/.test(text) && adjustmentIntent.test(text)) {
    const amount = text.match(adjustmentAmount)?.[1] ?? parseAmount(text);
    if (amount == null) return plain('请问要把限额调整到多少？例如“把娱乐限额调整到1500”。');
    return toolCall('set_card_limit', { cardId: resolveCardId(text), category: resolveLimitCategory(text), amount });
  }
  if (!/冻结/.test(text) || /被冻结|已冻结/.test(text)) return undefined;
  if (!/卡/.test(text)) return plain('请问要冻结哪张卡？例如“冻结我的信用卡”。');
  return toolCall('freeze_card', { cardId: resolveCardId(text) });
}

import { isConversationGuidanceCode, renderConversationGuidance, type ConversationGuidanceCode } from './guidance-messages';
import conversationMessages from './messages/conversation.zh-CN.json';

/** Model selects a closed code/field vocabulary; only these server-owned templates reach the UI. */
const MISSING_FIELDS = {
  recipient: '收款人（转给谁）', amount: '金额（多少钱）', source_account: '付款账户', card: '卡片类型或尾号',
  product: '理财产品', holding: '要处理的持仓', date: '完整日期与北京时间',
  reminder_content: '提醒内容', subscription: '订阅名称', limit_category: '消费限额分类',
} as const;
const CAPABILITY_MESSAGES = {
  product_selection_invalid: '未找到你指定的理财产品，或产品选择与请求不一致。请先查询产品列表，再明确准确名称或代码；不会自动替换成其他产品。',
  partial_redemption_unsupported: '本 Demo 只支持整笔持仓全额赎回，不支持部分赎回。本次未创建赎回授权。如需全额赎回，请明确说明；也可先查询持仓。',
  investment_funding_account_unsupported: '本 Demo 的理财申购仅支持活期账户，不能使用储蓄账户。本次未创建申购授权，也不会替你更换付款账户。如接受活期账户，请重新明确发起申购。',
  credit_line_adjustment_unsupported: '本 Demo 支持设置卡片的分类消费限额，不支持修改信用卡总授信额度。本次未创建额度调整授权。如需分类限额，请说明分类和金额。',
  capabilities: conversationMessages.capabilities,
} as const;
export type BankingGuidance =
  | { code: keyof typeof CAPABILITY_MESSAGES | ConversationGuidanceCode }
  | { code: 'missing_details' | 'ambiguous_selection'; fields: (keyof typeof MISSING_FIELDS)[] };
export type GuidanceField = keyof typeof MISSING_FIELDS;

/** Strict JSON only: arbitrary prose, amounts, success claims and extra keys are discarded. */
export function parseBankingGuidance(text: string): BankingGuidance | undefined {
  try {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const value: unknown = JSON.parse(fenced?.[1] ?? trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'guidance') return;
    const guidance = (value as { guidance: unknown }).guidance;
    if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) return;
    const record = guidance as Record<string, unknown>;
    if (typeof record.code !== 'string') return;
    if (Object.keys(record).some(key => key !== 'code' && key !== 'fields')) return;
    if (record.fields !== undefined && (!Array.isArray(record.fields) || record.fields.length > 4 ||
        !record.fields.every(field => typeof field === 'string' && Object.hasOwn(MISSING_FIELDS, field)))) return;
    // Models may attach a validated field list to a capability code; it never supplies template text.
    if (Object.hasOwn(CAPABILITY_MESSAGES, record.code) || isConversationGuidanceCode(record.code)) {
      return { code: record.code as keyof typeof CAPABILITY_MESSAGES | ConversationGuidanceCode };
    }
    if ((record.code !== 'missing_details' && record.code !== 'ambiguous_selection') ||
        Object.keys(record).length !== 2 || !Array.isArray(record.fields) ||
        record.fields.length === 0 || record.fields.length > 4 ||
        !record.fields.every(field => typeof field === 'string' && Object.hasOwn(MISSING_FIELDS, field))) return;
    return { code: record.code, fields: [...new Set(record.fields)] as (keyof typeof MISSING_FIELDS)[] };
  } catch { return; }
}

export function renderBankingGuidance(guidance: BankingGuidance): string {
  if ('fields' in guidance) {
    const fields = guidance.fields.map(field => MISSING_FIELDS[field]).join('、');
    return guidance.code === 'ambiguous_selection'
      ? `查询结果存在多个匹配，请明确选择${fields}；未创建操作授权。`
      : `请补充${fields}，再继续处理；未创建操作授权。`;
  }
  return isConversationGuidanceCode(guidance.code)
    ? renderConversationGuidance(guidance.code) : CAPABILITY_MESSAGES[guidance.code];
}

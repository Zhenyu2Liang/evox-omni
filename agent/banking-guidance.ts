import { moneyToCents } from '@/lib/money';

/** Model selects a closed code/field vocabulary; only these server-owned templates reach the UI. */
const MISSING_FIELDS = {
  recipient: '收款人（转给谁）', amount: '金额（多少钱）', source_account: '付款账户', card: '卡片类型或尾号',
  product: '理财产品', holding: '要处理的持仓', date: '完整日期与北京时间',
  reminder_content: '提醒内容', subscription: '订阅名称', limit_category: '消费限额分类',
} as const;
const CAPABILITY_MESSAGES = {
  partial_redemption_unsupported: '本 Demo 只支持整笔持仓全额赎回，不支持部分赎回。本次未创建赎回授权。如需全额赎回，请明确说明；也可先查询持仓。',
  investment_funding_account_unsupported: '本 Demo 的理财申购仅支持活期账户，不能使用储蓄账户。本次未创建申购授权，也不会替你更换付款账户。如接受活期账户，请重新明确发起申购。',
  credit_line_adjustment_unsupported: '本 Demo 支持设置卡片的分类消费限额，不支持修改信用卡总授信额度。本次未创建额度调整授权。如需分类限额，请说明分类和金额。',
  capabilities: '可查询余额、流水、消费分析和异常交易；可办理模拟转账、全额理财申购/赎回、卡片管理和订阅管理，也可创建预算及定时提醒记录。写操作按服务端权限要求确认或验证码；Demo 不接入真实资金或短信。',
} as const;
export type BankingGuidance =
  | { code: keyof typeof CAPABILITY_MESSAGES }
  | { code: 'missing_details' | 'ambiguous_selection'; fields: (keyof typeof MISSING_FIELDS)[] };
export type GuidanceField = keyof typeof MISSING_FIELDS;

/** Recognizes explicit user parameters, not model facts; never authorizes a banking operation. */
export function providedRequestFields(
  text: string,
  products: readonly { id: string; name: string; code: string }[],
): GuidanceField[] {
  const fields: GuidanceField[] = [];
  const named = products.filter(product => [product.id, product.name, product.code].some(name => text.includes(name)));
  if (named.length === 1) fields.push('product');
  const amounts = new Set<number>();
  for (const match of text.matchAll(/(?<![\d.+-])(?:[¥￥]\s*(\d+(?:\.\d+)?)(?![\d.])|(\d+(?:\.\d+)?)\s*元)/g)) {
    try {
      const cents = moneyToCents(match[1] ?? match[2]);
      if (cents > 0) amounts.add(cents);
    } catch { /* A fractional-cent/invalid amount is still missing a valid value. */ }
  }
  if (amounts.size === 1) fields.push('amount');
  return fields;
}

export function filterMissingFields(guidance: BankingGuidance | undefined, provided: readonly GuidanceField[]): BankingGuidance | undefined {
  if (guidance?.code !== 'missing_details') return guidance;
  const fields = guidance.fields.filter(field => !provided.includes(field));
  return fields.length ? { code: 'missing_details', fields } : undefined;
}

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
    if (Object.hasOwn(CAPABILITY_MESSAGES, record.code)) {
      return { code: record.code as keyof typeof CAPABILITY_MESSAGES };
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
  return CAPABILITY_MESSAGES[guidance.code];
}

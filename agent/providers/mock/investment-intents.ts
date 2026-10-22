import type { AssistantMessage } from '@earendil-works/pi-ai';
import { parseAmount } from './amount-parser';
import { plain, toolCall } from './replies';
import { knownNameInText } from './names';

const productIds: Record<string, string> = {
  稳健理财A: 'prod_wenjiana', 稳健理财B: 'prod_wenjib', 进取混合C: 'prod_jinrong', 货币基金: 'prod_huobi',
};
const holdingIds: Record<string, string> = {
  稳健理财A: 'holding_wenjiana', 稳健理财B: 'holding_wenjib', 货币基金: 'holding_huobi',
};

export function extractProductName(text: string): string | undefined {
  const known = knownNameInText(text, productIds);
  if (known) return known;
  const match = text.match(
    /(?:申购|认购|买入|购买|买)\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20}?)(?=\s*\d|\s*(?:元|块钱|块|人民币|¥|￥)|\s*[，,。！!？?]|\s*$)/,
  );
  const candidate = match?.[1]?.trim().replace(/^[点些个几]{1,3}/, '');
  return candidate || undefined;
}

export function resolveProductId(name: string): string { return productIds[name] ?? name; }

/** A share count is written with the 份 unit; the redemption contract stores six fractional digits. */
const SHARES_UNIT = /(\d+(?:\.\d+)?)\s*份/;
/** A CNY amount carries an explicit money unit; a bare number is ambiguous between 金额 and 份额. */
const MONEY_UNIT = /(?:元|块钱|块|人民币|rmb|¥|￥)/i;

/**
 * Canonical fixed-scale decimal text (`'2000.00'`, `'100.500000'`) built by string padding, never by
 * binary floating point. Extra fractional digits are truncated, matching the contract's rounding.
 */
function fixedScale(decimal: string, scale: number): string {
  const [whole, fraction = ''] = decimal.split('.');
  return `${whole}.${(fraction + '0'.repeat(scale)).slice(0, scale)}`;
}

export function classifyInvestmentAction(text: string): AssistantMessage | undefined {
  if (/(申购|认购|买入|购买)/.test(text) || /买[^\n]{0,6}(理财|基金|产品)/.test(text)) {
    const productName = extractProductName(text);
    if (!productName) return plain('请问要申购哪只理财产品？例如“申购稳健理财A 1000元”。');
    const amount = parseAmount(text);
    if (amount == null) return plain(`请问要申购「${productName}」多少钱？`);
    return toolCall('subscribe_investment', { productId: resolveProductId(productName), amount });
  }
  if (!/赎回/.test(text) && !(/取出/.test(text) && /(理财|基金|产品)/.test(text))) return undefined;
  const name = knownNameInText(text, holdingIds);
  const holdingId = name ? holdingIds[name] : 'holding_wenjiana';
  // Every redemption states its口径 explicitly — SHARES, AMOUNT or ALL — and never a principal amount.
  const shares = text.match(SHARES_UNIT)?.[1];
  if (shares !== undefined) return toolCall('redeem_investment', { holdingId, mode: 'SHARES', shares: fixedScale(shares, 6) });
  const amount = parseAmount(text);
  if (amount == null) return toolCall('redeem_investment', { holdingId, mode: 'ALL' });
  if (!MONEY_UNIT.test(text)) {
    return plain(`「${amount}」是按金额还是按份额赎回？按金额请说“赎回${amount}元”，按份额请说“赎回${amount}份”。`);
  }
  return toolCall('redeem_investment', { holdingId, mode: 'AMOUNT', amount: fixedScale(amount, 2) });
}

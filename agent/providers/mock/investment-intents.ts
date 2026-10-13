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
  return toolCall('redeem_investment', { holdingId: name ? holdingIds[name] : 'holding_wenjiana' });
}

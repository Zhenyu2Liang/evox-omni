/** Deterministic mock amount extraction; production never derives arguments from this parser. */
export interface RequestedMoneyAmount {
  raw: string;
  value: string;
  negative: boolean;
  zero: boolean;
}

const TOKEN = /(?<![\d.+\-−－])(?:[+\-−－]\s*)?(?:[¥￥$]\s*)?(?:[+\-−－]\s*)?\d+(?:\.\d+)?(?:\s*万)?(?:\s*(?:元|块|CNY|yuan))?(?![\d.])/gi;
const AMOUNT_REPLY = /^(?:是\s*)?(?:[+\-−－]\s*)?(?:[¥￥$]\s*)?(?:[+\-−－]\s*)?\d+(?:\.\d+)?(?:\s*万)?\s*(?:元|块|CNY|yuan)?\s*[。.!！]?$/i;
const AMOUNT_PREFIX = /(?:转(?:账)?|预留|申购|认购|赎回|调成|调整到|设置为|设成|限额(?:为|到|是))\s*$|(?:转给|给)\s*[^\d+\-−－¥￥$，,。；;\n]{1,30}(?:转(?:账)?)?\s*$|\b(?:transfer|send|reserve|purchase|subscribe|redeem)\s*(?:[a-z ]{1,30})?$/i;

export function isMoneyAmountReply(text: string): boolean {
  return AMOUNT_REPLY.test(text.trim());
}

/** Bounded extraction is only for request validation, never for manufacturing tool arguments. */
export function requestedMoneyAmounts(text: string): RequestedMoneyAmount[] {
  return [...text.matchAll(TOKEN)].flatMap(match => {
    const raw = match[0];
    const explicitCurrency = /[¥￥$]|元|块|CNY|yuan/i.test(raw);
    const prefix = text.slice(0, match.index);
    if (!explicitCurrency && /(?:手机号|手机|电话|尾号|卡号|账号|phone|account|ending(?: in)?)\s*$/i.test(prefix)) return [];
    if (!explicitCurrency && !isMoneyAmountReply(text) && !AMOUNT_PREFIX.test(prefix)) return [];
    const digits = /\d+(?:\.\d+)?/.exec(raw)?.[0];
    if (!digits) return [];
    const negative = /[\-−－]/.test(raw);
    const [integer, fraction = ''] = digits.split('.');
    const scale = /万/.test(raw) ? 4 : 0;
    const combined = `${integer}${fraction}`;
    const shift = scale - fraction.length;
    const shifted = scale === 0 ? digits : shift >= 0
      ? `${combined}${'0'.repeat(shift)}`
      : `${combined.slice(0, shift)}.${combined.slice(shift)}`;
    const value = shifted.replace(/^0+(?=\d)/, '');
    return [{ raw, value: negative ? `-${value}` : value, negative, zero: !/[1-9]/.test(digits) }];
  });
}

/** Preserve decimal text and parse integer numerals without binary floating-point arithmetic. */
export function parseAmount(text: string): string | undefined {
  const arabic = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块钱|块|人民币|rmb|¥|￥)/i);
  if (arabic) return arabic[1];
  const cn = text.match(/([零一二三四五六七八九十百千万两]+)\s*(?:元|块钱|块|人民币)/);
  if (cn) {
    const value = chineseToIntegerText(cn[1]);
    if (value != null) return value;
  }
  const afterVerb = text.match(/(?:转|汇|打|给)[^\d零一二三四五六七八九十百千万两]{0,4}?(\d+(?:\.\d+)?)/);
  if (afterVerb) return afterVerb[1];
  const afterVerbCn = text.match(/(?:转|汇|打)[^\d]{0,4}?([零一二三四五六七八九十百千万两]+)/);
  if (afterVerbCn) {
    const value = chineseToIntegerText(afterVerbCn[1]);
    if (value != null) return value;
  }
  return text.match(/(\d+(?:\.\d+)?)/)?.[1];
}

export function parseAmountOnly(text: string): string | undefined {
  const trimmed = text.trim();
  return /^\d+(?:\.\d+)?\s*(?:元|块钱|块|人民币)?\s*[。.!！]?$/.test(trimmed)
    ? parseAmount(trimmed) : undefined;
}

const numeralDigits: Record<string, bigint> = {
  零: 0n, 一: 1n, 二: 2n, 两: 2n, 三: 3n, 四: 4n, 五: 5n, 六: 6n, 七: 7n, 八: 8n, 九: 9n,
};
const numeralUnits: Record<string, bigint> = { 十: 10n, 百: 100n, 千: 1000n, 万: 10000n };

function chineseToIntegerText(input: string): string | undefined {
  let total = 0n;
  let section = 0n;
  let current = 0n;
  for (const character of input) {
    if (character in numeralDigits) current = numeralDigits[character];
    else if (character in numeralUnits) {
      const unit = numeralUnits[character];
      if (unit === 10000n) {
        section = (section + current) * unit;
        total += section;
        section = 0n;
        current = 0n;
      } else {
        section += (current === 0n ? 1n : current) * unit;
        current = 0n;
      }
    } else return undefined;
  }
  return String(total + section + current);
}

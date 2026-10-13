import type { IntentCondition } from './contracts/intent';
import { SPENDING_CATEGORIES } from './contracts/spending';

const supportedCategories: ReadonlySet<string> = new Set(SPENDING_CATEGORIES);

/** Only stable analysis categories may become executable field references. */
export function isSupportedSpendingCategory(category: string): boolean {
  return supportedCategories.has(category);
}

function conditionScope(prefix: string): Pick<IntentCondition, 'category' | 'period'> {
  let scope = prefix.trim().replace(/^(?:我(?:们)?|本人)(?:的)?\s*/, '').replace(/^在\s*/, '');
  const periodText = /^(本月|这个月|当月|上个月|上月|20\d{2}年\d{1,2}月)/.exec(scope)?.[0] ?? '';
  if (periodText) scope = scope.slice(periodText.length);
  scope = scope.trim().replace(/^的\s*/, '').replace(/^(?:我(?:们)?|本人)(?:的)?\s*/, '')
    .replace(/(?:方面)?的$/, '').replace(/(?:类别|类)$/, '').trim();
  const explicitMonth = /^(20\d{2})年(\d{1,2})月$/.exec(periodText);
  const period: IntentCondition['period'] = explicitMonth
    ? { kind: 'month', month: `${explicitMonth[1]}-${explicitMonth[2].padStart(2, '0')}` }
    : { kind: 'month', relative: /(?:上月|上个月)/.test(periodText) ? 'previous' : 'current' };
  const category = /^(?:总|全部|所有|整体|合计)?$/.test(scope) ? undefined : scope;
  return { period, category };
}

/** Parse supported explicit conditions into semantic fields, independent of model node paths. */
export function requestedConditions(request: string): IntentCondition[] {
  return [...request.matchAll(/(?:如果|若)\s*([^，,。；;\n]{0,40}?)(?:消费|支出)(?:总额|总计|合计|金额)?\s*(超过|大于|不低于|至少|低于|小于|不超过)\s*(\d+(?:\.\d+)?)/g)]
    .map(match => {
      const [, prefix, comparison, threshold] = match;
      const { period, category } = conditionScope(prefix);
      const operator: IntentCondition['operator'] = /(?:不低于|至少)/.test(comparison) ? '>='
        : /不超过/.test(comparison) ? '<=' : /(?:低于|小于)/.test(comparison) ? '<' : '>';
      return { metric: 'spending', category, period, operator, threshold, sourceText: match[0] };
    });
}

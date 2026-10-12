import { AppError } from './errors';
import { moneyToCents } from './money';
import type { TaskNodeSpec } from './contracts/task';

export type RequestProduct = { id: string; name: string; code: string };
export const normalizeProduct = (value: string) => value.trim().replace(/^[“"「『]+|[”"」』]+$/g, '')
  .replace(/^(?:理财产品|产品)\s*/, '').toLowerCase();
export const productAliases = (product: RequestProduct) => [product.id, product.name, product.code].map(normalizeProduct);

interface Purchase { productId?: string; cents?: number }
const mismatch = () => new AppError('VALIDATION', '申购产品与本次请求不一致，或金额与对应步骤不一致；请逐笔核对产品和金额，未创建申购授权。');

/** Each command has its own span. Code digits are removed before reading monetary amounts. */
function purchases(request: string, rows: readonly RequestProduct[]): Purchase[] {
  const commands = [...request.matchAll(/(?:申购|认购|购买)\s*/g)];
  const parsed: Purchase[] = [];
  for (const [index, command] of commands.entries()) {
    const prefix = request.slice(0, command.index).split(/[，,。；;\n]/).at(-1) ?? '';
    if (/(?:不要|不想|不需|不用|不必|不能|禁止|无需|别|不)(?:再)?\s*$/.test(prefix)) {
      throw new AppError('VALIDATION', '包含否定的申购请求，请明确要申购的产品和金额；尚未执行计划。');
    }
    const span = request.slice(command.index! + command[0].length, commands[index + 1]?.index ?? request.length)
      .split(/[，,。；;\n]/)[0].trim();
    // Instructions about verification are not extra purchase commands.
    if (!span || /^(?:必须|均|都|需|要|应|等待|不能|不会|未|尚|成功|失败|操作|后|前|时)/.test(span)) continue;
    const head = normalizeProduct(normalizeProduct(span).replace(/^(?:[¥￥]\s*)?\d+(?:\.\d+)?\s*元?\s*(?:的)?\s*/, ''));
    const named = rows.filter(row => productAliases(row).some(name => head.startsWith(name) &&
      /^(?:$|\s*[\d¥￥“”"「」『』（(]|\s+(?:使用|用|从|金额|共))/.test(head.slice(name.length))));
    if (named.length > 1) throw new AppError('VALIDATION', '请分别说明每笔申购的产品和金额，尚未执行计划。');
    const product = named[0];
    const literal = normalizeProduct(head.split(/\s*[¥￥]?\d|\s+/)[0]);
    if (!product && literal && !/一款|适合|推荐|低风险|稳健型|产品$|理财$/.test(literal)) {
      throw new AppError('VALIDATION', '未找到你指定的申购产品，请先查询并选择准确名称或代码；不会代选其他产品。',
        { requestIssue: 'unknown_product' });
    }
    let amountsText = span.toLowerCase();
    if (product) for (const name of productAliases(product)) amountsText = amountsText.replaceAll(name, '');
    const amounts = [...amountsText.matchAll(/[¥￥]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*元/g)]
      .map(match => moneyToCents(match[1] ?? match[2]));
    if (!amounts.length) {
      const adjacent = /^\s*(\d+(?:\.\d+)?)(?![\d.])/.exec(amountsText);
      if (adjacent) amounts.push(moneyToCents(adjacent[1]));
    }
    const uniqueAmounts = [...new Set(amounts)];
    if (uniqueAmounts.length > 1) throw new AppError('VALIDATION', '无法确定该笔申购金额，请逐笔说明；尚未执行计划。');
    parsed.push({ productId: product?.id, cents: uniqueAmounts[0] });
  }
  return parsed;
}

/** The UI uses the same catalogue validation even when the model only lists products. */
export function invalidRequestedPurchase(request: string, rows: readonly RequestProduct[]): boolean {
  try { purchases(request, rows); return false; }
  catch (error) {
    return error instanceof AppError && error.code === 'VALIDATION' && typeof error.detail === 'object' &&
      error.detail !== null && 'requestIssue' in error.detail && error.detail.requestIssue === 'unknown_product';
  }
}

function matches(purchase: Purchase, args: Record<string, unknown>, rows: readonly RequestProduct[]): boolean {
  const target = rows.find(row => typeof args.productId === 'string' && productAliases(row).includes(normalizeProduct(args.productId)));
  if (purchase.productId && target?.id !== purchase.productId) return false;
  if (purchase.cents !== undefined) {
    try { if (moneyToCents(args.amount) !== purchase.cents) return false; }
    catch { return false; }
  }
  return true;
}

/** Gateway check: a proposed purchase must match a complete requested product/amount pair. */
export function assertPurchase(args: Record<string, unknown>, request: string, rows: readonly RequestProduct[]): void {
  const requested = purchases(request, rows);
  if (requested.length && !requested.some(purchase => matches(purchase, args, rows))) throw mismatch();
}

/** Plan check consumes each requested purchase once, rejecting omissions and extra/duplicated nodes. */
export function assertPlanPurchases(nodes: readonly TaskNodeSpec[], request: string, rows: readonly RequestProduct[]): void {
  const remaining = purchases(request, rows);
  if (!remaining.length) return;
  for (const node of nodes.filter(node => node.kind === 'tool' && node.tool === 'subscribe_investment')) {
    const candidates = remaining.map((purchase, i) => matches(purchase, node.args ?? {}, rows) ? i : -1).filter(i => i >= 0);
    if (!candidates.length) throw mismatch();
    // Identical requested pairs are separate steps. Different interpretations require clarification.
    if (new Set(candidates.map(i => JSON.stringify(remaining[i]))).size > 1) {
      throw new AppError('VALIDATION', '无法确定申购节点对应哪一步，请逐笔明确产品和金额；尚未执行计划。');
    }
    remaining.splice(candidates[0], 1);
  }
  if (remaining.length) throw new AppError('VALIDATION', '计划遗漏了请求中的申购步骤，请补齐产品和金额；尚未执行计划。');
}

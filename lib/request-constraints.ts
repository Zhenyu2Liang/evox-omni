import { prisma } from './db/client';
import { AppError } from './errors';
import type { TaskNodeSpec } from './contracts/task';

type Product = { id: string; name: string; code: string };
const normalize = (value: string) => value.trim().replace(/^[“"「『]+|[”"」』]+$/g, '')
  .replace(/^(?:理财产品|产品)\s*/, '').toLowerCase();
const aliases = (product: Product) => [product.id, product.name, product.code].map(normalize);

/** Bounded command grammar: quoted/exact product names and A-and-B comparisons, not model prose. */
export function requestedComparison(text: string): string[] {
  const match = /(?:对比|比较|compare)(?:一下|下)?\s*([^，。；;\n]+)/i.exec(text);
  if (!match) return [];
  const names = match[1].split(/的?(?:风险|期限|收益|年化|区别)|然后|接着/i)[0]
    .split(/\s*(?:以及|和|与|跟|、|\band\b|\bvs\.?\b)\s*/i)
    .map(normalize).filter(Boolean);
  return names.length >= 2 ? names : [];
}

export function invalidRequestedComparison(request: string, products: readonly Product[]): boolean {
  return investmentComparison(request, products).some(name => !products.some(row => aliases(row).includes(name)));
}

/** Identity aliases are read from owned resources, never from model-generated node labels. */
export async function requestEntityAliases(userId: string): Promise<ReadonlyMap<string, string[]>> {
  const [contacts, cards, subscriptions, products] = await Promise.all([
    prisma.contact.findMany({ where: { userId } }), prisma.card.findMany({ where: { userId } }),
    prisma.subscription.findMany({ where: { userId } }), prisma.investmentProduct.findMany(),
  ]);
  return new Map([
    ...contacts.map(row => [row.id, [row.name, row.phone]] as [string, string[]]),
    ...cards.map(row => [row.id, [row.numberMasked, row.numberMasked.replace(/\*/g, '')]] as [string, string[]]),
    ...subscriptions.map(row => [row.id, [row.name]] as [string, string[]]),
    ...products.map(row => [row.id, [row.name, row.code]] as [string, string[]]),
  ]);
}

function investmentComparison(request: string, products: readonly Product[]): string[] {
  const names = requestedComparison(request);
  return names.some(name => /理财|基金|投资|产品/.test(name) || /^[a-z]{2,}\d{2,}$/i.test(name) ||
    products.some(row => aliases(row).includes(name))) ? names : [];
}

export async function assertRequestedProducts(tool: string, args: Record<string, unknown>, request: string): Promise<void> {
  if (!request || !['compare_investments', 'subscribe_investment', 'redeem_investment', 'submit_plan'].includes(tool)) return;
  const rows = await prisma.investmentProduct.findMany({ select: { id: true, name: true, code: true } });
  const comparison = investmentComparison(request, rows);
  const selected = comparison.map(name => rows.find(row => aliases(row).includes(name)));
  if (selected.some(row => !row)) {
    throw new AppError('VALIDATION', '未找到你指定的理财产品，请根据产品列表选择准确名称或代码；不会自动替换成其他产品。');
  }
  if (tool === 'compare_investments' && selected.length) {
    const expected = new Set(selected.map(row => row!.id));
    const actual = Array.isArray(args.productIds) ? args.productIds.map(value =>
      rows.find(row => typeof value === 'string' && aliases(row).includes(normalize(value)))?.id) : [];
    if (actual.some(id => !id || !expected.has(id)) || new Set(actual).size !== expected.size) {
      throw new AppError('VALIDATION', '对比对象与本次请求不一致，请选择原请求中的产品；未执行产品对比。');
    }
  }
  if (tool === 'subscribe_investment') {
    const clause = /(?:申购|认购|购买)\s*([^，。；;\n]+)/.exec(request)?.[1];
    if (!clause) return; // Context-only requests still use the existing owned-selector resolution.
    const named = rows.filter(row => aliases(row).some(name => clause.toLowerCase().includes(name)));
    const target = rows.find(row => typeof args.productId === 'string' && aliases(row).includes(normalize(args.productId)));
    if (named.length === 1 && target?.id !== named[0].id) {
      throw new AppError('VALIDATION', '申购产品与本次请求不一致，请核对产品名称或代码；未创建申购授权。');
    }
    const literal = normalize(clause.split(/\s*[¥￥]?\d|\s+|\d+(?:\.\d+)?元/)[0]);
    if (literal && !named.length && !/一款|适合|推荐|低风险|稳健型|产品$/.test(literal)) {
      throw new AppError('VALIDATION', '未找到你指定的申购产品，请先查询并选择准确名称或代码；不会代选其他产品。');
    }
  }
}

const commands: Record<string, RegExp> = {
  reserve_budget: /预留|(?:建立|创建|记录|设置).*预算/,
  analyze_spending: /(?:查询|查看|分析|查一下|看看|看下).*(?:消费|账单|支出)/,
  get_balance: /余额/,
  get_transactions: /流水|交易记录/,
  detect_anomaly: /异常/,
  transfer_money: /转账|转给/,
  set_card_limit: /限额/,
  freeze_card: /(?<!解)冻结/,
  unfreeze_card: /解冻/,
  report_lost_card: /挂失/,
  cancel_subscription: /取消.*订阅|订阅.*取消/,
  set_subscription_reminder: /订阅.*提醒|续费提醒/,
  create_scheduled_task: /创建.*提醒|设置.*提醒|定时|安排|提醒我/,
  subscribe_investment: /申购|认购|购买.*理财/,
  redeem_investment: /赎回/,
  compare_investments: /对比|比较/,
  apply_virtual_card: /虚拟卡/,
  change_password: /改密|修改.*密码/,
};

/** Enforce explicit first/then/finally phases using trusted request spans and actual tool identities. */
export function enforceRequestedOrder(nodes: TaskNodeSpec[], request: string, names: ReadonlyMap<string, string[]> = new Map()): TaskNodeSpec[] {
  const markers = [...request.matchAll(/(首先|先|随后|然后|再|最后)(?=\s*(?:预留|查询|查看|查|看|分析|转|给|设置|将|把|创建|安排|取消|申购|认购|赎回|冻结|解冻|挂失|比较|对比|申请|修改))/g)];
  if (markers.length < 2 || !markers.some(marker => ['首先', '先'].includes(marker[1]))) return nodes;
  const phases = markers.map((marker, i) => request.slice(marker.index! + marker[0].length, markers[i + 1]?.index ?? request.length));
  const rank = new Map<string, number>();
  const used = new Set<number>();
  for (const node of nodes) {
    if (node.kind !== 'tool') continue;
    const command = commands[node.tool ?? ''];
    if (!command) continue; // Read-only catalog lookups are allowed prerequisites.
    let matches = phases.map((phase, i) => command.test(phase) ? i : -1).filter(i => i >= 0);
    if (matches.length > 1 && typeof node.args?.amount === 'number') {
      const amount = String(node.args.amount);
      matches = matches.filter(i => [...phases[i].matchAll(/\d+(?:\.\d+)?/g)].some(value => Number(value[0]) === Number(amount)));
    }
    if (matches.length > 1) {
      const selectors = ['name', 'phone', 'contactId', 'cardId', 'subscriptionId', 'productId']
        .map(field => node.args?.[field]).filter((value): value is string => typeof value === 'string');
      const literals = selectors.flatMap(value => names.get(value) ?? [value]);
      const selected = matches.filter(i => literals.some(value => phases[i].includes(value)));
      if (selected.length) matches = selected;
    }
    if (matches.length !== 1) {
      throw new AppError('VALIDATION', '无法确定计划节点与“先、再、最后”的对应关系，请分别说明每一步的对象和金额；尚未执行计划。');
    }
    rank.set(node.id, matches[0]); used.add(matches[0]);
  }
  if (phases.some((_, i) => !used.has(i))) {
    throw new AppError('VALIDATION', '计划遗漏了请求中的一个顺序步骤，请补齐或明确不支持的步骤；尚未执行计划。');
  }
  // Conditions follow their data prerequisites; model-supplied node names never establish order.
  for (let pass = 0; pass < nodes.length; pass++) for (const node of nodes) {
    if (rank.has(node.id)) continue;
    const parents = node.dependencies.map(id => rank.get(id)).filter((value): value is number => value !== undefined);
    if (parents.length) rank.set(node.id, Math.max(...parents));
  }
  return nodes.map(node => {
    const phase = rank.get(node.id);
    if (phase === undefined || phase === 0) return node;
    const predecessors = nodes.filter(previous => rank.get(previous.id) === phase - 1).map(previous => previous.id);
    return { ...node, after: [...new Set([...(node.after ?? []), ...predecessors])] };
  });
}

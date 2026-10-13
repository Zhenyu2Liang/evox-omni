import { listProducts, listHoldings } from './db/repositories/investment';
import { listContacts } from './db/repositories/contact';
import { listCards } from './db/repositories/card';
import { listSubscriptions } from './db/repositories/subscription';
import { AppError } from './errors';
import type { TaskNodeSpec } from './contracts/task';
import { resolveBankingArgs } from './banking-selectors';
import { compareDecimal } from './decimal';
import { assertPurchase, assertPlanPurchases, normalizeProduct as normalize, productAliases as aliases,
  type RequestProduct as Product } from './request-purchases';


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
  const [contacts, cards, subscriptions, products, holdings] = await Promise.all([
    listContacts(userId), listCards(userId), listSubscriptions(userId), listProducts(), listHoldings(userId, 'HOLDING'),
  ]);
  return new Map([
    ...contacts.map(row => [row.id, [row.name, row.phone]] as [string, string[]]),
    ...cards.map(row => [row.id, [row.numberMasked, row.numberMasked.replace(/\*/g, ''),
      ...(row.type === 'CREDIT' ? ['信用卡'] : row.type === 'DEBIT' ? ['借记卡', '储蓄卡'] : ['虚拟卡'])]] as [string, string[]]),
    ...subscriptions.map(row => [row.id, [row.name]] as [string, string[]]),
    ...products.map(row => [row.id, [row.name, row.code]] as [string, string[]]),
    ...holdings.map(row => [row.id, [row.id, row.productId, row.product.name, row.product.code]] as [string, string[]]),
  ]);
}

/** Fresh plans bind a unique currently owned holding before earlier nodes can write. */
export async function resolveRequestedRedemptions(userId: string, nodes: TaskNodeSpec[]): Promise<TaskNodeSpec[]> {
  if (!nodes.some(node => node.kind === 'tool' && node.tool === 'redeem_investment')) return nodes;
  const active = new Set((await listHoldings(userId, 'HOLDING')).map(row => row.id));
  return Promise.all(nodes.map(async node => {
    if (node.kind !== 'tool' || node.tool !== 'redeem_investment') return node;
    const args = await resolveBankingArgs(userId, 'redeem_investment', node.args ?? {});
    if (!active.has(String(args.holdingId))) throw new AppError('VALIDATION', '该持仓当前不可赎回，请查询本人有效持仓；尚未执行计划。');
    return { ...node, args };
  }));
}

function investmentComparison(request: string, products: readonly Product[]): string[] {
  const names = requestedComparison(request);
  return names.some(name => /理财|基金|投资|产品/.test(name) || /^[a-z]{2,}\d{2,}$/i.test(name) ||
    products.some(row => aliases(row).includes(name))) ? names : [];
}

export async function assertRequestedProducts(tool: string, args: Record<string, unknown>, request: string): Promise<void> {
  if (!request || !['compare_investments', 'subscribe_investment', 'redeem_investment', 'submit_plan'].includes(tool)) return;
  const rows = await listProducts();
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
  if (tool === 'subscribe_investment') assertPurchase(args, request, rows);
}

export async function assertRequestedPlanProducts(nodes: readonly TaskNodeSpec[], request: string): Promise<void> {
  await assertRequestedProducts('submit_plan', {}, request);
  for (const node of nodes) if (node.tool) await assertRequestedProducts(node.tool, node.args ?? {}, request);
  if (request) assertPlanPurchases(nodes, request, await listProducts());
}

export const REQUEST_COMMANDS: Readonly<Record<string, RegExp>> = {
  reserve_budget: /预留|(?:建立|创建|记录|设置).*预算/,
  analyze_spending: /(?:查询|查看|分析|查一下|看看|看下).*(?:消费|账单|支出)/,
  get_balance: /余额/,
  get_transactions: /流水|交易记录/,
  detect_anomaly: /异常/,
  transfer_money: /转账|转给|给.{1,30}转(?=\s*[\d一二三四五六七八九十百千万])|转(?=\s*\d)/,
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
const commands = REQUEST_COMMANDS;

/** Enforce explicit first/then/finally phases using trusted request spans and actual tool identities. */
export function enforceRequestedOrder(nodes: TaskNodeSpec[], request: string, names: ReadonlyMap<string, string[]> = new Map()): TaskNodeSpec[] {
  const markers = [...request.matchAll(/(首先|先|随后|然后|再|最后)(?=\s*(?:从|用|预留|查询|查看|查|看|分析|转|给|设置|将|把|创建|安排|取消|申购|认购|赎回|冻结|解冻|挂失|比较|对比|申请|修改))/g)];
  if (markers.length < 2 || !markers.some(marker => ['首先', '先'].includes(marker[1]))) return nodes;
  const phases = markers.map((marker, i) => request.slice(marker.index! + marker[0].length, markers[i + 1]?.index ?? request.length));
  const amountSpans = phases.map(phase => {
    let span = phase.toLowerCase();
    for (const aliases of names.values()) for (const alias of aliases) {
      if (/[^\d.*\s]/.test(alias)) span = span.replaceAll(alias.toLowerCase(), '');
    }
    return span;
  });
  const rank = new Map<string, number>();
  const used = new Set<number>();
  for (const node of nodes) {
    if (node.kind !== 'tool') continue;
    const command = commands[node.tool ?? ''];
    if (!command) continue; // Read-only catalog lookups are allowed prerequisites.
    let matches = phases.map((phase, i) => command.test(phase) ? i : -1).filter(i => i >= 0);
    if (matches.length > 1 && typeof node.args?.amount === 'string') {
      const amount = node.args.amount;
      matches = matches.filter(i => [...amountSpans[i].matchAll(/\d+(?:\.\d+)?/g)].some(value => compareDecimal(value[0], amount) === 0));
    }
    if (matches.length > 1) {
      const selectors = ['name', 'phone', 'contactId', 'cardId', 'subscriptionId', 'productId', 'holdingId']
        .map(field => node.args?.[field]).filter((value): value is string => typeof value === 'string');
      const literals = selectors.flatMap(value => names.get(value) ?? [value]);
      const exact = matches.filter(i => selectors.some(value => phases[i].toLowerCase().includes(value.toLowerCase())));
      const selected = exact.length ? exact : matches.filter(i => literals.some(value => phases[i].toLowerCase().includes(value.toLowerCase())));
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

/** Match real tool identities and owned aliases, never model-written node names or goals. */
function nodesInSpan(nodes: readonly TaskNodeSpec[], span: string, names: ReadonlyMap<string, string[]>): TaskNodeSpec[] {
  let candidates = nodes.filter(node => node.kind === 'tool' && commands[node.tool ?? '']?.test(span));
  // An operation mentioned inside a reminder name is not another command in this span.
  if (candidates.length > 1) {
    const firstVerb = Math.min(...candidates.map(node => commands[node.tool!]!.exec(span)!.index));
    candidates = candidates.filter(node => commands[node.tool!]!.exec(span)!.index === firstVerb);
  }
  const amounts = [...span.matchAll(/(\d+(?:\.\d+)?)\s*元/g)].map(match => match[1]);
  if (candidates.length > 1 && amounts.length) candidates = candidates.filter(node => {
    const amount = node.args?.amount;
    return typeof amount === 'string' && amounts.some(value => compareDecimal(value, amount) === 0);
  });
  if (candidates.length > 1) {
    const specific = candidates.filter(node => ['name', 'phone', 'contactId', 'cardId', 'subscriptionId', 'productId', 'holdingId']
      .some(field => typeof node.args?.[field] === 'string' && (names.get(node.args[field] as string) ?? [node.args[field] as string])
        .some(alias => span.toLowerCase().includes(alias.toLowerCase()))));
    if (specific.length) candidates = specific;
  }
  return candidates;
}

/** Explicit success conditions strengthen persisted hard dependencies before any node is executed. */
export function enforceRequestedSuccess(nodes: TaskNodeSpec[], request: string, names: ReadonlyMap<string, string[]> = new Map()): TaskNodeSpec[] {
  let bound = nodes;
  for (const gate of request.matchAll(/([^，,。；;\n]*?)成功(?:(?:之后|以后|后|时)\s*[，,]?\s*(?:才|再|然后|就)?|\s*[，,]?\s*才)\s*([^，,。；;\n]+)/g)) {
    const [, sourceSpan, targetSpan] = gate;
    if (/不必|不用|无需|不需要|不要求|无论|不管/.test(sourceSpan)) continue;
    const sources = nodesInSpan(bound, sourceSpan, names);
    const targets = nodesInSpan(bound, targetSpan, names);
    if (sources.length !== 1 || targets.length !== 1 || sources[0].id === targets[0].id) {
      throw new AppError('VALIDATION', '无法确定“成功后才执行”的前后步骤，请明确操作对象和金额；尚未执行计划。');
    }
    const source = sources[0].id;
    bound = bound.map(node => node.id !== targets[0].id ? node : {
      ...node, dependencies: [...new Set([...node.dependencies, source])], after: node.after?.filter(id => id !== source),
    });
  }
  return bound;
}

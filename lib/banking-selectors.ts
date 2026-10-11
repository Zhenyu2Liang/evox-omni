import { prisma } from './db/client';
import { AppError } from './errors';
import type { ToolName } from './contracts/tools';

/** Resolve only within the authenticated owner's resources; ambiguous selectors never pick first. */
function select<T extends { id: string }>(rows: T[], value: unknown, names: (row: T) => string[], label: string): T {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const exact = rows.filter(row => row.id.toLowerCase() === text);
  const matches = exact.length ? exact : rows.filter(row => names(row).some(name => name.toLowerCase() === text));
  if (matches.length === 1) return matches[0];
  throw new AppError('VALIDATION', matches.length > 1
    ? `${label}不唯一，请选择：${matches.map(row => `${names(row)[0]}（${row.id}）`).join('、')}`
    : `未找到${label}“${text}”，请先查询并选择当前账户中的${label}。`);
}

export async function resolveBankingArgs(userId: string, tool: ToolName, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const args = { ...input };
  if (tool === 'transfer_money' && args.sourceAccountId) {
    const rows = await prisma.account.findMany({ where: { userId } });
    args.sourceAccountId = select(rows, args.sourceAccountId, r => [r.name], '付款账户').id;
  }
  if (['freeze_card', 'unfreeze_card', 'report_lost_card', 'set_card_limit'].includes(tool)) {
    const rows = await prisma.card.findMany({ where: { userId } });
    const types: Record<string, string> = { CREDIT: '信用卡', DEBIT: '借记卡', VIRTUAL: '虚拟卡' };
    args.cardId = select(rows, args.cardId, r => [types[r.type] ?? r.type, r.numberMasked, r.numberMasked.replace(/\*/g, ''), `尾号${r.numberMasked.replace(/\*/g, '')}`], '银行卡').id;
  }
  if (['cancel_subscription', 'set_subscription_reminder'].includes(tool)) {
    const rows = await prisma.subscription.findMany({ where: { userId } });
    args.subscriptionId = select(rows, args.subscriptionId, r => [r.name], '订阅').id;
  }
  if (tool === 'subscribe_investment' || tool === 'compare_investments') {
    const rows = await prisma.investmentProduct.findMany();
    const resolve = (value: unknown) => select(rows, value, r => [r.name, r.code], '理财产品').id;
    if (tool === 'subscribe_investment') args.productId = resolve(args.productId);
    else {
      if (!Array.isArray(args.productIds) || args.productIds.length === 0) throw new AppError('VALIDATION', '请选择要对比的理财产品。');
      args.productIds = args.productIds.map(resolve);
    }
  }
  if (tool === 'redeem_investment') {
    const rows = await prisma.investmentHolding.findMany({ where: { userId }, include: { product: true } });
    // An exact historical ID can replay its result; a name selects current holdings only.
    const candidates = rows.some(row => row.id === args.holdingId) ? rows : rows.filter(row => row.status === 'ACTIVE');
    args.holdingId = select(candidates, args.holdingId, r => [r.product.name, r.product.code], '持仓').id;
  }
  return args;
}

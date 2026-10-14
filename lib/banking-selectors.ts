import { prisma } from './db/client';
import { AppError } from './errors';
import type { ToolName } from './contracts/tools';

/** Identity fields bind exact resource IDs within the current owner's resource set. */
function select<T extends { id: string }>(rows: T[], value: unknown, label: string): T {
  const text = typeof value === 'string' ? value : '';
  const matches = rows.filter(row => row.id === text);
  if (matches.length === 1) return matches[0];
  throw new AppError('NOT_FOUND', 'The selected resource ID is unavailable. Query current resources and select an exact ID.', { resource: label, id: text });
}

export async function resolveBankingArgs(userId: string, tool: ToolName, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const args = { ...input };
  if (tool === 'transfer_money' && args.sourceAccountId) {
    const rows = await prisma.account.findMany({ where: { userId } });
    args.sourceAccountId = select(rows, args.sourceAccountId, 'Account').id;
  }
  if (['freeze_card', 'unfreeze_card', 'report_lost_card', 'set_card_limit'].includes(tool)) {
    const rows = await prisma.card.findMany({ where: { userId } });
    args.cardId = select(rows, args.cardId, 'Card').id;
  }
  if (['cancel_subscription', 'set_subscription_reminder'].includes(tool)) {
    const rows = await prisma.subscription.findMany({ where: { userId } });
    args.subscriptionId = select(rows, args.subscriptionId, 'Subscription').id;
  }
  if (tool === 'subscribe_investment' || tool === 'compare_investments') {
    const rows = await prisma.investmentProduct.findMany();
    const resolve = (value: unknown) => select(rows, value, 'InvestmentProduct').id;
    if (tool === 'subscribe_investment') args.productId = resolve(args.productId);
    else {
      if (!Array.isArray(args.productIds) || args.productIds.length === 0) throw new AppError('VALIDATION', '请选择要对比的理财产品。');
      args.productIds = args.productIds.map(resolve);
    }
  }
  if (tool === 'redeem_investment') {
    const rows = await prisma.investmentHolding.findMany({ where: { userId }, include: { product: true } });
    // An exact historical ID can replay its result; a name selects current holdings only.
    const candidates = rows.some(row => row.id === args.holdingId) ? rows : rows.filter(row => row.status === 'HOLDING');
    args.holdingId = select(candidates, args.holdingId, 'InvestmentHolding').id;
  }
  return args;
}

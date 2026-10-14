import type { Prisma } from '@/lib/db/prisma';
import type { RiskLevel } from '../lib/contracts/risk';
import { DAILY_TRANSFER_LIMIT } from '../lib/constants';
import { demoNow } from '../lib/clock';
import { startOfDay } from '../lib/date';
import { formatCNY, moneyToCents, centsToMoney, normalizeTransferAmount, absoluteMinor, assertMinorUnits,
  type MoneyAmount, type MoneyInput } from '../lib/money';
import { AppError } from '../lib/errors';
import { safeParse } from '../lib/json';
import { prisma } from '../lib/db/client';
import { ledgerTxIdForAction } from '../lib/ledger';

export interface TransferRiskInput { amount: MoneyInput; dailyTransferTotal: MoneyInput }
export interface TransferRiskResult {
  tier: RiskLevel;
  requiresConfirmation: boolean;
  requiresMfa: boolean;
  reasons: string[];
  amount: MoneyAmount;
  dailyTotal: MoneyAmount;
  projectedDailyTotal: MoneyAmount;
}
export type PrismaLike = Prisma.TransactionClient | typeof prisma;

function sumMinor(values: bigint[]): MoneyAmount {
  return centsToMoney(assertMinorUnits(values.reduce((total, value) => total + value, 0n)));
}

/** Count authorized debits once: posted operations are already included in the ledger. */
export async function computeInFlightTransferTotal(client: PrismaLike, userId: string, excludeActionId?: string): Promise<MoneyAmount> {
  const actions = await client.pendingAction.findMany({ where: {
    userId, toolName: 'transfer_money', status: { in: ['confirmed', 'executing'] },
    ...(excludeActionId ? { id: { not: excludeActionId } } : {}),
  } });
  if (actions.length === 0) return '0.00';
  const posted = new Set((await client.transaction.findMany({
    where: { id: { in: actions.map(action => ledgerTxIdForAction(userId, action)) } }, select: { id: true },
  })).map(row => row.id));
  return sumMinor(actions.filter(action => !posted.has(ledgerTxIdForAction(userId, action))).map(action =>
    moneyToCents(normalizeTransferAmount(safeParse<Record<string, unknown>>(action.argsJson, {}).amount))));
}

async function executedTotal(client: PrismaLike, userId: string, now?: number): Promise<MoneyAmount> {
  const instant = demoNow(now);
  const rows = await client.transaction.findMany({ where: {
    userId, occurredAt: { gte: startOfDay(new Date(instant)), lt: new Date(instant + 1) },
    channel: 'TRANSFER', direction: 'DEBIT',
  }, select: { amountMinor: true } });
  return sumMinor(rows.map(row => absoluteMinor(row.amountMinor)));
}

export async function computeEffectiveTransferTotalWith(client: PrismaLike, userId: string, now?: number, excludeActionId?: string): Promise<MoneyAmount> {
  const executed = await executedTotal(client, userId, now);
  const reserved = await computeInFlightTransferTotal(client, userId, excludeActionId);
  return sumMinor([moneyToCents(executed), moneyToCents(reserved)]);
}

/** All policy arithmetic uses integer minor units, including pending reservations. */
export function evaluateTransferRisk(input: TransferRiskInput): TransferRiskResult {
  const amount = moneyToCents(input.amount);
  const daily = moneyToCents(input.dailyTransferTotal);
  if (amount < 0n || daily < 0n) throw new AppError('VALIDATION', 'Transfer amounts and daily totals cannot be negative.');
  const projected = assertMinorUnits(amount + daily);
  const limit = moneyToCents(DAILY_TRANSFER_LIMIT);
  const red = amount > limit || projected > limit;
  return {
    tier: red ? 'RED' : 'YELLOW', requiresConfirmation: true, requiresMfa: red,
    amount: centsToMoney(amount), dailyTotal: centsToMoney(daily), projectedDailyTotal: centsToMoney(projected),
    reasons: [red
      ? `Transfer ${formatCNY(centsToMoney(amount))} or projected daily total ${formatCNY(centsToMoney(projected))} exceeds ${formatCNY(DAILY_TRANSFER_LIMIT)}; strong verification is required.`
      : `Transfer and projected daily total do not exceed ${formatCNY(DAILY_TRANSFER_LIMIT)}; explicit confirmation is required.`],
  };
}

export function computeDailyTransferTotal(userId: string, now?: number): Promise<MoneyAmount> {
  return executedTotal(prisma, userId, now);
}

export async function reEvaluateTransferRisk(userId: string, amount: MoneyInput, now?: number): Promise<TransferRiskResult> {
  return evaluateTransferRisk({ amount, dailyTransferTotal: await computeDailyTransferTotal(userId, now) });
}

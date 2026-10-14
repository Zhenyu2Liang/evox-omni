import type { Account } from '@/lib/db/prisma';
import { dbClient } from '../client';
import { assertMinorUnits, moneyToCents, type MoneyInput } from '../../money';

export function listAccounts(userId: string): Promise<Account[]> {
  return dbClient().account.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });
}

export function getAccount(id: string): Promise<Account | null> {
  return dbClient().account.findUnique({ where: { id } });
}

export function getCheckingAccount(userId: string): Promise<Account | null> {
  return dbClient().account.findFirst({
    where: { userId, type: 'CHECKING' },
    orderBy: { id: 'asc' },
  });
}

/**
 * Sum of all of the user's account balances (CNY). Accounts are the user's deposit
 * accounts only; balances are signed, so this is a straight sum.
 */
export async function getTotalBalance(userId: string): Promise<bigint> {
  const rows = await dbClient().account.findMany({ where: { userId }, select: { balanceMinor: true } });
  return rows.reduce((total, row) => total + row.balanceMinor, 0n);
}

export function createAccount(input: { userId: string; type: string; name: string; number: string; balance: MoneyInput; currency?: string }): Promise<Account> {
  return dbClient().account.create({
    data: {
      userId: input.userId,
      type: input.type,
      name: input.name,
      number: input.number,
      balanceMinor: moneyToCents(input.balance),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
    },
  });
}

export function setBalance(id: string, balance: MoneyInput): Promise<Account> {
  return dbClient().account.update({
    where: { id },
    data: { balanceMinor: moneyToCents(balance) },
  });
}

export async function incrementBalance(id: string, delta: MoneyInput): Promise<Account> {
  const client = dbClient();
  const row = await client.account.findUniqueOrThrow({ where: { id } });
  const balanceMinor = assertMinorUnits(row.balanceMinor + moneyToCents(delta));
  return client.account.update({ where: { id, balanceMinor: row.balanceMinor }, data: { balanceMinor } });
}

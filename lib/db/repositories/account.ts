import type { Account } from '@prisma/client';
import { prisma } from '../client';

export function listAccounts(userId: string): Promise<Account[]> {
  return prisma.account.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });
}

export function getAccount(id: string): Promise<Account | null> {
  return prisma.account.findUnique({ where: { id } });
}

export function getCheckingAccount(userId: string): Promise<Account | null> {
  return prisma.account.findFirst({
    where: { userId, type: 'CHECKING' },
    orderBy: { id: 'asc' },
  });
}

/**
 * Sum of all of the user's account balances (CNY). Accounts are the user's deposit
 * accounts only; balances are signed, so this is a straight sum.
 */
export async function getTotalBalance(userId: string): Promise<number> {
  const agg = await prisma.account.aggregate({
    where: { userId },
    _sum: { balance: true },
  });
  return agg._sum.balance ?? 0;
}

export function createAccount(input: { userId: string; type: string; name: string; number: string; balance: number; currency?: string }): Promise<Account> {
  return prisma.account.create({
    data: {
      userId: input.userId,
      type: input.type,
      name: input.name,
      number: input.number,
      balance: input.balance,
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
    },
  });
}

export function setBalance(id: string, balance: number): Promise<Account> {
  return prisma.account.update({
    where: { id },
    data: { balance },
  });
}

export function incrementBalance(id: string, delta: number): Promise<Account> {
  return prisma.account.update({
    where: { id },
    data: { balance: { increment: delta } },
  });
}

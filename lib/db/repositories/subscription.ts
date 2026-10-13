import type { Subscription } from '@prisma/client';
import { dbClient } from '../client';
import { moneyToCents, type MoneyInput } from '../../money';

export function listSubscriptions(userId: string, status?: string): Promise<Subscription[]> {
  return dbClient().subscription.findMany({
    where: { userId, ...(status !== undefined ? { status } : {}) },
    orderBy: { nextChargeAt: 'asc' },
  });
}

export function getSubscription(id: string): Promise<Subscription | null> {
  return dbClient().subscription.findUnique({ where: { id } });
}

export function createSubscription(input: { userId: string; name: string; amount: MoneyInput; cycle?: string; nextChargeAt: Date; status?: string; remind?: boolean }): Promise<Subscription> {
  return dbClient().subscription.create({
    data: {
      userId: input.userId,
      name: input.name,
      amountMinor: moneyToCents(input.amount),
      ...(input.cycle !== undefined ? { cycle: input.cycle } : {}),
      nextChargeAt: input.nextChargeAt,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.remind !== undefined ? { remind: input.remind } : {}),
    },
  });
}

export function updateSubscriptionStatus(id: string, status: string): Promise<Subscription> {
  return dbClient().subscription.update({
    where: { id },
    data: { status },
  });
}

export function setSubscriptionReminder(id: string, remind: boolean): Promise<Subscription> {
  return dbClient().subscription.update({
    where: { id },
    data: { remind },
  });
}

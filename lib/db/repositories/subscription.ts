import type { Subscription } from '@prisma/client';
import { prisma } from '../client';

export function listSubscriptions(userId: string, status?: string): Promise<Subscription[]> {
  return prisma.subscription.findMany({
    where: { userId, ...(status !== undefined ? { status } : {}) },
    orderBy: { nextChargeAt: 'asc' },
  });
}

export function getSubscription(id: string): Promise<Subscription | null> {
  return prisma.subscription.findUnique({ where: { id } });
}

export function createSubscription(input: { userId: string; name: string; amount: number; cycle?: string; nextChargeAt: Date; status?: string; remind?: boolean }): Promise<Subscription> {
  return prisma.subscription.create({
    data: {
      userId: input.userId,
      name: input.name,
      amount: input.amount,
      ...(input.cycle !== undefined ? { cycle: input.cycle } : {}),
      nextChargeAt: input.nextChargeAt,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.remind !== undefined ? { remind: input.remind } : {}),
    },
  });
}

export function updateSubscriptionStatus(id: string, status: string): Promise<Subscription> {
  return prisma.subscription.update({
    where: { id },
    data: { status },
  });
}

export function setSubscriptionReminder(id: string, remind: boolean): Promise<Subscription> {
  return prisma.subscription.update({
    where: { id },
    data: { remind },
  });
}

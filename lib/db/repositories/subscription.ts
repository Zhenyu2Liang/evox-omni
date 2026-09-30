import type { Subscription } from '@prisma/client';

export function listSubscriptions(userId: string, status?: string): Promise<Subscription[]> {
  throw new Error('not implemented');
}

export function getSubscription(id: string): Promise<Subscription | null> {
  throw new Error('not implemented');
}

export function createSubscription(input: { userId: string; name: string; amount: number; cycle?: string; nextChargeAt: Date; status?: string; remind?: boolean }): Promise<Subscription> {
  throw new Error('not implemented');
}

export function updateSubscriptionStatus(id: string, status: string): Promise<Subscription> {
  throw new Error('not implemented');
}

export function setSubscriptionReminder(id: string, remind: boolean): Promise<Subscription> {
  throw new Error('not implemented');
}

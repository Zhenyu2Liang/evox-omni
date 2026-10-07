/**
 * Banking SDK — subscription reads & mutations. Executes only; tier policy lives in `security/`.
 *
 * Domain invariants enforced here (never by the model):
 *  - `listSubscriptions` exposes ACTIVE subscriptions only (a cancelled one is excluded);
 *  - cancelling an unknown subscription → `AppError('NOT_FOUND')`, re-cancelling one →
 *    `AppError('CONFLICT')` (illegal state transition);
 *  - `remind` must be a boolean → `AppError('VALIDATION')`.
 */
import type { Subscription as SubscriptionRow } from '@prisma/client';
import { subscriptions } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { runInTransaction } from './tx';
import type { SubscriptionCycle, SubscriptionStatus, SubscriptionView } from './types';

/** Map a Prisma subscription row onto the frozen `SubscriptionView` DTO. */
function toSubscriptionView(row: SubscriptionRow): SubscriptionView {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    cycle: row.cycle as SubscriptionCycle,
    nextChargeAt: row.nextChargeAt.getTime(),
    status: row.status as SubscriptionStatus,
    remind: row.remind,
  };
}

/** Resolve a subscription or throw `AppError('NOT_FOUND')`. */
async function requireSubscription(id: string): Promise<SubscriptionRow> {
  const row = typeof id === 'string' && id.length > 0 ? await subscriptions.getSubscription(id) : null;
  if (!row) throw new AppError('NOT_FOUND', `订阅不存在：${String(id)}`, { subscriptionId: id });
  return row;
}

/** All subscriptions owned by the user. */
export async function listSubscriptions(userId: string): Promise<SubscriptionView[]> {
  const rows = await subscriptions.listSubscriptions(userId, 'ACTIVE');
  return rows.map(toSubscriptionView);
}

/** Cancel a subscription (status → CANCELLED); returns the updated subscription. */
export async function cancelSubscription(id: string): Promise<SubscriptionView> {
  const row = await requireSubscription(id);
  if ((row.status as SubscriptionStatus) === 'CANCELLED') {
    throw new AppError('CONFLICT', `订阅已取消，无法重复取消：${row.name}`, {
      subscriptionId: row.id,
      status: row.status,
    });
  }
  const updated = await runInTransaction((tx) => tx.subscription.update({ where: { id: row.id }, data: { status: 'CANCELLED' } }));
  return toSubscriptionView(updated);
}

/** Toggle the renewal reminder on a subscription; returns the updated subscription. */
export async function setSubscriptionReminder(
  id: string,
  remind: boolean,
): Promise<SubscriptionView> {
  if (typeof remind !== 'boolean') {
    throw new AppError('VALIDATION', '提醒开关必须是布尔值', { subscriptionId: id, remind });
  }
  const row = await requireSubscription(id);
  const updated = await runInTransaction((tx) => tx.subscription.update({ where: { id: row.id }, data: { remind } }));
  return toSubscriptionView(updated);
}

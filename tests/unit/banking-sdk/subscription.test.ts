/**
 * Unit: banking-sdk/subscription — subscription reads & mutations (execute only; tier policy in security/).
 *
 * Targets `@/banking-sdk` → banking.subscription.listSubscriptions/cancelSubscription/setSubscriptionReminder
 * (+ type SubscriptionView from '@/banking-sdk').
 *
 * Reads and writes Subscription rows via Prisma → requires test SQLite via ../../helpers/db.
 * Seed (fixtures.buildSubscriptions): 4 ACTIVE subscriptions — sub_netflix (Netflix ¥68 MONTHLY),
 * sub_spotify (Spotify ¥15), sub_icloud (iCloud ¥6), sub_video (视频会员 ¥25); all `remind:false`.
 */
import { describe, it, expect } from 'vitest';
import { banking } from '@/banking-sdk';
import type { SubscriptionView } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';

// Truncate + re-seed the canonical fixtures before every case, and disconnect the client afterwards.
useFreshDatabase();

/** The 4 active subscription ids seeded by `fixtures.buildSubscriptions()`. */
const ACTIVE_IDS = ['sub_netflix', 'sub_spotify', 'sub_icloud', 'sub_video'];

/** Pick a subscription out of a list, failing loudly when it is missing (never a silent `!`). */
function findById(subs: SubscriptionView[], id: string): SubscriptionView {
  const found = subs.find((s) => s.id === id);
  if (!found) throw new Error(`expected active subscription ${id} in ${JSON.stringify(subs.map((s) => s.id))}`);
  return found;
}

/** Require `promise` to reject with an `AppError` carrying `code`; returns the caught error. */
async function captureAppError(promise: Promise<unknown>, code: AppError['code']): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('banking-sdk/subscription · listSubscriptions', () => {
  it("returns the user's active subscriptions mapped to SubscriptionView", async () => {
    const subs = await banking.subscription.listSubscriptions(DEMO_USER_ID);

    expect(subs).toHaveLength(4);
    expect(new Set(subs.map((s) => s.id))).toEqual(new Set(ACTIVE_IDS));

    // Repository orders by `nextChargeAt` ascending.
    const times = subs.map((s) => s.nextChargeAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const netflix = findById(subs, 'sub_netflix');
    expect(netflix).toMatchObject({
      id: 'sub_netflix',
      name: 'Netflix',
      amount: 68,
      cycle: 'MONTHLY',
      status: 'ACTIVE',
      remind: false,
    });
    expect(Number.isFinite(netflix.nextChargeAt)).toBe(true);
  });

  it('a cancelled subscription is excluded from the active list', async () => {
    expect((await banking.subscription.listSubscriptions(DEMO_USER_ID)).map((s) => s.id)).toContain('sub_netflix');

    await banking.subscription.cancelSubscription('sub_netflix');

    const after = await banking.subscription.listSubscriptions(DEMO_USER_ID);
    expect(after).toHaveLength(3);
    expect(after.map((s) => s.id)).not.toContain('sub_netflix');
    expect(new Set(after.map((s) => s.id))).toEqual(new Set(['sub_spotify', 'sub_icloud', 'sub_video']));
  });

  it('every view carries id / name / amount / cycle / nextChargeAt / status / remind', async () => {
    const subs = await banking.subscription.listSubscriptions(DEMO_USER_ID);
    expect(subs).toHaveLength(4);

    for (const sub of subs) {
      expect(typeof sub.id).toBe('string');
      expect(sub.id.length).toBeGreaterThan(0);
      expect(typeof sub.name).toBe('string');
      expect(sub.name.length).toBeGreaterThan(0);
      expect(typeof sub.amount).toBe('number');
      expect(['MONTHLY', 'QUARTERLY', 'YEARLY']).toContain(sub.cycle);
      expect(Number.isFinite(sub.nextChargeAt)).toBe(true);
      expect(sub.status).toBe('ACTIVE');
      expect(typeof sub.remind).toBe('boolean');

      // Exact DTO shape — no Prisma row fields leak out of the SDK.
      expect(Object.keys(sub).sort()).toEqual([
        'amount',
        'cycle',
        'id',
        'name',
        'nextChargeAt',
        'remind',
        'status',
      ]);
    }
  });
});

describe('banking-sdk/subscription · cancelSubscription', () => {
  it('flips status ACTIVE → CANCELLED and returns the updated SubscriptionView', async () => {
    const before = findById(await banking.subscription.listSubscriptions(DEMO_USER_ID), 'sub_netflix');
    expect(before.status).toBe('ACTIVE');

    const cancelled = await banking.subscription.cancelSubscription('sub_netflix');
    expect(cancelled).toMatchObject({
      id: 'sub_netflix',
      name: 'Netflix',
      amount: before.amount,
      cycle: 'MONTHLY',
      status: 'CANCELLED',
      remind: before.remind,
    });
    expect(cancelled.nextChargeAt).toBe(before.nextChargeAt);

    // Persisted: excluded from the active list …
    const active = await banking.subscription.listSubscriptions(DEMO_USER_ID);
    expect(active.map((s) => s.id)).not.toContain('sub_netflix');
    // … and the row itself is CANCELLED.
    const row = await getTestPrisma().subscription.findUnique({ where: { id: 'sub_netflix' } });
    expect(row?.status).toBe('CANCELLED');
  });

  it('re-cancelling an already CANCELLED subscription surfaces an AppError (illegal transition)', async () => {
    await banking.subscription.cancelSubscription('sub_netflix');

    const error = await captureAppError(banking.subscription.cancelSubscription('sub_netflix'), 'CONFLICT');
    expect(error.detail).toMatchObject({ subscriptionId: 'sub_netflix', status: 'CANCELLED' });

    // No side effect from the rejected call — still exactly the one CANCELLED row.
    const row = await getTestPrisma().subscription.findUnique({ where: { id: 'sub_netflix' } });
    expect(row?.status).toBe('CANCELLED');
  });

  it("an unknown subscription id → throws AppError('NOT_FOUND')", async () => {
    const error = await captureAppError(banking.subscription.cancelSubscription('nope'), 'NOT_FOUND');
    expect(error.detail).toMatchObject({ subscriptionId: 'nope' });

    // Nothing was created or mutated.
    expect(await getTestPrisma().subscription.findMany()).toHaveLength(4);
  });
});

describe('banking-sdk/subscription · setSubscriptionReminder', () => {
  it('sets remind true and returns the updated view', async () => {
    const updated = await banking.subscription.setSubscriptionReminder('sub_spotify', true);
    expect(updated).toMatchObject({
      id: 'sub_spotify',
      name: 'Spotify',
      amount: 15,
      cycle: 'MONTHLY',
      status: 'ACTIVE',
      remind: true,
    });

    // Persisted to the row …
    const row = await getTestPrisma().subscription.findUnique({ where: { id: 'sub_spotify' } });
    expect(row?.remind).toBe(true);
    // … and visible through the read facade.
    expect(findById(await banking.subscription.listSubscriptions(DEMO_USER_ID), 'sub_spotify').remind).toBe(true);
  });

  it('toggles remind back to false', async () => {
    expect((await banking.subscription.setSubscriptionReminder('sub_spotify', true)).remind).toBe(true);

    const off = await banking.subscription.setSubscriptionReminder('sub_spotify', false);
    expect(off).toMatchObject({ id: 'sub_spotify', name: 'Spotify', status: 'ACTIVE', remind: false });

    const row = await getTestPrisma().subscription.findUnique({ where: { id: 'sub_spotify' } });
    expect(row?.remind).toBe(false);
  });

  it("an unknown subscription id → throws AppError('NOT_FOUND')", async () => {
    const error = await captureAppError(banking.subscription.setSubscriptionReminder('nope', true), 'NOT_FOUND');
    expect(error.detail).toMatchObject({ subscriptionId: 'nope' });
  });

  it("a non-boolean remind → throws AppError('VALIDATION')", async () => {
    await captureAppError(
      banking.subscription.setSubscriptionReminder('sub_spotify', 'yes' as unknown as boolean),
      'VALIDATION',
    );

    const row = await getTestPrisma().subscription.findUnique({ where: { id: 'sub_spotify' } });
    expect(row?.remind).toBe(false);
  });
});

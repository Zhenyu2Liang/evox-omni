/**
 * Unit: banking-sdk/subscription — subscription reads & mutations (execute only; tier policy in security/).
 *
 * Targets `@/banking-sdk` → banking.subscription.listSubscriptions/cancelSubscription/setSubscriptionReminder
 * (+ type SubscriptionView from '@/banking-sdk').
 *
 * Reads and writes Subscription rows via Prisma → requires test SQLite via ../helpers/db.
 */
import { describe, it } from 'vitest';

// import { banking } from '@/banking-sdk';                       // <- uncomment in Phase 2
// import type { SubscriptionView } from '@/banking-sdk';
// import { AppError } from '@/lib/errors';

describe('banking-sdk/subscription · listSubscriptions', () => {
  it.todo("returns the user's active subscriptions mapped to SubscriptionView");
  it.todo('a cancelled subscription is excluded from the active list');
  it.todo('every view carries id / name / amount / cycle / nextChargeAt / status / remind');
});

describe('banking-sdk/subscription · cancelSubscription', () => {
  it.todo('flips status ACTIVE → CANCELLED and returns the updated SubscriptionView');
  it.todo('re-cancelling an already CANCELLED subscription surfaces an AppError (illegal transition)');
  it.todo("an unknown subscription id → throws AppError('NOT_FOUND')");
});

describe('banking-sdk/subscription · setSubscriptionReminder', () => {
  it.todo('sets remind true and returns the updated view');
  it.todo('toggles remind back to false');
  it.todo("an unknown subscription id → throws AppError('NOT_FOUND')");
});

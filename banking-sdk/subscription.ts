/**
 * Banking SDK — subscription reads & mutations. Executes only; tier policy lives in `security/`.
 */
import type { SubscriptionView } from './types';

/** All subscriptions owned by the user. */
export async function listSubscriptions(userId: string): Promise<SubscriptionView[]> {
  throw new Error('not implemented');
}

/** Cancel a subscription (status → CANCELLED); returns the updated subscription. */
export async function cancelSubscription(id: string): Promise<SubscriptionView> {
  throw new Error('not implemented');
}

/** Toggle the renewal reminder on a subscription; returns the updated subscription. */
export async function setSubscriptionReminder(
  id: string,
  remind: boolean,
): Promise<SubscriptionView> {
  throw new Error('not implemented');
}

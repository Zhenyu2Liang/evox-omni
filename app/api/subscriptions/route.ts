/**
 * GET /api/subscriptions — subscriptions read model (used by the client to refresh the
 * `/subscriptions` page).
 *
 * Contract:
 *  - Query (validated with `subscriptionsQuerySchema`): `{ userId?: string }`.
 *  - Delegates to `@/banking-sdk`: `banking.subscription.listSubscriptions(userId)` (GREEN read).
 *  - Success: `200 { ok: true, data: { subscriptions: SubscriptionView[] } }`.
 *
 * Note: subscription MUTATIONS (cancel / toggle reminder) are gated tools the agent invokes
 * through the Security Gateway — not exposed here.
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
import { banking, type SubscriptionView } from '@/banking-sdk';
import { userIdQuerySchema } from '../_lib/schemas';

/** Query schema for `GET /api/subscriptions`. */
export const subscriptionsQuerySchema = userIdQuerySchema;

/** Success payload shape for `GET /api/subscriptions`. */
export interface SubscriptionsData {
  subscriptions: SubscriptionView[];
}

export async function GET(_req: NextRequest): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void banking;

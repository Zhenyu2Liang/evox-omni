/**
 * GET /api/subscriptions — subscriptions read model (used by the client to refresh the
 * `/subscriptions` page).
 *
 * Contract:
 *  - NO query params (a `?userId=`/`?sessionId=` param is IGNORED — identity is never query-trusted).
 *  - The user is the single seeded demo user, resolved SERVER-SIDE from runtime config only
 *    (`_lib/session#resolveUserId`) — the NON-AUTHORITATIVE demo-read user for this simulated-data
 *    read. It is never used for any auth/ownership decision.
 *  - Delegates to `@/banking-sdk`: `banking.subscription.listSubscriptions(userId)` (GREEN read).
 *  - Success: `200 { ok: true, data: { subscriptions: SubscriptionView[] } }`.
 *
 * Note: subscription MUTATIONS (cancel / toggle reminder) are gated tools the agent invokes
 * through the Security Gateway — not exposed here.
 */
import type { NextRequest } from 'next/server';
import { banking, type SubscriptionView } from '@/banking-sdk';
import { errorResponse, jsonResponse } from '../_lib/http';
import { resolveUserId } from '../_lib/session';

/** Success payload shape for `GET /api/subscriptions`. */
export interface SubscriptionsData {
  subscriptions: SubscriptionView[];
}

export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const userId = resolveUserId();
    const subscriptions = await banking.subscription.listSubscriptions(userId);
    const data: SubscriptionsData = { subscriptions };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}

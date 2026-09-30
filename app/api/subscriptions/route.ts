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
 */
import type { NextRequest } from 'next/server';
import { banking, type SubscriptionView } from '@/banking-sdk';
import { errorResponse, jsonResponse, parseQuery } from '../_lib/http';
import { userIdQuerySchema } from '../_lib/schemas';
import { resolveUserId } from '../_lib/session';

/** Query schema for `GET /api/subscriptions` (private — a Next route may only export handlers). */
const subscriptionsQuerySchema = userIdQuerySchema;

/** Success payload shape for `GET /api/subscriptions`. */
export interface SubscriptionsData {
  subscriptions: SubscriptionView[];
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    parseQuery(subscriptionsQuerySchema, req);
    const userId = resolveUserId(req);
    const subscriptions = await banking.subscription.listSubscriptions(userId);
    const data: SubscriptionsData = { subscriptions };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}

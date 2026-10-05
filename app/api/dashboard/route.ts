/**
 * GET /api/dashboard — dashboard read model (used by the client to refresh the `/` page).
 *
 * Contract:
 *  - NO query params (a `?userId=`/`?sessionId=` param is IGNORED — identity is never query-trusted).
 *  - The user is the single seeded demo user, resolved SERVER-SIDE from runtime config only
 *    (`_lib/session#resolveUserId`) — the NON-AUTHORITATIVE demo-read user for this simulated-data
 *    read. It is never used for any auth/ownership decision.
 *  - Delegates to `@/banking-sdk`: `banking.dashboard.getDashboardSummary(userId)` (GREEN read).
 *  - Success: `200 { ok: true, data: DashboardSummary }`.
 */
import type { NextRequest } from 'next/server';
import { banking, type DashboardSummary } from '@/banking-sdk';
import { errorResponse, jsonResponse } from '../_lib/http';
import { resolveUserId } from '../_lib/session';

export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const userId = resolveUserId();
    const data: DashboardSummary = await banking.dashboard.getDashboardSummary(userId);
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { DashboardSummary };

/**
 * GET /api/dashboard — dashboard read model (used by the client to refresh the `/` page).
 *
 * Contract:
 *  - Query (validated with `dashboardQuerySchema`): `{ userId?: string }`.
 *  - Delegates to `@/banking-sdk`: `banking.dashboard.getDashboardSummary(userId)` (GREEN read).
 *  - Success: `200 { ok: true, data: DashboardSummary }`.
 */
import type { NextRequest } from 'next/server';
import { banking, type DashboardSummary } from '@/banking-sdk';
import { errorResponse, jsonResponse, parseQuery } from '../_lib/http';
import { userIdQuerySchema } from '../_lib/schemas';
import { resolveUserId } from '../_lib/session';

/** Query schema for `GET /api/dashboard` (private — a Next route may only export handlers). */
const dashboardQuerySchema = userIdQuerySchema;

export async function GET(req: NextRequest): Promise<Response> {
  try {
    parseQuery(dashboardQuerySchema, req);
    const userId = resolveUserId(req);
    const data: DashboardSummary = await banking.dashboard.getDashboardSummary(userId);
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { DashboardSummary };

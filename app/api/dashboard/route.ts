/**
 * GET /api/dashboard — dashboard read model (used by the client to refresh the `/` page).
 *
 * Contract:
 *  - Query (validated with `dashboardQuerySchema`): `{ userId?: string }`.
 *  - Delegates to `@/banking-sdk`: `banking.dashboard.getDashboardSummary(userId)` (GREEN read).
 *  - Success: `200 { ok: true, data: DashboardSummary }`.
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
import { banking, type DashboardSummary } from '@/banking-sdk';
import { userIdQuerySchema } from '../_lib/schemas';

/** Query schema for `GET /api/dashboard`. */
export const dashboardQuerySchema = userIdQuerySchema;

export async function GET(_req: NextRequest): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void banking;
export type { DashboardSummary };

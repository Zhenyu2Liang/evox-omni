/**
 * POST /api/actions/[id]/cancel — cancel a pending action (no execution).
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Delegates to the agent runtime `cancel(actionId, onEvent?)` (`@/agent`); marks the pending
 *    action `cancelled` and records an audit `cancelled` entry.
 *  - Success: `200 { ok: true, data: ActionResponse }` with `data.status === 'cancelled'`.
 *  - Unknown/expired action → `404 NOT_FOUND` (error envelope).
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
// Agent runtime contract (owner: `@/agent`).
import { cancel } from '@/agent';
import type { ActionResponse, IdRouteContext } from '../../_lib/types';

export async function POST(_req: NextRequest, _ctx: IdRouteContext): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void cancel;
export type { ActionResponse };

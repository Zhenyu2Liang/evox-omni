/**
 * POST /api/actions/[id]/confirm — confirm a YELLOW (or already-verified RED) pending action.
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Delegates to the agent runtime `confirm(actionId, onEvent?)` (`@/agent`), which executes the
 *    ORIGINAL validated args through the Security Gateway's authorized path — never from model text.
 *  - Success: `200 { ok: true, data: ActionResponse }`. The action being still `pending`, already
 *    settled, or a `data.ok === false` outcome is a normal 200 (domain outcome, not HTTP error).
 *  - Unknown/expired action → `404 NOT_FOUND`; circuit open → `423 CIRCUIT_OPEN` (error envelope).
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
// Agent runtime contract (owner: `@/agent`).
import { confirm } from '@/agent';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

export async function POST(_req: NextRequest, _ctx: IdRouteContext): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void confirm;
export type { ActionResponse };

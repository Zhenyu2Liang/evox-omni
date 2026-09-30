/**
 * POST /api/actions/[id]/cancel — cancel a pending action (no execution).
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Delegates to the agent runtime `cancel(actionId)` (`@/agent`); marks the pending action
 *    `cancelled` and records an audit `cancelled` entry.
 *  - Success: `200 { ok: true, data: ActionResponse }` with `data.status === 'cancelled'`.
 *  - Unknown/expired action → `404 NOT_FOUND` (error envelope).
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
// Agent runtime contract (owner: `@/agent`).
import { cancel } from '@/agent';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { errorResponse, jsonResponse } from '../../../_lib/http';
import { resolveSessionId } from '../../../_lib/session';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;
    const outcome = await cancel(id);

    // `ConfirmationOutcome` does not carry the session id: resolve it from the persisted
    // `PendingAction` row, falling back to the request session (cookie/query) when absent.
    const sessionId = (await getPendingAction(id))?.sessionId ?? resolveSessionId(req) ?? '';

    const mapped: ActionResponse = {
      actionId: outcome.actionId,
      sessionId,
      ok: outcome.ok,
      status: outcome.status,
      tier: outcome.tier,
      requiresMfa: outcome.tier === 'RED',
      mfaResult: 'not_required',
      message: outcome.message,
      events: outcome.events,
    };

    return jsonResponse<ActionResponse>(mapped);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { ActionResponse };

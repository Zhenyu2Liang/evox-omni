/**
 * POST /api/actions/[id]/confirm — confirm a YELLOW (or already-verified RED) pending action.
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Delegates to the agent runtime `confirm(actionId)` (`@/agent`), which executes the ORIGINAL
 *    validated args through the Security Gateway's authorized path — never from model text.
 *  - Success: `200 { ok: true, data: ActionResponse }`. The action being still `pending`, already
 *    settled, or a `data.ok === false` outcome is a normal 200 (domain outcome, not HTTP error).
 *  - Unknown/expired action → `404 NOT_FOUND`; circuit open → `423 CIRCUIT_OPEN` (error envelope).
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
// Agent runtime contract (owner: `@/agent`).
import { confirm } from '@/agent';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { errorResponse, jsonResponse } from '../../../_lib/http';
import { resolveSessionId } from '../../../_lib/session';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;
    const outcome = await confirm(id);

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

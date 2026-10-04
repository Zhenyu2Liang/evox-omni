/**
 * POST /api/actions/[id]/confirm — confirm a YELLOW (or already-verified RED) pending action.
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Ownership guard: the caller's session/user must own the pending action; an explicit mismatch
 *    is rejected with `403 SECURITY_DENIED`.
 *  - Delegates to the agent runtime via `_lib/agent-bridge` `confirmOwned(id, { userId, sessionId })`
 *    (`@/agent`), which executes the ORIGINAL validated args through the Security Gateway's
 *    authorized path — never from model text.
 *  - Success: `200 { ok: true, data: ActionResponse }`. The action being still `pending`, already
 *    settled, or a `data.ok === false` outcome is a normal 200 (domain outcome, not HTTP error).
 *  - Unknown/expired action → `404 NOT_FOUND`; not the owner → `403 SECURITY_DENIED`; circuit open →
 *    `423 CIRCUIT_OPEN` (error envelope).
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { confirmOwned } from '../../../_lib/agent-bridge';
import { errorResponse, jsonResponse } from '../../../_lib/http';
import { resolveSessionId, resolveUserId } from '../../../_lib/session';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;
    const sessionId = resolveSessionId(req);
    const userId = resolveUserId(req);

    // Ownership guard: a caller may only settle its OWN pending action. Only an explicit mismatch
    // is rejected — when no session is resolvable we do NOT invent one.
    const row = await getPendingAction(id);
    if (
      row &&
      ((sessionId !== undefined && row.sessionId !== sessionId) || row.userId !== userId)
    ) {
      throw new AppError('SECURITY_DENIED', '无权确认该操作。');
    }

    const outcome = await confirmOwned(id, { userId, sessionId });

    // `ConfirmationOutcome` does not carry the session id: derive it from the persisted
    // `PendingAction` row, falling back to the request session (cookie/query) when absent.
    const responseSessionId = row?.sessionId ?? sessionId ?? '';

    const mapped: ActionResponse = {
      actionId: outcome.actionId,
      sessionId: responseSessionId,
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

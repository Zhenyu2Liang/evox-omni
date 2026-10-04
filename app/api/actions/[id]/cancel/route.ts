/**
 * POST /api/actions/[id]/cancel — cancel a pending action (no execution).
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Ownership guard: the caller's session/user must own the pending action; an explicit mismatch
 *    is rejected with `403 SECURITY_DENIED`.
 *  - Delegates to the agent runtime via `_lib/agent-bridge` `cancelOwned(id, { userId, sessionId })`
 *    (`@/agent`); marks the pending action `cancelled` and records an audit `cancelled` entry.
 *  - Success: `200 { ok: true, data: ActionResponse }` with `data.status === 'cancelled'`.
 *  - Unknown/expired action → `404 NOT_FOUND`; not the owner → `403 SECURITY_DENIED` (error envelope).
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { cancelOwned } from '../../../_lib/agent-bridge';
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
      throw new AppError('SECURITY_DENIED', '无权取消该操作。');
    }

    const outcome = await cancelOwned(id, { userId, sessionId });

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

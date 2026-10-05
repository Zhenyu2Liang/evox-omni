/**
 * POST /api/actions/[id]/cancel — cancel a pending action (no execution).
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - IDENTITY: the caller's session/user come from the TRUSTED `banking_session` cookie
 *    (`_lib/session#requireIdentity`); a missing cookie or unknown session → `403 SECURITY_DENIED`.
 *    A `?sessionId=` / `?userId=` query param is IGNORED and can never widen access.
 *  - Existence + ownership: evaluated only AFTER identity is established — an unknown action id is
 *    `404 NOT_FOUND`; an action owned by a DIFFERENT session/user is `403 SECURITY_DENIED`.
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
import { requireIdentity } from '../../../_lib/session';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;

    // Trusted identity: cookie-only, server-validated. Missing cookie / unknown session → 403.
    const identity = await requireIdentity(req);
    const { sessionId, userId } = identity;

    // Existence first: an unknown action id is `404 NOT_FOUND`, distinct from a forbidden one.
    const row = await getPendingAction(id);
    if (!row) {
      throw new AppError('NOT_FOUND', `未找到待处理的操作: ${id}`);
    }

    // Ownership guard: a caller may only settle its OWN pending action (mismatch → 403).
    if (row.sessionId !== sessionId || row.userId !== userId) {
      throw new AppError('SECURITY_DENIED', '无权取消该操作。');
    }

    const outcome = await cancelOwned(id, { userId, sessionId });

    // `ConfirmationOutcome` does not carry the session id: derive it from the persisted
    // `PendingAction` row (the caller is already known to own it).
    const responseSessionId = row.sessionId;

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

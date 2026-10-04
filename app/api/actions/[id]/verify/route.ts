/**
 * POST /api/actions/[id]/verify — submit the MFA code for a RED pending action.
 *
 * Contract:
 *  - Body: `{ code: string }` (validated with the non-exported `mfaVerifySchema`).
 *  - Ownership guard: the caller's session/user must own the pending action; an explicit mismatch
 *    is rejected with `403 SECURITY_DENIED`.
 *  - Delegates to the agent runtime via `_lib/agent-bridge` `verifyOwned(id, code, { userId, sessionId })`
 *    (`@/agent`), which checks the code against the mock MFA value and, on success, executes the
 *    original validated args.
 *  - A WRONG code is a NORMAL 200 with `data.ok === false` and `data.status === 'awaiting_mfa'`
 *    (`mfaResult: 'failed'`); three consecutive failures trip the circuit breaker (`423`).
 *  - The MFA code is NEVER echoed back in any response body (only `mfaResult` is reported).
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { verifyOwned } from '../../../_lib/agent-bridge';
import { errorResponse, jsonResponse, parseBody } from '../../../_lib/http';
import { resolveSessionId, resolveUserId } from '../../../_lib/session';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

/** Request body schema for `POST /api/actions/[id]/verify`. */
const mfaVerifySchema = z.object({
  code: z.string().min(1),
});
export type MfaVerifyBody = z.infer<typeof mfaVerifySchema>;

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;
    const { code } = await parseBody(mfaVerifySchema, req);
    const sessionId = resolveSessionId(req);
    const userId = resolveUserId(req);

    // Ownership guard: a caller may only settle its OWN pending action. Only an explicit mismatch
    // is rejected — when no session is resolvable we do NOT invent one.
    const row = await getPendingAction(id);
    if (
      row &&
      ((sessionId !== undefined && row.sessionId !== sessionId) || row.userId !== userId)
    ) {
      throw new AppError('SECURITY_DENIED', '无权验证该操作。');
    }

    const outcome = await verifyOwned(id, code, { userId, sessionId });

    // `ConfirmationOutcome` does not carry the session id: derive it from the persisted
    // `PendingAction` row, falling back to the request session (cookie/query) when absent.
    const responseSessionId = row?.sessionId ?? sessionId ?? '';

    const mfaResult = outcome.ok
      ? 'success'
      : outcome.status === 'awaiting_mfa'
        ? 'failed'
        : 'not_required';

    const mapped: ActionResponse = {
      actionId: outcome.actionId,
      sessionId: responseSessionId,
      ok: outcome.ok,
      status: outcome.status,
      tier: outcome.tier,
      requiresMfa: outcome.tier === 'RED',
      mfaResult,
      message: outcome.message,
      events: outcome.events,
    };

    return jsonResponse<ActionResponse>(mapped);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { ActionResponse };

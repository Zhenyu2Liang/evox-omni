/**
 * POST /api/actions/[id]/verify — submit the MFA code for a RED pending action.
 *
 * Contract:
 *  - Body: `{ code: string }` (validated with the non-exported `mfaVerifySchema`).
 *  - IDENTITY: the caller's session/user come from the TRUSTED `banking_session` cookie
 *    (`_lib/session#requireIdentity`); a missing cookie or unknown session → `403 SECURITY_DENIED`.
 *    A `?sessionId=` / `?userId=` query param is IGNORED and can never widen access.
 *  - Ownership guard: the caller's (trusted) session/user must own the pending action; a mismatch
 *    is rejected with `403 SECURITY_DENIED`.
 *  - Delegates to the agent runtime via `_lib/agent-bridge` `verifyOwned(id, code, { userId, sessionId })`
 *    (`@/agent`), which checks the code against the mock MFA value and, on success, executes the
 *    original validated args.
 *  - On success, appends a refreshed `plan_update` to `events` when the verified action parked a DAG
 *    plan node, so `/agent` can refresh its plan view (the plan is located BEFORE the verify).
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
import { verifyOwned, locateOwningPlan, withPlanUpdate } from '../../../_lib/agent-bridge';
import { errorResponse, jsonResponse, parseBody } from '../../../_lib/http';
import { requireIdentity } from '../../../_lib/session';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

/** Request body schema for `POST /api/actions/[id]/verify`. */
const mfaVerifySchema = z.object({
  code: z.string().min(1),
});
export type MfaVerifyBody = z.infer<typeof mfaVerifySchema>;

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;

    // Trusted identity: cookie-only, server-validated. Missing cookie / unknown session → 403.
    const identity = await requireIdentity(req);
    const { sessionId, userId } = identity;

    const { code } = await parseBody(mfaVerifySchema, req);

    // Ownership guard: a caller may only settle its OWN pending action.
    const row = await getPendingAction(id);
    if (row && (row.sessionId !== sessionId || row.userId !== userId)) {
      throw new AppError('SECURITY_DENIED', '无权验证该操作。');
    }

    // Locate the plan node parked on this action BEFORE verifying — resuming the plan clears the
    // node's `pendingActionId`, after which the reverse lookup finds nothing. A plain (non-plan)
    // action simply returns `undefined`.
    const located = await locateOwningPlan(row?.sessionId, id);
    const outcome = await verifyOwned(id, code, { userId, sessionId });
    // Forward a refreshed `plan_update` so `/agent` refreshes its plan view after the decision.
    const outcomeWithPlan = await withPlanUpdate(outcome, located);

    // `ConfirmationOutcome` does not carry the session id: derive it from the persisted
    // `PendingAction` row, falling back to the trusted identity.
    const responseSessionId = row?.sessionId ?? sessionId;

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
      requiresMfa: outcome.status === 'awaiting_mfa' || outcome.tier === 'RED',
      mfaResult,
      message: outcome.message,
      events: outcomeWithPlan.events,
    };

    return jsonResponse<ActionResponse>(mapped);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { ActionResponse };

/**
 * POST /api/actions/[id]/verify — submit the MFA code for a RED pending action.
 *
 * Contract:
 *  - Body: `{ code: string }` (validated with the non-exported `mfaVerifySchema`).
 *  - Delegates to the agent runtime `verify(actionId, code)` (`@/agent`), which checks the code
 *    against the mock MFA value and, on success, executes the original validated args.
 *  - A WRONG code is a NORMAL 200 with `data.ok === false` and `data.status === 'awaiting_mfa'`
 *    (`mfaResult: 'failed'`); three consecutive failures trip the circuit breaker (`423`).
 *  - The MFA code is NEVER echoed back in any response body (only `mfaResult` is reported).
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
// Agent runtime contract (owner: `@/agent`).
import { verify } from '@/agent';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { errorResponse, jsonResponse, parseBody } from '../../../_lib/http';
import { resolveSessionId } from '../../../_lib/session';
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
    const outcome = await verify(id, code);

    // `ConfirmationOutcome` does not carry the session id: resolve it from the persisted
    // `PendingAction` row, falling back to the request session (cookie/query) when absent.
    const sessionId = (await getPendingAction(id))?.sessionId ?? resolveSessionId(req) ?? '';

    const mfaResult = outcome.ok
      ? 'success'
      : outcome.status === 'awaiting_mfa'
        ? 'failed'
        : 'not_required';

    const mapped: ActionResponse = {
      actionId: outcome.actionId,
      sessionId,
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

/**
 * POST /api/actions/[id]/confirm — confirm a YELLOW (or already-verified RED) pending action.
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Identity comes from the configured demo user and fixed session via `requireIdentity`.
 *    No login is required; cookies and query identifiers cannot select another workspace.
 *  - Existence + ownership: evaluated in that order and only AFTER identity is established — an
 *    unknown action id is `404 NOT_FOUND`; an action owned by a DIFFERENT session/user is
 *    `403 SECURITY_DENIED`.
 *  - Delegates to the agent runtime via `_lib/agent-bridge` `confirmOwned(id, { userId, sessionId })`
 *    (`@/agent`), which executes the ORIGINAL validated args through the Security Gateway's
 *    authorized path — never from model text.
 *  - On success, appends a refreshed `plan_update` to `events` when the confirmed action parked a DAG
 *    plan node, so `/agent` can refresh its plan view (the plan is located BEFORE the confirm).
 *  - MFA ESCALATION: when the confirm escalates (a RED action reaching confirm without a code, so
 *    `status === 'awaiting_mfa'`), the response surfaces `requiresMfa: true` and injects a
 *    `{ type:'mfa_required', actionId, hint }` event so the UI can prompt for the 6-digit code.
 *    The MFA CODE is NEVER included.
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
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import { confirmOwned, locateOwningPlan, withPlanUpdate } from '../../../_lib/agent-bridge';
import { errorResponse, jsonResponse } from '../../../_lib/http';
import { requireIdentity } from '../../../_lib/session';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

/** Safe, code-free prompt shown when a RED action must still collect its MFA code. */
const MFA_REQUIRED_HINT = '请输入 6 位短信验证码。';

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;

    // Resolve the fixed demo workspace before checking persisted action ownership.
    const identity = await requireIdentity(req);
    const { sessionId, userId } = identity;

    // Existence first: an unknown action id is `404 NOT_FOUND`, distinct from a forbidden one.
    const row = await getPendingAction(id);
    if (!row) {
      throw new AppError('NOT_FOUND', `未找到待处理的操作: ${id}`);
    }

    // Ownership guard: a caller may only settle its OWN pending action (mismatch → 403).
    if (row.sessionId !== sessionId || row.userId !== userId) {
      throw new AppError('SECURITY_DENIED', '无权确认该操作。');
    }

    // Locate the plan node parked on this action BEFORE confirming — resuming the plan clears the
    // node's `pendingActionId`, after which the reverse lookup finds nothing. A plain (non-plan)
    // action simply returns `undefined`.
    const located = await locateOwningPlan(row.sessionId, id);
    const outcome = await confirmOwned(id, { userId, sessionId });
    // Forward a refreshed `plan_update` so `/agent` refreshes its plan view after the decision.
    const outcomeWithPlan = await withPlanUpdate(outcome, located);

    // `ConfirmationOutcome` does not carry the session id: derive it from the persisted
    // `PendingAction` row (the caller is already known to own it).
    const responseSessionId = row.sessionId;

    // Escalation: a RED action reaching confirm without a code returns `status === 'awaiting_mfa'`.
    // Surface it so the UI prompts for the MFA code; inject the code-free `mfa_required` event.
    const requiresMfa = outcome.status === 'awaiting_mfa' || outcome.tier === 'RED';
    const awaitingMfa = (outcome.status === 'pending' || outcome.status === 'awaiting_mfa') && requiresMfa;
    const alreadySignalled = outcomeWithPlan.events.some((event) => event.type === 'mfa_required');
    const events: AgentStreamEvent[] =
      awaitingMfa && !alreadySignalled
        ? [
            { type: 'mfa_required', actionId: id, hint: MFA_REQUIRED_HINT },
            ...outcomeWithPlan.events,
          ]
        : outcomeWithPlan.events;

    const mapped: ActionResponse = {
      actionId: outcome.actionId,
      sessionId: responseSessionId,
      ok: outcome.ok,
      status: outcome.status,
      tier: outcome.tier,
      requiresMfa,
      mfaResult: 'not_required',
      message: outcome.message,
      events,
    };

    return jsonResponse<ActionResponse>(mapped);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { ActionResponse };

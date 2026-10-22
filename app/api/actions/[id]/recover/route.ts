/**
 * POST /api/actions/[id]/recover — resolve a STRANDED standalone wedge the user can reach from a
 * plain page refresh (WITHOUT needing the hidden `actionId` from another screen).
 *
 * A gated write can be left `confirmed` with NO persisted result when the SDK side effect committed
 * but the result+status transaction rolled back (or the process died). Such a row is surfaced by
 * `GET /api/actions` (attention `recoverable` / `reconciliation`) but, unlike a `pending` action, it
 * can never be re-confirmed (the gateway's exactly-once CAS no longer matches `pending`). This route
 * is the recovery ENTRY POINT for it.
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Identity comes from the configured demo user and fixed session via `requireIdentity`.
 *    No login is required; cookies and query identifiers cannot select another workspace.
 *  - Existence + ownership: evaluated in that order and only AFTER identity is established — an
 *    unknown action id is `404 NOT_FOUND`; an action owned by a DIFFERENT session/user is
 *    `403 SECURITY_DENIED`.
 *  - TERMINAL LOCK: exhausting the MFA attempt limit (or an already-open session circuit breaker)
 *    persists the row as `'locked'`, which is TERMINAL. A locked action is NEVER recoverable — it can
 *    never be executed, verifiable or cancelled again and must never be written back to
 *    `pending`/`awaiting_mfa` — so it is answered BEFORE any delegation: a normal `200` DOMAIN refusal
 *    (`data.ok === false`) carrying `status: 'locked'`, `mfaResult: 'not_required'`, the typed
 *    `code: 'CIRCUIT_OPEN'` plus the structured `failure` (`reason: 'mfa_session_locked'`) and a fixed
 *    safe sentence, with NO `recoverOwned` call, NO write and NO events.
 *  - Every other status still delegates to the agent runtime via `_lib/agent-bridge`
 *    `recoverOwned(id, { userId, sessionId })` (`@/agent`), which resolves the TRUSTED identity from
 *    PERSISTED state (a request-supplied assertion that mismatches FAILS CLOSED) and runs the
 *    receipt-first standalone recovery. The ORIGINAL validated args are what gets recovered/replayed —
 *    never model text. A non-locked refusal forwards the outcome's typed `code`/`failure` (with its
 *    `attemptsLeft`/`maxAttempts` when present), exactly like the confirm/verify routes.
 *  - The tool is NEVER re-invoked on a mere guess: a committed receipt is settled from directly; a
 *    proven-idempotent tool is replayed on its ledger key; any other wedge is transitioned to the
 *    queryable `needs_reconciliation` state. When there is genuinely nothing to recover the outcome
 *    is an honest `ok:false` carrying the row's CURRENT persisted status — never a fabricated
 *    success.
 *  - Success: `200 { ok: true, data: ActionResponse }`. A no-op / non-recoverable outcome is a
 *    normal 200 with `data.ok === false` (domain outcome, not an HTTP error).
 *  - Unknown/expired action → `404 NOT_FOUND`; not the owner → `403 SECURITY_DENIED`.
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { RiskLevel } from '@/lib/contracts/risk';
import { recoverOwned } from '../../../_lib/agent-bridge';
import { errorResponse, jsonResponse } from '../../../_lib/http';
import { isLockedPendingActionRow, lockedActionRefusal } from '../../../_lib/locked-action';
import { requireIdentity } from '../../../_lib/session';
import type { ActionResponse, IdRouteContext } from '../../../_lib/types';

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

    // Ownership guard: a caller may only recover its OWN pending action (mismatch → 403).
    if (row.sessionId !== sessionId || row.userId !== userId) {
      throw new AppError('SECURITY_DENIED', '无权恢复该操作。');
    }

    // TERMINAL LOCK: a locked row is never handed to `recoverOwned` — nothing is replayed, nothing is
    // written. The refusal is a normal DOMAIN outcome (`data.ok === false`).
    if (isLockedPendingActionRow(row)) {
      const refusal = lockedActionRefusal(id, row);
      const locked: ActionResponse = {
        actionId: id,
        sessionId: row.sessionId,
        ok: false,
        status: 'locked',
        tier: row.riskLevel as RiskLevel,
        requiresMfa: row.requiresMfa || row.riskLevel === 'RED',
        mfaResult: 'not_required',
        code: refusal.code,
        failure: refusal.failure,
        message: refusal.message,
        events: [],
      };
      return jsonResponse<ActionResponse>(locked);
    }

    // The recovery itself is delegated to the agent runtime, which RE-resolves the trusted identity
    // from PERSISTED state (the row + its owning session) and fails closed on any mismatch.
    const outcome = await recoverOwned(id, { userId, sessionId });

    const events: AgentStreamEvent[] = outcome.events;

    // `ConfirmationOutcome` does not carry the session id: derive it from the persisted row (the
    // caller is already known to own it).
    const mapped: ActionResponse = {
      actionId: outcome.actionId,
      sessionId: row.sessionId,
      ok: outcome.ok,
      status: outcome.status,
      tier: outcome.tier,
      requiresMfa: outcome.requiresMfa,
      mfaResult: 'not_required',
      message: outcome.message,
      ...(outcome.code ? { code: outcome.code } : {}),
      ...(outcome.failure
        ? {
            failure: outcome.failure,
            attemptsLeft: outcome.failure.attemptsLeft,
            maxAttempts: outcome.failure.maxAttempts,
          }
        : {}),
      events,
    };

    return jsonResponse<ActionResponse>(mapped);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { ActionResponse };

/**
 * POST /api/actions/[id]/cancel — cancel a pending action (no execution).
 *
 * Contract:
 *  - Body: `{}` (the action id comes from the path via `IdRouteContext`).
 *  - Identity comes from the configured demo user and fixed session via `requireIdentity`.
 *    No login is required; cookies and query identifiers cannot select another workspace.
 *  - Existence + ownership: evaluated only AFTER identity is established — an unknown action id is
 *    `404 NOT_FOUND`; an action owned by a DIFFERENT session/user is `403 SECURITY_DENIED`.
 *  - TERMINAL LOCK: exhausting the MFA attempt limit (or an already-open session circuit breaker)
 *    persists the row as `'locked'`, which is TERMINAL. A locked action can never be cancelled,
 *    confirmed, verified or recovered again and must never be written back to
 *    `pending`/`awaiting_mfa`, so it is answered BEFORE any delegation: a normal `200` DOMAIN refusal
 *    (`data.ok === false`) carrying `status: 'locked'`, `mfaResult: 'not_required'`, the typed
 *    `code: 'CIRCUIT_OPEN'` plus the structured `failure` (`reason: 'mfa_session_locked'`) and a
 *    fixed safe sentence — with NO `cancelOwned` call, NO write and NO events, so the row and any
 *    owning plan stay exactly as the gateway left them.
 *  - Otherwise delegates to the agent runtime via `_lib/agent-bridge` `cancelOwned(id, { userId,
 *    sessionId })` (`@/agent`); marks the pending action `cancelled` and records an audit `cancelled`
 *    entry. A non-locked refusal forwards the outcome's typed `code`/`failure` (with its
 *    `attemptsLeft`/`maxAttempts` when present), exactly like the confirm/verify routes, so a client
 *    never has to parse the message text.
 *  - Success: `200 { ok: true, data: ActionResponse }` with `data.status === 'cancelled'`.
 *  - Unknown/expired action → `404 NOT_FOUND`; not the owner → `403 SECURITY_DENIED` (error envelope).
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import type { RiskLevel } from '@/lib/contracts/risk';
import { cancelOwned } from '../../../_lib/agent-bridge';
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

    // Ownership guard: a caller may only settle its OWN pending action (mismatch → 403).
    if (row.sessionId !== sessionId || row.userId !== userId) {
      throw new AppError('SECURITY_DENIED', '无权取消该操作。');
    }

    // TERMINAL LOCK: a locked row is never handed to `cancelOwned` — no status write, no plan
    // transition, no events. The refusal is a normal DOMAIN outcome (`data.ok === false`).
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
      ...(outcome.code ? { code: outcome.code } : {}),
      ...(outcome.failure
        ? {
            failure: outcome.failure,
            attemptsLeft: outcome.failure.attemptsLeft,
            maxAttempts: outcome.failure.maxAttempts,
          }
        : {}),
      events: outcome.events,
    };

    return jsonResponse<ActionResponse>(mapped);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { ActionResponse };

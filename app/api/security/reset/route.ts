/**
 * POST /api/security/reset — clears the CURRENT account's circuit-breaker state (GATED unlock).
 *
 * Contract:
 *  - Identity: the configured demo user and fixed session via `requireIdentity`.
 *    No login is required; cookies and query identifiers cannot select another account's breaker.
 *  - Body (OPTIONAL): `{ verificationCode?: string }`. An absent/empty body is treated as `{}`.
 *  - Delegates to `@/security`: `circuitBreaker.resetSession(sessionId, { actor, reason,
 *    verificationCode })` — the AUDITED unlock: it clears the account's breaker state AND records a
 *    `SECURITY_RESET` `SecurityEvent` (never fire-and-forget), returning the fresh
 *    `CircuitBreakerState`.
 *  - GATE: the breaker is PER-ACCOUNT (shared across a user's sessions). While the account is LOCKED
 *    the unlock REQUIRES extra verification — a correct mock `verificationCode` (or an elapsed
 *    cooldown). Otherwise `resetSession` THROWS `AppError('CIRCUIT_OPEN')`, which propagates verbatim
 *    as HTTP `423` and the lock is left intact: entering the demo does not grant an unlock.
 *  - UNLOCK SEMANTICS (what an unlock does NOT do): clearing the breaker only re-permits NEW
 *    high-risk operations. An unlock NEVER reopens a TERMINAL `'locked'` `PendingAction` — the row
 *    keeps `status = 'locked'`, is never written back to `pending`/`awaiting_mfa`, gets no
 *    verification entry point and does not reappear as a pending decision. An unlock also NEVER
 *    executes anything on its own: every replacement write must be re-requested and re-confirmed
 *    through the normal authorization gate. This route performs no `PendingAction` write at all —
 *    the security node's unlock only renews the still-`awaiting_mfa` actions' MFA challenges.
 *  - Success: `200 { ok: true, data: ResetData }`; any throwable maps through the shared error
 *    envelope (`errorResponse`) — never a raw exception or the MFA code.
 *
 * This is the runtime unlock path for a tripped breaker: the gateway tells the user to
 * "前往安全中心解除限制" and the Security Center button calls this route with the mock code. The
 * breaker is a hard gate the LLM can never reset — only this explicit user action clears it.
 *
 * Thin by design: `validate (zod) → delegate → serialize`. No business logic, no Prisma here.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { security } from '@/security';
import { jsonResponse, errorResponse, parseOptionalBody } from '../../_lib/http';
import { requireIdentity } from '../../_lib/session';

/** Optional request body for `POST /api/security/reset` (the body may be omitted entirely). */
const resetBodySchema = z.object({
  /** Mock strong-verification code; the breaker requires it to clear a LOCKED account. */
  verificationCode: z.string().optional(),
});
type ResetBody = z.infer<typeof resetBodySchema>;

/** Audit reason recorded on the `SECURITY_RESET` event for a user-initiated security-center unlock. */
const RESET_REASON = '用户通过安全中心主动解除所属账户的安全限制。';

/**
 * An unlock never reopens or re-executes an already-locked operation — that is a property of the
 * unlock itself (terminal `'locked'` rows stay terminal), so this route reports it as such.
 */
const LOCKED_ACTIONS_REOPENED = false;

/** Success payload shape for `POST /api/security/reset`. */
export interface ResetData {
  sessionId: string;
  locked: boolean;
  failures: number;
  max: number;
  /**
   * Always `false`: an unlock only re-permits NEW high-risk operations. Operations already locked by
   * the exhausted MFA attempt limit stay terminal and are NOT reopened, and nothing is executed.
   */
  lockedActionsReopened: boolean;
  /** Safe, user-facing text. Never contains the MFA code. */
  message: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    // Resolve the fixed demo account before applying the separate unlock-verification policy.
    const identity = await requireIdentity(req);
    const sessionId = identity.sessionId;

    // OPTIONAL body: `{}` / absent is fine; `verificationCode` gates the unlock while locked.
    const { verificationCode }: ResetBody = await parseOptionalBody(resetBodySchema, req);

    // Audited, GATED unlock. When the account is locked the breaker THROWS `AppError('CIRCUIT_OPEN')`
    // unless a correct code (or an elapsed cooldown) is supplied — the refusal propagates as HTTP 423
    // and the lock is left intact.
    const state = await security.circuitBreaker.resetSession(sessionId, {
      actor: 'user',
      reason: RESET_REASON,
      ...(verificationCode ? { verificationCode } : {}),
    });

    const data: ResetData = {
      sessionId,
      locked: state.locked,
      failures: state.failures,
      max: state.max,
      lockedActionsReopened: LOCKED_ACTIONS_REOPENED,
      message: '该账户的安全熔断限制已解除，可以重新发起高风险操作。'
        + '此前已锁定的操作保持锁定且不会自动执行，请重新发起并重新确认。',
    };
    return jsonResponse<ResetData>(data);
  } catch (e) {
    return errorResponse(e);
  }
}

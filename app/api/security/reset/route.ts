/**
 * POST /api/security/reset — clears the CURRENT account's circuit-breaker state (GATED unlock).
 *
 * Contract:
 *  - IDENTITY: the session comes from the TRUSTED `banking_session` cookie
 *    (`_lib/session#requireIdentity`) and is checked FIRST (fail-closed) — a missing cookie or
 *    unknown session → `403 SECURITY_DENIED` (a body-less or bad-body request from an
 *    unauthenticated caller still gets the 403, never a 400). A `?sessionId=` query param is
 *    IGNORED — a caller can never unlock another account's breaker.
 *  - Body (OPTIONAL): `{ verificationCode?: string }`. An absent/empty body is treated as `{}`.
 *  - Delegates to `@/security`: `circuitBreaker.resetSession(sessionId, { actor, reason,
 *    verificationCode })` — the AUDITED unlock: it clears the account's breaker state AND records a
 *    `SECURITY_RESET` `SecurityEvent` (never fire-and-forget), returning the fresh
 *    `CircuitBreakerState`.
 *  - GATE: the breaker is PER-ACCOUNT (shared across a user's sessions). While the account is LOCKED
 *    the unlock REQUIRES extra verification — a correct mock `verificationCode` (or an elapsed
 *    cooldown). Otherwise `resetSession` THROWS `AppError('CIRCUIT_OPEN')`, which propagates verbatim
 *    as HTTP `423` and the lock is LEFT INTACT: a bare session cookie can NEVER unlock.
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

/** Success payload shape for `POST /api/security/reset`. */
export interface ResetData {
  sessionId: string;
  locked: boolean;
  failures: number;
  max: number;
  /** Safe, user-facing text. Never contains the MFA code. */
  message: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    // Trusted identity FIRST, fail-closed: a missing cookie / unknown session → 403 (never a 400),
    // so an unauthenticated caller posting `{}` or nothing still fails closed.
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
      message: '该账户的安全熔断限制已解除，所有操作已恢复。',
    };
    return jsonResponse<ResetData>(data);
  } catch (e) {
    return errorResponse(e);
  }
}

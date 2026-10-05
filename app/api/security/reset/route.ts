/**
 * POST /api/security/reset — clears the CURRENT session's circuit-breaker state.
 *
 * Contract:
 *  - IDENTITY: the session comes from the TRUSTED `banking_session` cookie
 *    (`_lib/session#requireIdentity`); a missing cookie or unknown session → `403 SECURITY_DENIED`.
 *    A `?sessionId=` query param is IGNORED — a caller can never unlock another session's breaker.
 *  - Delegates to `@/security`: `circuitBreaker.resetSession(sessionId, { actor, reason })` — the
 *    AUDITED unlock: it clears the session's breaker state AND records a `SECURITY_RESET`
 *    `SecurityEvent` (never fire-and-forget), returning the fresh `CircuitBreakerState`.
 *  - Success: `200 { ok: true, data: ResetData }`; any throwable maps through the shared error
 *    envelope (`errorResponse`) — never a raw exception or the MFA code.
 *
 * This is the runtime unlock path for a tripped breaker: the gateway tells the user to
 * "前往安全中心解除限制" and the Security Center button calls this route (with NO request body).
 * The breaker is a hard gate the LLM can never reset — only this explicit user action clears it.
 *
 * Thin by design: `validate (zod) → delegate → serialize`. No business logic, no Prisma here.
 */
import type { NextRequest } from 'next/server';
import { security } from '@/security';
import { jsonResponse, errorResponse } from '../../_lib/http';
import { requireIdentity } from '../../_lib/session';

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
    // Trusted identity: cookie-only, server-validated. Missing cookie / unknown session → 403.
    const identity = await requireIdentity(req);
    const sessionId = identity.sessionId;

    // Audited unlock: clears the breaker state for this session and records a
    // `SECURITY_RESET` SecurityEvent; returns the fresh state.
    const state = await security.circuitBreaker.resetSession(sessionId, { actor: 'user' });

    const data: ResetData = {
      sessionId,
      locked: state.locked,
      failures: state.failures,
      max: state.max,
      message: '本会话的熔断限制已解除。',
    };
    return jsonResponse<ResetData>(data);
  } catch (e) {
    return errorResponse(e);
  }
}

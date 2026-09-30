/**
 * POST /api/security/reset — clears the CURRENT session's circuit-breaker state.
 *
 * Contract:
 *  - Session id: `?sessionId=` query → the `banking_session` cookie → `''` (no session yet).
 *  - Delegates to `@/security`: `circuitBreaker.reset(sessionId)` (clear state) then
 *    `circuitBreaker.getState(sessionId)` (read back the fresh state).
 *  - Success: `200 { ok: true, data: ResetData }`; any throwable maps through the shared error
 *    envelope (`errorResponse`) — never a raw exception or the MFA code.
 *
 * This is the runtime unlock path for a tripped breaker: the gateway tells the user to
 * "前往安全中心解除限制" and the Security Center button calls this route. The breaker is a hard
 * gate the LLM can never reset — only this explicit user action clears it.
 *
 * Thin by design: `validate (zod) → delegate → serialize`. No business logic, no Prisma here.
 */
import type { NextRequest } from 'next/server';
import { security } from '@/security';
import { jsonResponse, errorResponse, parseQuery } from '../../_lib/http';
import { sessionIdQuerySchema } from '../../_lib/schemas';
import { resolveSessionId } from '../../_lib/session';

/**
 * Query schema for `POST /api/security/reset`.
 *
 * PRIVATE on purpose: an App Router `route.ts` may only export HTTP-method handlers (plus
 * known config fields and types) — exporting a runtime schema value breaks `next build`.
 */
const resetQuerySchema = sessionIdQuerySchema;

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
    const query = parseQuery(resetQuerySchema, req);
    const sessionId = query.sessionId ?? resolveSessionId(req) ?? '';

    // `reset` returns `void` today and may become async (it also records a SECURITY_RESET
    // SecurityEvent) — `Promise.resolve` keeps both signatures compiling and working.
    await Promise.resolve(security.circuitBreaker.reset(sessionId));
    const state = security.circuitBreaker.getState(sessionId);

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

/**
 * GET /api/security — security-center read model.
 *
 * Contract:
 *  - Session: the configured demo user's fixed workspace via `resolveIdentity`.
 *    Cookies and query identifiers cannot select another workspace. No login is required.
 *  - Delegates to `@/audit`: `getSecurityStatus(sessionId, { isLocked })` +
 *    `listSecurityEvents({ sessionId })`; the authoritative lock state is supplied by the
 *    security node's circuit breaker (`@/security` → `circuitBreaker.isLocked`).
 *  - The breaker is DB-backed and PER-ACCOUNT, so its reads are async: `circuitBreaker.getState`
 *    and `circuitBreaker.isLocked` both return a `Promise` and MUST be awaited.
 *  - Success: `200 { ok: true, data: { status; events; circuitBreaker } }`, where
 *    `circuitBreaker` surfaces the raw failure counter (`await circuitBreaker.getState`);
 *    any failure maps through the shared error envelope.
 *
 * Thin by design: `validate (zod) → delegate → serialize`. No business logic, no Prisma here.
 */
import type { NextRequest } from 'next/server';
import { audit, type SecurityStatus } from '@/audit';
import { security } from '@/security';
import type { SecurityEvent } from '@/lib/contracts/audit';
import { jsonResponse, errorResponse } from '../_lib/http';
import { resolveIdentity } from '../_lib/session';

/** Success payload shape for `GET /api/security`. */
export interface SecurityData {
  status: SecurityStatus;
  events: SecurityEvent[];
  /** Raw circuit-breaker counters for the account (failure count vs trip threshold). */
  circuitBreaker: { failures: number; max: number; locked: boolean };
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const { sessionId } = await resolveIdentity(req);

    const status = await audit.getSecurityStatus(sessionId, {
      isLocked: (sid) => security.circuitBreaker.isLocked(sid),
    });
    const events = await audit.listSecurityEvents({ sessionId });
    const breaker = await security.circuitBreaker.getState(sessionId);

    const data: SecurityData = {
      status,
      events,
      circuitBreaker: {
        failures: breaker.failures,
        max: breaker.max,
        locked: breaker.locked,
      },
    };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * GET /api/security — security-center read model.
 *
 * Contract:
 *  - Query (validated with the private `securityQuerySchema`): `{ sessionId?: string }`.
 *  - Session id: `?sessionId=` → the `banking_session` cookie → `''` (no session yet).
 *  - Delegates to `@/audit`: `getSecurityStatus(sessionId, { isLocked })` +
 *    `listSecurityEvents({ sessionId })`; the authoritative lock state is supplied by the
 *    security node's circuit breaker (`@/security` → `circuitBreaker.isLocked`).
 *  - Success: `200 { ok: true, data: { status; events; circuitBreaker } }`, where
 *    `circuitBreaker` surfaces the raw failure counter (`circuitBreaker.getState`);
 *    an invalid query maps to `400 VALIDATION` through the shared error envelope.
 *
 * Thin by design: `validate (zod) → delegate → serialize`. No business logic, no Prisma here.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { audit, type SecurityStatus } from '@/audit';
import { security } from '@/security';
import type { SecurityEvent } from '@/lib/contracts/audit';
import { jsonResponse, errorResponse, parseQuery } from '../_lib/http';
import { sessionIdQuerySchema } from '../_lib/schemas';
import { resolveSessionId } from '../_lib/session';

/**
 * Query schema for `GET /api/security`.
 *
 * PRIVATE on purpose: an App Router `route.ts` may only export HTTP-method handlers (plus known
 * config fields) — exporting a runtime schema value breaks `next build`.
 */
const securityQuerySchema = sessionIdQuerySchema;
export type SecurityQuery = z.infer<typeof securityQuerySchema>;

/** Success payload shape for `GET /api/security`. */
export interface SecurityData {
  status: SecurityStatus;
  events: SecurityEvent[];
  /** Raw circuit-breaker counters for the session (failure count vs trip threshold). */
  circuitBreaker: { failures: number; max: number; locked: boolean };
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const query = parseQuery(securityQuerySchema, req);
    const sessionId = query.sessionId ?? resolveSessionId(req) ?? '';

    const status = await audit.getSecurityStatus(sessionId, {
      isLocked: (sid) => security.circuitBreaker.isLocked(sid),
    });
    const events = await audit.listSecurityEvents({ sessionId });
    const breaker = security.circuitBreaker.getState(sessionId);

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

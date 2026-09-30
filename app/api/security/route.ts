/**
 * GET /api/security — security-center read model.
 *
 * Contract:
 *  - Query (validated with `securityQuerySchema`): `{ sessionId?: string }`.
 *  - Delegates to `@/audit`: `getSecurityStatus(sessionId, { isLocked })` +
 *    `listSecurityEvents({ sessionId })`; the authoritative lock state is supplied by the
 *    security node's circuit breaker (`@/security` → `circuitBreaker.isLocked`).
 *  - Success: `200 { ok: true, data: { status: SecurityStatus; events: SecurityEvent[] } }`.
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { audit, type SecurityStatus } from '@/audit';
import { security } from '@/security';
import type { SecurityEvent } from '@/lib/contracts/audit';
import { sessionIdQuerySchema } from '../_lib/schemas';

/** Query schema for `GET /api/security`. */
export const securityQuerySchema = sessionIdQuerySchema;
export type SecurityQuery = z.infer<typeof securityQuerySchema>;

/** Success payload shape for `GET /api/security`. */
export interface SecurityData {
  status: SecurityStatus;
  events: SecurityEvent[];
}

export async function GET(_req: NextRequest): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void audit;
void security;

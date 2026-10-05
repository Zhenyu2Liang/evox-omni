/**
 * GET /api/audit — audit log read model for the audit dashboard.
 *
 * Contract:
 *  - Query (validated with the private `auditQuerySchema`):
 *    `{ toolName?, riskLevel?: 'GREEN'|'YELLOW'|'RED', status?: AuditStatus, limit? }`.
 *  - Session SCOPE: resolved SERVER-SIDE from the `banking_session` cookie
 *    (`_lib/session#resolveIdentity`); a `?sessionId=` query param is IGNORED and never widens
 *    access. When there is no session the entries are not session-scoped (the demo audit dashboard
 *    shows the demo's simulated data).
 *  - Delegates to `@/audit`: `listAudit(filter)` (entries, newest-first) + `getAuditSummary()`
 *    (aggregate badges — global, not session-scoped).
 *  - Success: `200 { ok: true, data: { entries: AuditEntry[]; summary: AuditSummary } }`;
 *    an invalid query or a delegate failure maps to the shared error envelope
 *    (`400 VALIDATION` for a schema mismatch).
 *
 * Thin by design: `validate (zod) → delegate → serialize`. No business logic, no Prisma here.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { audit, type AuditFilter, type AuditSummary } from '@/audit';
import type { AuditEntry } from '@/lib/contracts/audit';
import { jsonResponse, errorResponse, parseQuery } from '../_lib/http';
import { limitQuerySchema } from '../_lib/schemas';
import { resolveIdentity } from '../_lib/session';

/**
 * Query schema for `GET /api/audit`.
 *
 * PRIVATE on purpose: an App Router `route.ts` may only export HTTP-method handlers (plus known
 * config fields) — exporting a runtime schema value breaks `next build`.
 *
 * `status` is validated against the frozen `AuditStatus` union so the parsed value is directly
 * assignable to `AuditFilter.status`; an unknown status is rejected with `400 VALIDATION`.
 */
const auditQuerySchema = limitQuerySchema.extend({
  toolName: z.string().min(1).optional(),
  riskLevel: z.enum(['GREEN', 'YELLOW', 'RED']).optional(),
  status: z
    .enum([
      'allowed',
      'blocked',
      'waiting_confirmation',
      'waiting_verification',
      'success',
      'failed',
      'cancelled',
      'locked',
    ])
    .optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Success payload shape for `GET /api/audit`. */
export interface AuditData {
  entries: AuditEntry[];
  summary: AuditSummary;
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const query = parseQuery(auditQuerySchema, req);
    // Trusted session scope (cookie-only); a `?sessionId=` query param is never authoritative.
    const identity = await resolveIdentity(req);

    const filter: AuditFilter = {
      sessionId: identity?.sessionId,
      toolName: query.toolName,
      riskLevel: query.riskLevel,
      status: query.status,
      limit: query.limit,
    };

    const entries = await audit.listAudit(filter);
    const summary = await audit.getAuditSummary();

    return jsonResponse<AuditData>({ entries, summary });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * GET /api/audit — audit log read model for the audit dashboard.
 *
 * Contract:
 *  - Query (validated with `auditQuerySchema`):
 *    `{ sessionId?, toolName?, riskLevel?: 'GREEN'|'YELLOW'|'RED', status?, limit? }`.
 *  - Delegates to `@/audit`: `listAudit(filter)` (entries, newest-first) + `getAuditSummary()`.
 *  - Success: `200 { ok: true, data: { entries: AuditEntry[]; summary: AuditSummary } }`.
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { audit, type AuditSummary } from '@/audit';
import type { AuditEntry } from '@/lib/contracts/audit';
import { sessionIdQuerySchema, limitQuerySchema } from '../_lib/schemas';

/** Query schema for `GET /api/audit`. */
export const auditQuerySchema = sessionIdQuerySchema.merge(limitQuerySchema).extend({
  toolName: z.string().min(1).optional(),
  riskLevel: z.enum(['GREEN', 'YELLOW', 'RED']).optional(),
  status: z.string().min(1).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Success payload shape for `GET /api/audit`. */
export interface AuditData {
  entries: AuditEntry[];
  summary: AuditSummary;
}

export async function GET(_req: NextRequest): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void audit;

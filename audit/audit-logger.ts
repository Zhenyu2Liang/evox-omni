/**
 * Audit logger — the single persistence + query API for tool-call audit entries.
 *
 * Every Security Gateway decision, every gated execution (confirm / MFA), and every tool
 * mutation is appended here as an `AuditEntry` (see `@/lib/contracts/audit`). This is the
 * canonical record of the agent loop 理解 → 规划 → 执行 → 风控 → 验证 → 审计.
 *
 * Dependency direction: `lib` ← `audit`. This module is a thin wrapper over the Prisma-backed
 * repository `@/lib/db/repositories/auditLog` and MUST NOT import `security`, `agent`,
 * `planner`, or `banking-sdk` (the Security Gateway depends on THIS node for logging, so a
 * reverse import would create a cycle).
 *
 * Error strategy: audit writes are BEST-EFFORT and NEVER throw into the request path.
 * A persistence failure is logged and swallowed so the banking flow continues unaffected;
 * `recordAudit` resolves with the input entry rather than rejecting.
 */
import type { AuditEntry, AuditStatus } from '@/lib/contracts/audit';
import type { RiskLevel } from '@/lib/contracts/risk';
import { insertAuditLog, findAuditLogs, aggregateAuditLogs } from '@/lib/db/repositories/auditLog';

/**
 * Filter for {@link listAudit}. Every field is optional; results are returned newest-first.
 * Structural shape mirrors the repository filter so it can be passed straight through.
 */
export interface AuditFilter {
  sessionId?: string;
  toolName?: string;
  riskLevel?: RiskLevel;
  status?: AuditStatus;
  /** Maximum rows returned (repository applies the cap). */
  limit?: number;
}

/** Aggregate counts across the audit log, for the audit dashboard / read models. */
export interface AuditSummary {
  total: number;
  byRisk: Record<string, number>;
  byStatus: Record<string, number>;
}

/**
 * Repository bindings this module delegates to (`@/lib/db/repositories/auditLog`).
 * Exposed as a seam so tests can stub persistence without a live Prisma client.
 */
export const auditStore = { insertAuditLog, findAuditLogs, aggregateAuditLogs };

/**
 * Persist one audit entry (append-only).
 *
 * `toolResult` and `detail` are JSON-serialized by the repository. The entry MUST carry the
 * objective-required fields (timestamp, sessionId, userRequest, intent, toolName, riskLevel,
 * confirmationRequired, confirmed, mfaRequired, mfaResult, toolResult, status).
 *
 * Never rejects: on persistence failure it logs the error and resolves with the input entry.
 */
export async function recordAudit(entry: AuditEntry): Promise<AuditEntry> {
  throw new Error('not implemented');
}

/** Query audit entries, newest-first, by optional filter. Read-only. */
export async function listAudit(filter: AuditFilter): Promise<AuditEntry[]> {
  throw new Error('not implemented');
}

/** Aggregate counts (total / byRisk / byStatus) over the whole audit log. Read-only. */
export async function getAuditSummary(): Promise<AuditSummary> {
  throw new Error('not implemented');
}

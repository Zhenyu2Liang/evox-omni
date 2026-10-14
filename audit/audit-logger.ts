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
 * Error strategy: audit writes are BEST-EFFORT by default and NEVER throw into the request path.
 * A persistence failure is logged and swallowed so the banking flow continues unaffected;
 * `recordAudit` resolves with the input entry rather than rejecting.
 *
 * Callers that compose the write into a business `prisma.$transaction` can opt into STRICT mode
 * (`RecordAuditOptions.strict: true`): a real persistence failure then REJECTS (propagating the
 * original error) so the caller's transaction rolls back its business writes. The ONLY failure
 * strict mode absorbs is a VERIFIED duplicate of the SAME `dedupeKey` — a Prisma unique-constraint
 * violation (P2002) AND a row with that exact key already present on the same client — treated as
 * an idempotent no-op.
 */
import type { AuditEntry, AuditStatus } from '@/lib/contracts/audit';
import type { RiskLevel } from '@/lib/contracts/risk';
import { insertAuditLog, findAuditLogs, aggregateAuditLogs } from '@/lib/db/repositories/auditLog';
import { prisma } from '@/lib/db/client';
import type { Prisma } from '@/lib/db/prisma';
import { AppError } from '@/lib/errors';
import { requestDigest } from '@/lib/ledger';

/**
 * Filter for {@link listAudit}. Every field is optional; results are returned newest-first.
 * Structural shape mirrors the repository filter so it can be passed straight through.
 */
export interface AuditFilter {
  userId?: string;
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

/** Optional composition + idempotency controls forwarded to the repository insert. */
export interface RecordAuditOptions {
  /** Transaction client — write the audit inside the caller's `prisma.$transaction`. */
  client?: Prisma.TransactionClient;
  /** Idempotency key: a repeat write of the SAME execution's audit is absorbed (no duplicate row). */
  dedupeKey?: string;
  /**
   * STRICT write mode. When `true`, a REAL persistence failure REJECTS (the original error is
   * propagated unchanged) so the caller's enclosing `prisma.$transaction` rolls back its business
   * writes. The only failure absorbed is a VERIFIED duplicate of the SAME `dedupeKey` (a P2002
   * unique violation AND a row with that exact key already present on the same client), returned
   * as an idempotent no-op. When falsy/undefined, the best-effort default applies (catch, log,
   * resolve with the input entry).
   */
  strict?: boolean;
}

/**
 * Structural Prisma unique-constraint (P2002) detector, INLINED here on purpose: the dependency
 * direction `lib` ← `audit` forbids importing a helper from `banking-sdk`. Matches the error's
 * `code` property without depending on the concrete Prisma error class.
 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

/**
 * Persist one audit entry (append-only).
 *
 * `toolResult` and `detail` are JSON-serialized by the repository. The entry MUST carry the
 * objective-required fields (timestamp, sessionId, userRequest, intent, toolName, riskLevel,
 * confirmationRequired, confirmed, mfaRequired, mfaResult, toolResult, status).
 *
 * By default NEVER rejects: on persistence failure it logs the error and resolves with the input
 * entry. With `opts.strict === true` it REJECTS on a real persistence failure (propagating the
 * original error) so the caller's transaction can roll back, absorbing only a verified duplicate
 * of the same `dedupeKey` as an idempotent no-op.
 */
export async function recordAudit(
  entry: AuditEntry,
  opts?: RecordAuditOptions,
): Promise<AuditEntry> {
  try {
    return await auditStore.insertAuditLog(entry, opts);
  } catch (e) {
    if (opts?.strict) {
      // Strict mode: a real persistence failure must propagate so the caller's transaction rolls
      // back. The only exception is a verified duplicate of the SAME dedupeKey.
      const dedupeKey = opts.dedupeKey;
      if (dedupeKey !== undefined && isUniqueViolation(e)) {
        try {
          const client = opts.client ?? prisma;
          const existing = await client.auditLog.findUnique({ where: { dedupeKey } });
          if (existing && existing.userId === (entry.userId ?? null) && existing.sessionId === entry.sessionId && existing.toolName === entry.toolName &&
              existing.status === entry.status && existing.riskLevel === entry.riskLevel &&
              existing.confirmed === entry.confirmed && existing.mfaRequired === entry.mfaRequired) {
            const previous = existing.toolResult === null ? undefined : JSON.parse(existing.toolResult);
            const current = entry.toolResult as { ok?: boolean; data?: unknown } | undefined;
            // Narration/summary can change on recovery; the execution identity and business result cannot.
            const executionIdentity = (result: { ok?: boolean; data?: unknown } | undefined) => {
              const data = result?.data as { transactionId?: string; amount?: number; recipient?: { contactId?: string } } | undefined;
              // Legacy recovery cannot reconstruct a historical balance/phone. The verified ledger
              // transaction, amount and recorded counterparty still identify exactly the same fact.
              return typeof data?.transactionId === 'string'
                ? { ok: result?.ok, transactionId: data.transactionId, amount: data.amount, contactId: data.recipient?.contactId }
                : { ok: result?.ok, data: result?.data };
            };
            if (requestDigest(executionIdentity(previous)) === requestDigest(executionIdentity(current))) return entry;
          }
        } catch {
          // Back-read failed — fall through and rethrow the ORIGINAL insert error unchanged.
        }
      }
      throw e;
    }
    // Best-effort write: a failed audit append must never break the banking flow.
    console.error('[audit] failed to persist audit entry', e);
    return entry;
  }
}

/** Query audit entries, newest-first, by optional filter. Read-only. */
export async function listAudit(filter: AuditFilter): Promise<AuditEntry[]> {
  try {
    return await auditStore.findAuditLogs(filter);
  } catch (e) {
    throw AppError.from(e);
  }
}

/** Aggregate counts (total / byRisk / byStatus) over the whole audit log. Read-only. */
export async function getAuditSummary(filter: AuditFilter = {}): Promise<AuditSummary> {
  try {
    const summary = await auditStore.aggregateAuditLogs(filter);
    return {
      total: summary.total,
      byRisk: summary.byRisk,
      byStatus: summary.byStatus,
    };
  } catch (e) {
    throw AppError.from(e);
  }
}

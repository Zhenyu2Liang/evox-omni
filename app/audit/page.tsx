/**
 * Audit Log — `/audit` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read models — no HTTP hop):
 *   `audit.listAudit({ sessionId, limit })` → `AuditEntry[]`
 *   `audit.getAuditSummary()`               → `AuditSummary` (total / byRisk / byStatus)
 *   Session id: the `banking_session` cookie (`SESSION_COOKIE`).
 *
 * Composes (`../components` — referenced by name only; the component library owns the API):
 *   AuditTable with columns timestamp / userRequest / intent / toolName / riskLevel /
 *   confirmationRequired / confirmed / mfaRequired / mfaResult / toolResult / status,
 *   plus summary badges.
 */
import { cookies } from 'next/headers';
import { audit } from '@/audit';
import type { AuditSummary } from '@/audit';
import type { AuditEntry } from '@/lib/contracts/audit';
import { SESSION_COOKIE } from '@/lib/constants';

export default async function AuditPage() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value ?? '';

  // TODO: wire read model — the audit trail (newest-first) + aggregate summary badges.
  const entries: AuditEntry[] = await audit.listAudit({ sessionId });
  const summary: AuditSummary = await audit.getAuditSummary();

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">审计日志</h1>
        <p className="mt-1 text-sm text-banking-navy">
          最近 {entries.length} 条记录 · 总计 {summary.total} 条
        </p>
      </header>

      {/*
        TODO: wire read model into the component library (`@/components`, read-only sibling):
          <AuditSummaryBadges summary={summary} />   // total / byRisk / byStatus
          <AuditTable entries={entries} />           // timestamp / userRequest / intent / toolName /
                                                     // riskLevel / confirmationRequired / confirmed /
                                                     // mfaRequired / mfaResult / toolResult / status
      */}
      <section className="rounded-2xl bg-white p-6 text-sm text-banking-navy shadow-sm">
        审计明细表与汇总徽章将由 `@/components` 渲染。
      </section>
    </main>
  );
}

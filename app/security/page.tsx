/**
 * Security Center — `/security` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read models — no HTTP hop):
 *   `audit.getSecurityStatus(sessionId)`        → `SecurityStatus` (circuit-breaker lock + recent events)
 *   `audit.listSecurityEvents({ sessionId })`   → `SecurityEvent[]`
 *   Session id: the `banking_session` cookie (`SESSION_COOKIE`).
 *
 * Composes (`../components` — referenced by name only; the component library owns the API):
 *   the 🟢/🟡/🔴 permission legend (`RISK_LABEL`), recent verifications, circuit-breaker
 *   status, and the SecurityEvents table.
 */
import { cookies } from 'next/headers';
import { audit } from '@/audit';
import type { SecurityStatus } from '@/audit';
import type { SecurityEvent } from '@/lib/contracts/audit';
import type { RiskLevel } from '@/lib/contracts/risk';
import { RISK_LABEL, SESSION_COOKIE } from '@/lib/constants';

export default async function SecurityPage() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value ?? '';

  // TODO: wire read model — session security posture + recent security events.
  const status: SecurityStatus = await audit.getSecurityStatus(sessionId);
  const events: SecurityEvent[] = await audit.listSecurityEvents({ sessionId });

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">安全中心</h1>
        <p className="mt-1 text-sm text-banking-navy">
          熔断{status.locked ? '已触发' : '未触发'} · 共 {events.length} 个安全事件
        </p>
      </header>

      <section className="flex flex-wrap gap-3 text-sm">
        {(Object.keys(RISK_LABEL) as RiskLevel[]).map((tier) => (
          <span key={tier} className="rounded-xl bg-white px-3 py-1 shadow-sm">
            {RISK_LABEL[tier]}
          </span>
        ))}
      </section>

      {/*
        TODO: wire read model into the component library (`@/components`, read-only sibling):
          <CircuitBreakerStatus locked={status.locked} />
          <RecentVerifications events={status.recentEvents} />
          <SecurityEventsTable events={events} />
      */}
      <section className="rounded-2xl bg-white p-6 text-sm text-banking-navy shadow-sm">
        熔断状态、最近验证记录与安全事件表将由 `@/components` 渲染。
      </section>
    </main>
  );
}

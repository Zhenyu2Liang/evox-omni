/**
 * Security Center — `/security` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read models — no HTTP hop):
 *   `security.circuitBreaker.getState(sessionId)` → authoritative lock + failure count
 *   `audit.getSecurityStatus(sessionId, { isLocked })` → `SecurityStatus` (`{ locked, recentEvents }`)
 *   `audit.listSecurityEvents({ sessionId })`     → `SecurityEvent[]`
 *   Session id: the `banking_session` cookie (`SESSION_COOKIE`).
 *
 * Composes (`@/components/security` — read-only sibling; the component library owns the API):
 *   `PermissionLegend`      → 🟢/🟡/🔴 permission-tier legend (driven by `RISK_LABEL`)
 *   `CircuitBreakerStatus`  → session breaker lock state (tripped / failures vs max attempts)
 *   `SecurityEventList`     → the recent verifications feed + the session security-event table
 *   `ResetBreakerButton`    → (client) clears this session's breaker via `POST /api/security/reset`
 *
 * Display only: every tier, lock and event here is produced by `@/audit` / `@/security`; this
 * page never decides permission. All props passed to the components are JSON-serializable
 * (epoch-ms timestamps, plain objects).
 */
import { cookies } from 'next/headers';
import { audit } from '@/audit';
import type { SecurityStatus } from '@/audit';
import { security } from '@/security';
import type { SecurityEvent } from '@/lib/contracts/audit';
import { MFA_MAX_ATTEMPTS, SESSION_COOKIE } from '@/lib/constants';
import {
  CircuitBreakerStatus,
  PermissionLegend,
  SecurityEventList,
} from '@/components/security';
import { ResetBreakerButton } from './ResetBreakerButton';

export default async function SecurityPage() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value ?? '';

  // Authoritative in-process breaker state for this session (failure count + lock).
  const breaker = security.circuitBreaker.getState(sessionId);

  const status: SecurityStatus = await audit.getSecurityStatus(sessionId, {
    isLocked: (sid) => security.circuitBreaker.isLocked(sid),
  });
  const events: SecurityEvent[] = await audit.listSecurityEvents({ sessionId });

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">安全中心</h1>
        <p className="mt-1 text-sm text-banking-navy">
          熔断{breaker.locked ? '已触发' : '未触发'} · 共 {events.length} 个安全事件
        </p>
      </header>

      {/* Permission tiers — 🟢 auto / 🟡 confirm / 🔴 MFA (labels from `lib/constants.RISK_LABEL`). */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">权限分级</h2>
        <PermissionLegend />
      </section>

      {/* Circuit breaker — after repeated MFA failures, high-risk ops are locked for the session. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">熔断状态</h2>
        <CircuitBreakerStatus
          tripped={breaker.locked}
          failureCount={breaker.failures}
          maxAttempts={MFA_MAX_ATTEMPTS}
        />
        {breaker.locked ? (
          <p className="text-sm text-banking-navy">
            如已确认为误操作，可在此解除本会话的熔断限制。
          </p>
        ) : null}
        <ResetBreakerButton locked={breaker.locked} className="self-start" />
      </section>

      {/* Recent verifications — the latest MFA outcomes / blocked ops for this session. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">最近验证记录</h2>
        <SecurityEventList events={status.recentEvents} emptyText="暂无最近验证记录" />
      </section>

      {/* Security-event stream — injection attempts, MFA failures, breaker trips, blocked ops. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">安全事件</h2>
        <SecurityEventList events={events} emptyText="暂无安全事件" />
      </section>
    </main>
  );
}

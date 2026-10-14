/**
 * Security Center — `/security` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read models — no HTTP hop):
 *   `await security.circuitBreaker.getState(sessionId)` → authoritative lock + failure count
 *   `audit.getSecurityStatus(sessionId, { isLocked })` → `SecurityStatus` (`{ locked, recentEvents }`)
 *   `audit.listSecurityEvents({ sessionId })`     → `SecurityEvent[]`
 *   Session id: the configured demo user's fixed workspace from `requireIdentity`.
 *
 * Composes (`@/components/security` — read-only sibling; the component library owns the API):
 *   `PermissionLegend`      → 🟢/🟡/🔴 permission-tier legend (driven by `RISK_LABEL`)
 *   `CircuitBreakerStatus`  → account breaker lock state (tripped / failures vs max attempts)
 *   `SecurityEventList`     → the recent verifications feed + the session security-event table
 *   `ResetBreakerButton`    → developer-only audited demo maintenance, without credential entry.
 *
 * Display only: every tier, lock and event here is produced by `@/audit` / `@/security`; this
 * page never decides permission. All props passed to the components are JSON-serializable
 * (epoch-ms timestamps, plain objects).
 */
import { audit } from '@/audit';
import type { SecurityStatus } from '@/audit';
import { security } from '@/security';
import type { SecurityEvent } from '@/lib/contracts/audit';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { requireIdentity } from '@/app/api/_lib/session';
import {
  CircuitBreakerStatus,
  PermissionLegend,
  SecurityEventList,
} from '@/components/security';
import { ResetBreakerButton } from './ResetBreakerButton';
import { getServerI18n } from '@/lib/i18n/server';

// Reads live security data and language preference; render on demand instead of at build.
export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const { t } = await getServerI18n();
  const { sessionId } = await requireIdentity();

  // Authoritative breaker state for this ACCOUNT (DB-backed, per-user; async read).
  const breaker = await security.circuitBreaker.getState(sessionId);

  const status: SecurityStatus = await audit.getSecurityStatus(sessionId, {
    isLocked: (sid) => security.circuitBreaker.isLocked(sid),
  });
  const events: SecurityEvent[] = await audit.listSecurityEvents({ sessionId });

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-banking-deep">{t('pages.security.title')}</h1>
        <p className="mt-1 text-sm text-banking-navy">
          {t('pages.security.summary', { lock: t(breaker.locked ? 'pages.security.lockEnabled' : 'pages.security.lockInactive'), count: events.length })}
        </p>
      </header>

      {/* Permission tiers — 🟢 auto / 🟡 confirm / 🔴 MFA (labels from `lib/constants.RISK_LABEL`). */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">{t('pages.security.permissionTiers')}</h2>
        <PermissionLegend />
      </section>

      {/* Circuit breaker — after repeated MFA failures, high-risk ops are locked for the account. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">{t('pages.security.breakerStatus')}</h2>
        <CircuitBreakerStatus
          tripped={breaker.locked}
          failureCount={breaker.failures}
          maxAttempts={MFA_MAX_ATTEMPTS}
        />
        {breaker.locked ? (
          <p className="text-sm text-banking-navy">
            {t('pages.security.unlockDescription')}
          </p>
        ) : null}
        <ResetBreakerButton className="self-start" />
      </section>

      {/* Recent verifications — the latest MFA outcomes / blocked ops for this session. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">{t('pages.security.recentVerifications')}</h2>
        <SecurityEventList events={status.recentEvents} emptyText={t('pages.security.emptyVerifications')} />
      </section>

      {/* Security-event stream — injection attempts, MFA failures, breaker trips, blocked ops. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">{t('pages.security.events')}</h2>
        <SecurityEventList events={events} emptyText={t('pages.security.emptyEvents')} />
      </section>
    </main>
  );
}

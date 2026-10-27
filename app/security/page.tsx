/**
 * Security Center — `/security` (Server Component, RSC by default).
 *
 * Authority (read-only; this page decides nothing and writes nothing):
 *   `await security.circuitBreaker.getState(sessionId)` → `CircuitBreakerState`
 *        (`locked` / `failures` / `max` / `lockedAt`) — the ONE lock authority.
 *   `await audit.getSecurityStatus(sessionId, { isLocked })` → `{ locked, recentEvents }`.
 *   `await audit.listSecurityEvents({ sessionId })`          → `SecurityEvent[]`.
 *   `await listPendingActions({ sessionId, status: 'locked', limit })` → the terminal `locked` rows.
 *   Session id: the configured demo user's fixed workspace from `requireIdentity`.
 *
 * LOCK REASON — structured sources only:
 *   `breaker.locked` gates the block, the `CIRCUIT_BREAKER_TRIPPED` `SecurityEvent` (`kind`, whose
 *   `detail` carries `{ failures, max, result: 'session_locked' }`) supplies the recorded reason and
 *   its timestamp, and `breaker.lockedAt` is the fallback instant. No Chinese prose is ever
 *   pattern-matched to decide why the account is locked.
 *
 * Composes (`@/components/security` — read-only sibling; the component library owns the API):
 *   `PermissionLegend`     → 🟢/🟡/🔴 permission-tier legend (driven by `RISK_LABEL`)
 *   `CircuitBreakerStatus` → account breaker lock state (tripped / failures vs max attempts)
 *   `SecurityEventList`    → the recent verifications feed + the session security-event table
 * plus the local:
 *   `UnlockPanel`          → the runtime unlock entry (`POST /api/security/reset`), always visible
 *   `ResetBreakerButton`   → developer-only audited demo maintenance, without credential entry
 *
 * TEXT FUNNEL: `SecurityEventList` prints `event.message` verbatim, so events are cleaned HERE —
 * each row keeps its structured `kind` label and the audit `message` only when it is real prose; an
 * empty/diagnostic message is REPLACED by the `kind` label, so `__SECURITY_BLOCK__` payloads, raw
 * JSON and stack traces never reach the DOM. Audit prose is deliberately NOT run through
 * `safePublicText`: that replaces unrecognized business descriptions with a generic fallback and
 * would lose legitimate audit text.
 *
 * Every prop handed to a client component is JSON-serializable (epoch ms or pre-formatted strings).
 */
import { audit } from '@/audit';
import type { SecurityStatus } from '@/audit';
import { security } from '@/security';
import type { SecurityEvent, SecurityEventKind } from '@/lib/contracts/audit';
import type { PendingAction } from '@/lib/db/prisma';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { safeParse } from '@/lib/json';
import { isInternalDiagnostic } from '@/lib/public-text';
import { isMessageKey, type Translator } from '@/lib/i18n/shared';
import { localizeActionFieldLabel, localizeActionFieldValue, localizeActionTitle } from '@/lib/i18n/display';
import { listPendingActions } from '@/lib/db/repositories/pendingAction';
import { requireIdentity } from '@/app/api/_lib/session';
import {
  CircuitBreakerStatus,
  PermissionLegend,
  SecurityEventList,
} from '@/components/security';
import { ResetBreakerButton } from './ResetBreakerButton';
import { UnlockPanel } from './UnlockPanel';
import { getServerI18n } from '@/lib/i18n/server';

// Reads live security data and language preference; render on demand instead of at build.
export const dynamic = 'force-dynamic';

/** How many terminal `locked` actions the impact list shows. */
const LOCKED_ACTION_LIMIT = 20;

/** Localized label of a security-event kind; an unknown kind stays the literal fact it is. */
function kindLabel(kind: SecurityEventKind, t: Translator): string {
  const key = `security.events.kind.${kind}`;
  return isMessageKey(key) ? t(key) : kind;
}

/** Localized tool name (`chat.tool.*`) when the catalog has one, else the raw tool name. */
function toolNameLabel(toolName: string, t: Translator): string {
  const key = `chat.tool.${toolName}`;
  return isMessageKey(key) ? t(key) : toolName;
}

/**
 * Public projection of the security-event stream: the structured `kind` label plus the audit
 * `message` ONLY when it is real prose (not empty, not an internal diagnostic).
 */
function publicEvents(events: SecurityEvent[], t: Translator): SecurityEvent[] {
  return events.map(event => {
    const label = kindLabel(event.kind, t);
    const message = typeof event.message === 'string' ? event.message.trim() : '';
    return {
      ...event,
      message: message !== '' && !isInternalDiagnostic(message) ? event.message : label,
    };
  });
}

/** Newest `CIRCUIT_BREAKER_TRIPPED` timestamp — the structured lock reason's recorded instant. */
function tripTimestamp(events: SecurityEvent[]): number | undefined {
  return events.reduce<number | undefined>((latest, event) => {
    if (event.kind !== 'CIRCUIT_BREAKER_TRIPPED') return latest;
    return latest === undefined || event.timestamp > latest ? event.timestamp : latest;
  }, undefined);
}

/** A display-only projection of one terminal `locked` action row. */
interface LockedActionView {
  id: string;
  toolName: string;
  toolLabel: string;
  title: string;
  fields: Array<{ label: string; value: string }>;
  createdAt: number;
}

/** A summary field is a fact only when it is a non-empty string and not a diagnostic. */
function safeField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || isInternalDiagnostic(value)) return undefined;
  return value;
}

/**
 * Project a persisted `PendingAction` row for display. `summaryJson` is a serialized
 * `PendingActionSummary`; a missing/unparseable summary degrades to the localized tool name — it
 * never throws and never prints raw JSON.
 */
function toLockedAction(row: PendingAction, t: Translator): LockedActionView {
  const label = toolNameLabel(row.toolName, t);
  const summary = safeParse<PendingActionSummary | null>(row.summaryJson, null);
  const fields = Array.isArray(summary?.fields)
    ? summary.fields.flatMap(field => {
        const fieldLabel = safeField(field?.label);
        const fieldValue = safeField(field?.value);
        return fieldLabel !== undefined && fieldValue !== undefined
          ? [{ label: localizeActionFieldLabel(fieldLabel, t), value: localizeActionFieldValue({ label: fieldLabel, value: fieldValue }, t) }]
          : [];
      })
    : [];
  return {
    id: row.id,
    toolName: row.toolName,
    toolLabel: label,
    title: localizeActionTitle(safeField(summary?.title) ?? label, t),
    fields,
    createdAt: row.createdAt.getTime(),
  };
}

/** Server-side time rendering for the structured lock evidence and the locked-action list. */
function formatTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale);
}

export default async function SecurityPage() {
  const { locale, t } = await getServerI18n();
  const { sessionId } = await requireIdentity();

  // Authoritative breaker state for this ACCOUNT (DB-backed, per-user; async read).
  const breaker = await security.circuitBreaker.getState(sessionId);
  const maxAttempts = breaker.max > 0 ? breaker.max : MFA_MAX_ATTEMPTS;

  const status: SecurityStatus = await audit.getSecurityStatus(sessionId, {
    isLocked: (sid) => security.circuitBreaker.isLocked(sid),
  });
  const events: SecurityEvent[] = await audit.listSecurityEvents({ sessionId });

  // READ-ONLY listing of the terminal `locked` actions; this page never writes `status`.
  const lockedRows = await listPendingActions({
    sessionId,
    status: 'locked',
    limit: LOCKED_ACTION_LIMIT,
  });
  const lockedActions = lockedRows.map(row => toLockedAction(row, t));

  // Cleaned views for the component library, which renders `message` verbatim.
  const recentEvents = publicEvents(status.recentEvents, t);
  const securityEvents = publicEvents(events, t);
  // Structured trip evidence first, the breaker's own lock instant as the fallback.
  const lockedSince = tripTimestamp(events) ?? breaker.lockedAt;

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="bank-page-heading text-2xl font-semibold tracking-tight text-banking-deep">{t('pages.security.title')}</h1>
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
          maxAttempts={maxAttempts}
        />
        {breaker.locked ? (
          <div
            data-lock-reason="CIRCUIT_BREAKER_TRIPPED"
            className="flex flex-col gap-1 rounded-2xl border border-banking-danger/30 bg-white p-4 text-sm leading-5 text-banking-navy"
          >
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold text-banking-danger">
                {t('security.events.kind.CIRCUIT_BREAKER_TRIPPED')}
              </span>
              <span>{t('security.breaker.failureCount', { count: breaker.failures, max: maxAttempts })}</span>
              {lockedSince !== undefined ? (
                <time className="text-xs text-banking-navy" dateTime={new Date(lockedSince).toISOString()}>
                  {formatTime(lockedSince, locale)}
                </time>
              ) : null}
            </p>
            <p>{t('security.breaker.lockedDescription')}</p>
            <p>{t('pages.security.unlockDescription')}</p>
          </div>
        ) : null}
        <UnlockPanel
          locked={breaker.locked}
          failures={breaker.failures}
          maxAttempts={maxAttempts}
          lockedActionCount={lockedActions.length}
        />
        <ResetBreakerButton className="self-start" />
      </section>

      {/* Locked terminal actions — the impact of the lock, read-only, hidden when there are none. */}
      {lockedActions.length > 0 ? (
        <section className="flex flex-col gap-3" data-locked-actions={lockedActions.length}>
          <h2 className="text-lg font-medium text-banking-deep">{t('pages.security.lockedRecords')}</h2>
          <p className="text-sm leading-6 text-banking-navy">{t('pages.security.lockedRecordsDescription')}</p>
          <ol className="space-y-3">
            {lockedActions.map(action => (
              <li
                key={action.id}
                data-locked-action-id={action.id}
                data-locked-action-tool={action.toolName}
                className="rounded-2xl border border-banking-border bg-white p-4 shadow-xs sm:p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h3 className="font-semibold text-banking-deep">{action.title}</h3>
                  {action.title !== action.toolLabel ? (
                    <span className="text-xs text-banking-navy">{action.toolLabel}</span>
                  ) : null}
                </div>
                {action.fields.length > 0 ? (
                  <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                    {action.fields.map((field, index) => (
                      <div key={`${index}:${field.label}`}>
                        <dt className="text-banking-navy">{field.label}</dt>
                        <dd className="mt-1 text-banking-deep">{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <p className="mt-3 text-xs text-banking-navy">
                  <time dateTime={new Date(action.createdAt).toISOString()}>
                    {formatTime(action.createdAt, locale)}
                  </time>
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* Recent verifications — the latest MFA outcomes / blocked ops for this session. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">{t('pages.security.recentVerifications')}</h2>
        <SecurityEventList events={recentEvents} emptyText={t('pages.security.emptyVerifications')} />
      </section>

      {/* Security-event stream — injection attempts, MFA failures, breaker trips, blocked ops. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-banking-deep">{t('pages.security.events')}</h2>
        <SecurityEventList events={securityEvents} emptyText={t('pages.security.emptyEvents')} />
      </section>
    </main>
  );
}

/**
 * Security-event recorder — persists + queries `SecurityEvent` rows and reports the
 * per-session circuit-breaker lock state.
 *
 * This node is the single writer for security events (injection attempts, MFA failures,
 * circuit-breaker trips, blocked high-risk ops, limit breaches, flagged anomalies). It is a
 * thin wrapper over `@/lib/db/repositories/securityEvent` and MUST NOT import `security`
 * (the Security Gateway depends on `audit` for logging — a reverse import would create a cycle).
 *
 * Circuit-breaker lock state: the AUTHORITY is the security node's circuit breaker. This
 * module prefers an INJECTED breaker-lookup callback (`SecurityStatusOptions.isLocked`);
 * when none is supplied it falls back to deriving the state from the persisted event stream
 * (a `CIRCUIT_BREAKER_TRIPPED` with no later `SECURITY_RESET`). Wiring the breaker in as the
 * injected callback keeps the authoritative state free of a hard import cycle.
 *
 * Error strategy: event writes are BEST-EFFORT by default and NEVER throw into the request path —
 * a persistence failure is logged and swallowed, and `recordSecurityEvent` resolves with the
 * input event rather than rejecting.
 *
 * Callers that compose the write into a business `prisma.$transaction` (e.g. the security node's
 * "unlock + SECURITY_RESET audit land together" contract) may additionally supply a transaction
 * `client` — the row is then written on the caller's already-open transaction — and/or opt into
 * STRICT mode (`RecordSecurityEventOptions.strict: true`): a real persistence failure then REJECTS
 * (propagating the original error unchanged) so the caller's transaction rolls back its business
 * writes. These semantics MIRROR `./audit-logger.ts#recordAudit`'s `strict` option.
 */
import type { SecurityEvent, SecurityEventKind } from '@/lib/contracts/audit';
import { insertSecurityEvent, findSecurityEvents } from '@/lib/db/repositories/securityEvent';
import type { DbClient } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { demoNow } from '@/lib/clock';

/** Filter for {@link listSecurityEvents}. Every field is optional; results newest-first. */
export interface SecurityEventFilter {
  sessionId?: string;
  kind?: SecurityEventKind;
  /** Maximum rows returned (repository applies the cap). */
  limit?: number;
}

/** Result of {@link getSecurityStatus}. */
export interface SecurityStatus {
  /** True when high-risk operations are locked for the session (circuit breaker open). */
  locked: boolean;
  /** Most recent security events for the session, newest-first. */
  recentEvents: SecurityEvent[];
}

/** Injected circuit-breaker lookup; returns the authoritative lock state for a session. */
export type BreakerLookup = (sessionId: string) => boolean | Promise<boolean>;

export interface SecurityStatusOptions {
  /** Authoritative lock state from the security node's breaker; overrides the event-derived fallback. */
  isLocked?: BreakerLookup;
  /** Max recent events returned (defaults to the repository default). */
  recentLimit?: number;
  /** Overrides the recent-events window (defaults to `{ sessionId, limit: recentLimit }`). */
  filter?: SecurityEventFilter;
}

/** Optional composition + strict-write controls forwarded to the repository insert. */
export interface RecordSecurityEventOptions {
  /** Transaction client — write the event inside the caller's `prisma.$transaction`. */
  client?: DbClient;
  /**
   * STRICT write mode. When `true`, a REAL persistence failure REJECTS (the original error is
   * propagated unchanged) so the caller's enclosing `prisma.$transaction` rolls back its business
   * writes. When falsy/undefined the best-effort default applies (catch, log, resolve with the
   * input event). Mirrors `RecordAuditOptions.strict` in `./audit-logger.ts`.
   */
  strict?: boolean;
}

/**
 * Repository bindings this module delegates to (`@/lib/db/repositories/securityEvent`).
 * Exposed as a seam so tests can stub persistence without a live Prisma client.
 */
export const securityEventStore = {
  insertSecurityEvent: insertSecurityEvent as (
    event: SecurityEvent,
    opts?: RecordSecurityEventOptions,
  ) => Promise<SecurityEvent>,
  findSecurityEvents,
};

/** Scan window for deriving lock state from the event stream (independent of `recentLimit`). */
const LOCK_SCAN_LIMIT = 100;

/**
 * Persist a security event. `timestamp` defaults to `demoNow()` (the demo clock) when omitted (a
 * caller may supply its own, e.g. a real-clock value); `id` is assigned by the repository.
 *
 * By default NEVER rejects: on persistence failure it logs the error and resolves with the input
 * event. With `opts.strict === true` it REJECTS on a real persistence failure (propagating the
 * original error unchanged) so the caller's enclosing `prisma.$transaction` rolls back its business
 * writes. `opts.client` writes the row on the caller's already-open transaction client.
 */
export async function recordSecurityEvent(
  event: Omit<SecurityEvent, 'id' | 'timestamp'> & { timestamp?: number },
  opts?: RecordSecurityEventOptions,
): Promise<SecurityEvent> {
  const full: SecurityEvent = { ...event, timestamp: event.timestamp ?? demoNow() };
  try {
    return await securityEventStore.insertSecurityEvent(full, opts);
  } catch (e) {
    if (opts?.strict) {
      // Strict mode: a real persistence failure must propagate so the caller's transaction rolls
      // back its business writes.
      throw e;
    }
    // Best-effort write: a failed security-event append must never break the flow.
    console.error('[audit] failed to persist security event', e);
    return full;
  }
}

/** Query security events, newest-first. Read-only. */
export async function listSecurityEvents(filter?: SecurityEventFilter): Promise<SecurityEvent[]> {
  try {
    return await securityEventStore.findSecurityEvents(filter ?? {});
  } catch (e) {
    throw AppError.from(e);
  }
}

/**
 * Report the session's security posture: circuit-breaker lock state + recent events.
 *
 * Lock state comes from the injected `isLocked` breaker callback when provided; otherwise it
 * is derived from the persisted event stream. See the module header for the dependency note.
 */
export async function getSecurityStatus(
  sessionId: string,
  options?: SecurityStatusOptions,
): Promise<SecurityStatus> {
  try {
    const recentEvents = await securityEventStore.findSecurityEvents(
      options?.filter ?? { sessionId, limit: options?.recentLimit },
    );

    let locked: boolean;
    if (options?.isLocked) {
      locked = await options.isLocked(sessionId);
    } else {
      const stream = await securityEventStore.findSecurityEvents({
        sessionId,
        limit: LOCK_SCAN_LIMIT,
      });
      locked = deriveLocked(stream);
    }

    return { locked, recentEvents };
  } catch (e) {
    throw AppError.from(e);
  }
}

/**
 * Derive lock state from the persisted event stream: `locked` iff the NEWEST
 * `CIRCUIT_BREAKER_TRIPPED` / `SECURITY_RESET` event is a trip. Events arrive newest-first.
 * Breaker counters stay in `security`; this is only the event-derived fallback.
 */
function deriveLocked(events: SecurityEvent[]): boolean {
  for (const event of events) {
    if (event.kind === 'CIRCUIT_BREAKER_TRIPPED') return true;
    if (event.kind === 'SECURITY_RESET') return false;
  }
  return false;
}

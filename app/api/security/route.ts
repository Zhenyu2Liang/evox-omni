/**
 * GET /api/security — security-center read model.
 *
 * Contract:
 *  - Session: the configured demo user's fixed workspace via `resolveIdentity`.
 *    Cookies and query identifiers cannot select another workspace. No login is required.
 *  - Delegates to `@/audit`: `getSecurityStatus(sessionId, { isLocked })` +
 *    `listSecurityEvents({ sessionId })`; the authoritative lock state is supplied by the
 *    security node's circuit breaker (`@/security` → `circuitBreaker.isLocked`).
 *  - PUBLIC PROJECTION: a persisted `SecurityEvent` is an INTERNAL audit record, so BOTH event
 *    surfaces — `events` and `status.recentEvents`, which carries the same rows — are mapped through
 *    `_lib/public-security-event.ts#publicSecurityEvent` before serialization. Structured facts
 *    (`id`/`timestamp`/`sessionId`/`userId`/`kind`/`severity`) pass through verbatim, legitimate
 *    audit prose survives byte-for-byte, a blank/internal-diagnostic `message` becomes `''` and a
 *    `detail` that is not JSON-safe or carries an internal diagnostic at any string leaf is dropped
 *    entirely. The gateway's `__SECURITY_BLOCK__…` marker therefore never leaves this edge —
 *    `tests/app/security-http-redaction.test.ts` pins the contract.
 *  - The breaker is DB-backed and PER-ACCOUNT, so its reads are async: `circuitBreaker.getState`
 *    and `circuitBreaker.isLocked` both return a `Promise` and MUST be awaited.
 *  - Success: `200 { ok: true, data: { status; events; circuitBreaker; lock?; lockedActions } }`,
 *    where `circuitBreaker` surfaces the raw failure counter (`await circuitBreaker.getState`):
 *      • `lock` is the STRUCTURED reason the account is frozen and is present ONLY while the breaker
 *        is locked — `{ code: 'CIRCUIT_OPEN', reason: 'circuit_open' }` (the typed `SecurityFailure`
 *        contract). It deliberately carries no attempt counters: the breaker counter is
 *        account-scoped and the per-action attempts belong to that action's own row. A caller
 *        renders the refusal from these TYPED fields (`lib/public-text.ts#securityNotice`), never
 *        from message text.
 *      • `lockedActions` lists the caller session's `PendingAction` rows whose status is exactly
 *        `'locked'` — the TERMINAL MFA outcome written by the security gateway after the attempt
 *        limit is exhausted. `locked` is terminal: such a row is NOT a pending decision, gets no
 *        verification entry point and is never written back to `pending`/`awaiting_mfa`, so it is
 *        surfaced here as a factual record (newest lock first) rather than as an actionable item.
 *        The unlock (`POST /api/security/reset`) does NOT reopen these rows.
 *    Any failure maps through the shared error envelope.
 *
 * Thin by design: `validate (zod) → delegate → serialize`. No business logic, no Prisma here, and
 * this endpoint is STRICTLY READ-ONLY: it writes no `PendingAction` status, executes nothing and
 * acquires no lease.
 */
import type { NextRequest } from 'next/server';
import { audit } from '@/audit';
import { security } from '@/security';
import { isManualCardCommand } from '@/lib/contracts/card-management';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { SecurityFailure } from '@/lib/contracts/security';
import { listPendingActions } from '@/lib/db/repositories/pendingAction';
import { jsonResponse, errorResponse } from '../_lib/http';
import { resolveIdentity } from '../_lib/session';
import {
  publicSecurityEvent,
  type PublicSecurityEvent,
  type PublicSecurityStatus,
} from '../_lib/public-security-event';

/** One TERMINAL, locked operation of the caller session (read-only fact, never actionable here). */
export interface LockedActionSummary {
  actionId: string;
  toolName: string;
  tier: RiskLevel;
  requiresMfa: boolean;
  /** When the row was last written — for a `locked` row this is (approximately) the lock instant. */
  updatedAt: number;
}

/** Success payload shape for `GET /api/security`. */
export interface SecurityData {
  /** `locked` is forwarded verbatim; `recentEvents` carries the PUBLIC projection of each row. */
  status: PublicSecurityStatus;
  /** The PUBLIC projection of every persisted event, newest first — no event is filtered out. */
  events: PublicSecurityEvent[];
  /** Raw circuit-breaker counters for the account (failure count vs trip threshold). */
  circuitBreaker: { failures: number; max: number; locked: boolean };
  /**
   * Structured lock reason — present ONLY while the breaker is locked, absent otherwise. Typed, so
   * clients never have to parse a message or a raw status token.
   */
  lock?: SecurityFailure;
  /**
   * The caller session's TERMINAL `'locked'` operations, newest lock first. Always present (an empty
   * array means none). Nothing here is a pending decision: no confirm/MFA entry point exists for a
   * locked row, and unlocking the breaker never reopens one.
   */
  lockedActions: LockedActionSummary[];
}

/**
 * The one structured lock reason this read model can honestly report: the account's breaker is open.
 * No attempt counters are invented — the breaker is account-scoped, so the per-action attempt count
 * belongs to that action's own MFA challenge, not to this account-level refusal.
 */
const LOCKED_FAILURE: SecurityFailure = { code: 'CIRCUIT_OPEN', reason: 'circuit_open' };

/**
 * The caller session's TERMINAL locked operations, newest first.
 *
 * Read through the sanctioned repository path with the `'locked'` status filter, so the page size is
 * spent on locked rows only (a session with many other rows cannot hide them). Manual-card commands
 * are skipped because they are owned by their own `CardChange` records, not surfaced as
 * `PendingAction` decisions — the same exclusion `GET /api/actions` applies.
 */
async function readLockedActions(sessionId: string): Promise<LockedActionSummary[]> {
  const rows = await listPendingActions({ sessionId, status: 'locked' });
  const locked: LockedActionSummary[] = [];
  for (const row of rows) {
    // The query already narrows to `locked`; the check keeps this mapping honest read-only.
    if (row.status !== 'locked') continue;
    if (isManualCardCommand(row.toolName)) continue;
    locked.push({
      actionId: row.id,
      toolName: row.toolName,
      tier: row.riskLevel as RiskLevel,
      requiresMfa: row.requiresMfa,
      updatedAt: row.updatedAt.getTime(),
    });
  }
  // Newest LOCK first: the repository pages by creation, so order by the last write (the lock).
  return locked.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const { sessionId } = await resolveIdentity(req);

    const status = await audit.getSecurityStatus(sessionId, {
      isLocked: (sid) => security.circuitBreaker.isLocked(sid),
    });
    const events = await audit.listSecurityEvents({ sessionId });
    const breaker = await security.circuitBreaker.getState(sessionId);
    const lockedActions = await readLockedActions(sessionId);

    const data: SecurityData = {
      // `locked` stays verbatim; the SAME rows must not leak through `recentEvents` either.
      status: { ...status, recentEvents: status.recentEvents.map(publicSecurityEvent) },
      events: events.map(publicSecurityEvent),
      circuitBreaker: {
        failures: breaker.failures,
        max: breaker.max,
        locked: breaker.locked,
      },
      // Structured lock reason ONLY while locked: the key is absent, not null, when unlocked.
      ...(breaker.locked ? { lock: LOCKED_FAILURE } : {}),
      lockedActions,
    };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}

// (no value re-export: route modules may only export route handlers + type-only exports)
export type { SecurityFailure };

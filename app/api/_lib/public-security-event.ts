/**
 * app/api/_lib/public-security-event.ts — the PUBLIC projection of a persisted `SecurityEvent`.
 *
 * WHY: `GET /api/security` is a browser-facing read model, but a `SecurityEvent` row is an INTERNAL
 * audit record. Its `message` and `detail` are written by the security gateway and by the tool
 * pipeline, so they can legitimately carry implementation detail that must never leave the edge: the
 * gateway's `__SECURITY_BLOCK__{"decisionKind":"deny"}` refusal wrapper, a serialized JSON fragment,
 * a raw stack trace or the literal `undefined`. `security/security-gateway.ts` and
 * `agent/turns/events.ts` store that marker in the persisted event VERBATIM, so serializing the row
 * as-is would publish it to every browser (`GET /api/security` `events` AND `status.recentEvents`).
 *
 * WHAT THE PROJECTION KEEPS (structured facts, verbatim — they are what a client renders):
 *  - `id`, `timestamp`, `sessionId`, `userId`, `kind`, `severity`.
 *  A client renders its label from `kind` (and its tone from `severity`), so the feed stays
 *  meaningful with no text at all.
 *
 * WHAT IT NEUTRALIZES:
 *  - `message` stays a REQUIRED string (the key is never dropped), but a blank/whitespace-only
 *    message and any internal diagnostic (`lib/public-text.ts#isInternalDiagnostic`) become `''`.
 *    Legitimate audit prose survives BYTE-FOR-BYTE: this is deliberately NOT `safePublicText`,
 *    which would replace real business descriptions with a generic catalog fallback.
 *  - `detail` is kept ONLY when it is a plain JSON value whose STRING LEAVES (at any depth) are all
 *    free of internal diagnostics; otherwise the key is OMITTED ENTIRELY (not nulled, not
 *    stringified). The recursion is the point: the breaker trip's safe evidence
 *    `{ failures, max, result: 'session_locked' }` must survive while `{ note: '__SECURITY_BLOCK__…' }`
 *    must not.
 *
 * WHAT THIS MUST NEVER DO:
 *  - drop or filter an event: a persisted event is a FACT, it stays reported with its kind/severity;
 *  - write, execute, recover or decide anything — no I/O, no audit/permission/breaker logic, no
 *    import of any route module (this layer only projects rows it is handed);
 *  - fabricate text: a neutralized message is the EMPTY STRING, never an invented sentence — the
 *    client falls back to its own localized `kind` label (`components/security/SecurityEventList`).
 *
 * `_lib` is a Next.js private folder (leading underscore) — it never becomes a route.
 */
import type { SecurityEvent } from '@/lib/contracts/audit';
import { isInternalDiagnostic } from '@/lib/public-text';

/**
 * Depth cap for the `detail` walk. A persisted `detail` is a shallow JSON record parsed back from a
 * TEXT column, so anything deeper is not a fact this read model can vouch for — and the cap also
 * bounds a cyclic structure instead of recursing forever.
 */
const MAX_DETAIL_DEPTH = 6;

/** The PUBLIC shape of one persisted security event: the structured facts plus safe text. */
export interface PublicSecurityEvent {
  id?: string;
  timestamp: number;
  sessionId: string;
  userId?: string;
  kind: SecurityEvent['kind'];
  severity: SecurityEvent['severity'];
  /** Audit prose VERBATIM, or `''` when it is blank / an internal diagnostic. Never dropped. */
  message: string;
  /** Present only when JSON-safe and diagnostic-free at every string leaf; absent otherwise. */
  detail?: unknown;
}

/** The PUBLIC shape of the security-center status block (`locked` is forwarded verbatim). */
export interface PublicSecurityStatus {
  locked: boolean;
  recentEvents: PublicSecurityEvent[];
}

/**
 * Is this `detail` safe to publish? True only for a plain JSON value (object/array/string/number/
 * boolean/null — no functions, symbols, bigints, `undefined`, class instances, cycles or `NaN`)
 * whose every STRING leaf satisfies `isInternalDiagnostic(leaf) === false`.
 */
export function isPublicDetailValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_DETAIL_DEPTH) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
      return !isInternalDiagnostic(value);
    case 'number':
      // `NaN`/`Infinity` serialize to `null`, so they are not JSON-safe facts.
      return Number.isFinite(value);
    case 'boolean':
      return true;
    case 'object':
      break;
    default:
      // `undefined`, `bigint`, `function`, `symbol` — not representable in JSON.
      return false;
  }
  if (Array.isArray(value)) return value.every(item => isPublicDetailValue(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false; // Date/Map/class instance
  return Object.values(value as Record<string, unknown>).every(item =>
    isPublicDetailValue(item, depth + 1),
  );
}

/**
 * The published form of an audit message: the prose VERBATIM, or `''` when it is blank/whitespace
 * only or an internal diagnostic. Never a substitute sentence — the client owns the fallback.
 */
function publicSecurityMessage(message: string): string {
  const text = typeof message === 'string' ? message : '';
  if (text.trim() === '' || isInternalDiagnostic(text)) return '';
  return text;
}

/**
 * Pure projection of ONE persisted `SecurityEvent` onto its public shape.
 *
 * Structured facts are forwarded verbatim, a diagnostic/blank `message` becomes `''`, and a
 * `detail` that is not JSON-safe or carries an internal diagnostic at any string leaf loses the key
 * entirely (so `'detail' in projected === false`). Absent optional fields stay absent rather than
 * being re-emitted as `undefined`.
 */
export function publicSecurityEvent(event: SecurityEvent): PublicSecurityEvent {
  const projected: PublicSecurityEvent = {
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    kind: event.kind,
    severity: event.severity,
    message: publicSecurityMessage(event.message),
  };
  if (event.id !== undefined) projected.id = event.id;
  if (event.userId !== undefined) projected.userId = event.userId;
  if (event.detail !== undefined && isPublicDetailValue(event.detail)) {
    projected.detail = event.detail;
  }
  return projected;
}

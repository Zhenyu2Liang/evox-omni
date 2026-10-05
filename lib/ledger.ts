/**
 * Ledger — the canonical deterministic transfer-ledger transaction id.
 *
 * Pure module: no side effects at load, no other `lib` imports.
 */
import { createHash } from 'node:crypto';

/**
 * Canonical deterministic transfer-ledger transaction id.
 *
 * This is the SINGLE source of truth that LINKS a gated transfer `PendingAction` to the ledger
 * `Transaction` row it produces.
 *
 * The Banking SDK derives the ledger row's primary key from it, so supplying an idempotency key
 * makes a repeat transfer at-most-once: a repeat replays the original row (same transaction id)
 * instead of double-debiting. `security/` uses it to EXCLUDE already-ledgered in-flight actions
 * from the cumulative daily-transfer total.
 *
 * FORMAT (frozen): `txidem_` + first 32 hex chars of `sha256("<userId>\u0000<idempotencyKey>")`
 * (a REAL NUL byte separates the two parts).
 */
export function idempotentTransferTxId(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${userId}\u0000${idempotencyKey}`).digest('hex');
  return `txidem_${digest.slice(0, 32)}`;
}

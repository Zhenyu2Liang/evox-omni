/**
 * Ledger — canonical deterministic idempotency keys for money/gated side effects.
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

/**
 * Stable, deterministic idempotency key for a plan node's SIDE EFFECT.
 *
 * A `(taskId, nodeId)` pair identifies one node of one plan execution. The same pair MUST always
 * map to the same key, so two runs of the SAME (task, node) dedupe — a repeat replays the node's
 * original side effect instead of applying it twice.
 *
 * It is deliberately plan-scoped: two DIFFERENT plans (different `taskId`) that happen to invoke
 * the identical tool with identical args produce DIFFERENT keys, so their side effects must NOT
 * collide.
 *
 * FORMAT (frozen): `nxe:<taskId>:<nodeId>`. `taskId`/`nodeId` are ids/cuids that never contain the
 * `:` separator, so the key is unambiguous — a different `taskId` yields a different key, and a
 * different `nodeId` yields a different key.
 */
export function nodeExecutionKey(taskId: string, nodeId: string): string {
  return `nxe:${taskId}:${nodeId}`;
}

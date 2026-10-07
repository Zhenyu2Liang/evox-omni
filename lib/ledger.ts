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

/**
 * Canonical de-dup IDENTITY of a gated `PendingAction`.
 *
 * The identity of an action is its PLAN membership when it belongs to a plan, else its OWN `id`:
 *  - an action that is part of a plan (`taskId` AND `nodeId` both non-null and non-empty after
 *    trimming) is identified by its plan node → `nodeExecutionKey(taskId, nodeId)`, so a re-run of
 *    the same (task, node) dedupes to the SAME identity and the ledger row the node produced can be
 *    looked up again;
 *  - a STANDALONE action (no plan link) is identified by its own `id` — the conventional
 *    per-`PendingAction` idempotency key.
 *
 * This is the SINGLE key that LINKS an action to the ledger `Transaction` row it produced: a plan
 * node's row id is derived from `nodeExecutionKey(taskId, nodeId)`, while a standalone action's row
 * id is derived from its `id`. Callers MUST use this helper (never a bare `action.id`) so the key
 * they look up MATCHES the key the row was generated with; otherwise an already-ledgered action is
 * not recognized and is double-counted.
 */
export function ledgerKeyForAction(action: {
  id: string;
  taskId?: string | null;
  nodeId?: string | null;
}): string {
  const { taskId, nodeId } = action;
  if (taskId != null && taskId.trim().length > 0 && nodeId != null && nodeId.trim().length > 0) {
    return nodeExecutionKey(taskId, nodeId);
  }
  return action.id;
}

/**
 * Canonical deterministic transfer-ledger transaction id for a gated `PendingAction`.
 *
 * Thin composition of {@link idempotentTransferTxId} over {@link ledgerKeyForAction}: it yields the
 * SAME transaction id the Banking SDK derives for the row the action produces — the plan-node key
 * for a plan-linked action, the action `id` otherwise.
 *
 * Use this (NOT `idempotentTransferTxId(userId, action.id)`) to look up an action's ledger row, so
 * an already-ledgered action is recognized and excluded from the cumulative daily-transfer total.
 */
export function ledgerTxIdForAction(
  userId: string,
  action: { id: string; taskId?: string | null; nodeId?: string | null },
): string {
  return idempotentTransferTxId(userId, ledgerKeyForAction(action));
}

/**
 * Deterministic id of the unified EXECUTION RECEIPT for a gated side effect.
 *
 * An `ExecutionReceipt` is the durable, COMMITTED-FACT record of ONE side effect identified by its
 * execution identity (`userId` + `key`, the SAME key {@link ledgerKeyForAction} /
 * {@link idempotentTransferTxId} use). Because it is addressed deterministically, a replay can
 * recognize an already-committed side effect from PERSISTED data instead of re-resolving MUTABLE
 * inputs (e.g. a recipient looked up by name that has since been renamed).
 *
 * FORMAT (frozen): `rcpt_` + first 32 hex chars of `sha256("<userId>\u0000<key>")`
 * (a REAL NUL byte separates the two parts).
 */
export function executionReceiptId(userId: string, key: string): string {
  const digest = createHash('sha256').update(`${userId}\u0000${key}`).digest('hex');
  return `rcpt_${digest.slice(0, 32)}`;
}

/**
 * Canonical fingerprint of a gated tool REQUEST, used to decide whether a replay under the SAME
 * execution identity is the SAME request (→ replay the stored result) or a DIFFERENT one (→ reject
 * explicitly, never execute).
 *
 * Pure and deterministic: the parts are serialized as CANONICAL JSON — object keys sorted
 * recursively and `undefined` normalized to `null` — so key INSERTION ORDER never changes the
 * digest and re-serializing an identical request always yields an identical digest (while an absent
 * field and an explicit `null` hash the same).
 *
 * Returns the lowercase hex sha256 digest of that canonical JSON.
 */
export function requestDigest(parts: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex');
}

/** Recursively canonicalize a value: sort object keys, normalize `undefined` to `null`. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      out[key] = entry === undefined ? null : canonicalize(entry);
    }
    return out;
  }
  return value === undefined ? null : value;
}

/** Canonical JSON text of a value (stable regardless of key insertion order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Banking SDK — shared at-most-once (idempotent) CREATE helper.
 *
 * WHY this module exists: two gated CREATE side effects (`budget.reserveBudget` →
 * `Budget`, `task.createScheduledTask` → `ScheduledTask`) can be re-run when a plan node is
 * retried/replayed. Each table enforces a replay identity (Budget: userId + idempotencyKey;
 * ScheduledTask: idempotencyKey), so the SAME identity replays the persisted row. The
 * find-then-create + unique-violation-replay sequence is identical for both tables — it lives here
 * once.
 *
 * The write still goes through `./tx.ts` → `runInTransaction`, which remains the SDK's single
 * direct-Prisma boundary; this module never touches the Prisma client itself.
 */
import { createHash } from 'node:crypto';
import { AppError } from '@/lib/errors';

import { runInTransaction, type Tx } from './tx';

/** Structural Prisma unique-constraint (P2002) check — avoids importing the runtime error class. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/** The trimmed replay key, or `undefined` when the caller supplied none (empty/whitespace = absent). */
export function normalizeIdempotencyKey(key: string | undefined): string | undefined {
  if (key !== undefined && typeof key !== 'string') {
    throw new AppError('VALIDATION', 'Execution identity must be text.');
  }
  const trimmed = key?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Canonical deterministic virtual-card id for an idempotent `applyVirtualCard` call.
 *
 * The `Card` table has no `idempotencyKey` column, so — mirroring
 * `lib/ledger.idempotentTransferTxId` — a supplied key maps to a DETERMINISTIC primary key: a
 * repeat derives the SAME id, finds the already-issued card and replays it instead of issuing a
 * second virtual card.
 *
 * FORMAT (mirrors `lib/ledger.idempotentTransferTxId`): `cardidem_` + first 32 hex chars of
 * `sha256("<userId>\u0000<idempotencyKey>")` (a REAL NUL byte separates the two parts).
 */
export function idempotentCardId(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${userId}\u0000${idempotencyKey}`).digest('hex');
  return `cardidem_${digest.slice(0, 32)}`;
}

/** Find-then-create spec for {@link createIdempotent}, evaluated inside one transaction. */
export interface IdempotentCreateSpec<TRow> {
  /** Normalized (trimmed, non-empty) replay key — see {@link normalizeIdempotencyKey}. */
  key: string;
  /** Read the row previously created for `key`, or `null` when none exists yet. */
  find: (tx: Tx) => Promise<TRow | null>;
  /** Insert the row for `key`; the callback must persist `key` on the new row. */
  create: (tx: Tx, key: string) => Promise<TRow>;
}

/**
 * Create the row for `spec.key` at most once.
 *
 * Inside ONE interactive transaction: replay the persisted row when `key` was already used, else
 * insert it. A concurrent same-key caller loses the race on the `idempotencyKey` UNIQUE column
 * (`P2002`), its transaction rolls back (nothing written), and the winner's committed row is then
 * re-read through the SAME scoped `find` callback — so a fallback cannot broaden ownership.
 * Any other error propagates untouched.
 *
 * The trusted invocation context supplies the fence at the transaction boundary.
 */
export async function createIdempotent<TRow>(spec: IdempotentCreateSpec<TRow>): Promise<TRow> {
  try {
    return await runInTransaction(async (tx) => {
      const existing = await spec.find(tx);
      if (existing !== null) return existing;
      return spec.create(tx, spec.key);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Concurrent same-key race: the other call committed first and our transaction was rolled
    // back (nothing written). Re-read on a fresh transaction and replay the committed row.
    const committed = await runInTransaction((tx) => spec.find(tx));
    if (committed !== null) return committed;
    throw error;
  }
}

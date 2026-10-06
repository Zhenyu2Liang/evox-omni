/**
 * Banking SDK — shared at-most-once (idempotent) CREATE helper.
 *
 * WHY this module exists: two gated CREATE side effects (`budget.reserveBudget` →
 * `Budget`, `task.createScheduledTask` → `ScheduledTask`) can be re-run when a plan node is
 * retried/replayed. Both tables carry a `idempotencyKey String? @unique` column, so a repeat with
 * the SAME key must replay the already-persisted row instead of inserting a second one. The
 * find-then-create + unique-violation-replay sequence is identical for both tables — it lives here
 * once.
 *
 * The write still goes through `./tx.ts` → `runInTransaction`, which remains the SDK's single
 * direct-Prisma boundary; this module never touches the Prisma client itself.
 */
import { runInTransaction, type Tx } from './tx';

/** Structural Prisma unique-constraint (P2002) check — avoids importing the runtime error class. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/** The trimmed replay key, or `undefined` when the caller supplied none (empty/whitespace = absent). */
export function normalizeIdempotencyKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  return trimmed ? trimmed : undefined;
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
 * re-read and replayed — so exactly one row exists per key and both callers receive the same row.
 * Any other error propagates untouched.
 */
export async function createIdempotent<TRow>(spec: IdempotentCreateSpec<TRow>): Promise<TRow> {
  try {
    return await runInTransaction(async (tx) => {
      const existing = await spec.find(tx);
      return existing !== null ? existing : spec.create(tx, spec.key);
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

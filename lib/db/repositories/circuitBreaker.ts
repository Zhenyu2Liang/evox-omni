/**
 * lib/db/repositories/circuitBreaker.ts — DURABLE circuit-breaker state (Prisma).
 *
 * The security circuit breaker is keyed by OWNER (`security/circuit-breaker.ts` derives the key:
 * `user:<userId>` for a real session/user, else `session:<actor>`), NOT by session id, so a lock
 * survives a NEW SESSION and a PROCESS RESTART. This repository owns raw row access only; the
 * unlock POLICY (verification code / cooldown) lives in `security/`.
 *
 * `CircuitBreakerState` declares no relations, so its `truncateAll()` position in the test DB is free.
 */
import type { CircuitBreakerState } from '@prisma/client';
import { prisma, type DbClient } from '../client';

/** A breaker state snapshot (independent of the Prisma row shape). */
export interface BreakerSnapshot {
  failures: number;
  locked: boolean;
  lockedAt: Date | null;
}

/** The canonical "fresh / unlocked / no row" snapshot. */
const EMPTY_SNAPSHOT: BreakerSnapshot = { failures: 0, locked: false, lockedAt: null };

/** The state a CAS reset must observe to apply; compared by exact millisecond `lockedAt`. */
export interface ResetBreakerExpectation {
  locked: boolean;
  lockedAt: Date | null;
}

/** Result of {@link resetBreakerState}: whether the (conditional) clear applied, + before/after. */
export interface ResetBreakerResult {
  /** `true` when the clear was written; `false` when an `expect` CAS did not match (no write). */
  applied: boolean;
  /** The pre-clear snapshot (`null` when no row existed). */
  before: BreakerSnapshot | null;
  /** The post-clear snapshot — equals `before` when `applied` is `false` (`EMPTY_SNAPSHOT` if no row). */
  after: BreakerSnapshot;
}

/**
 * Read the persisted breaker row for an owner key, or `null` when none exists yet.
 *
 * `client` defaults to the global Prisma client. Callers that read the breaker from INSIDE an open
 * interactive transaction (the SDK write-boundary recheck) MUST pass that transaction's client —
 * otherwise the read blocks on the global pool until the transaction times out.
 */
export function getBreakerState(key: string, client?: DbClient): Promise<CircuitBreakerState | null> {
  return (client ?? prisma).circuitBreakerState.findUnique({ where: { key } });
}

export interface UpsertFailureInput {
  /** Owner key (`user:<id>` | `session:<actor>`). */
  key: string;
  /** Owning user id when known (persisted for per-user attribution). */
  userId?: string;
  /** Trip threshold (`MFA_MAX_ATTEMPTS`). */
  max: number;
  /** Instant to stamp as `lockedAt` when this failure trips the breaker. */
  now: Date;
}

/**
 * Record ONE consecutive failure: increment the counter and, on reaching `max`, lock the owner.
 * Idempotent while already locked (no recount, no re-trip) — the caller emits the trip event
 * exactly once, keyed off `didLock`.
 */
export async function upsertFailure(
  input: UpsertFailureInput,
): Promise<BreakerSnapshot & { didLock: boolean }> {
  return prisma.$transaction(async tx => {
    const current = await tx.circuitBreakerState.findUnique({ where: { key: input.key } });
    if (current?.locked) {
      return { failures: current.failures, locked: true, lockedAt: current.lockedAt, didLock: false };
    }
    const failures = (current?.failures ?? 0) + 1;
    const didLock = failures >= input.max;
    const lockedAt = didLock ? input.now : current?.lockedAt ?? null;
    const row = await tx.circuitBreakerState.upsert({
      where: { key: input.key },
      create: { key: input.key, userId: input.userId ?? null, failures, locked: didLock, lockedAt },
      update: {
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        failures,
        locked: didLock,
        lockedAt,
      },
    });
    return { failures: row.failures, locked: row.locked, lockedAt: row.lockedAt, didLock };
  });
}

/** Reset the consecutive-failure counter to 0 WITHOUT unlocking (a successful verification). */
export async function recordSuccessState(key: string): Promise<BreakerSnapshot> {
  const row = await prisma.circuitBreakerState.upsert({
    where: { key },
    create: { key, failures: 0, locked: false, lockedAt: null },
    update: { failures: 0 },
  });
  return { failures: row.failures, locked: row.locked, lockedAt: row.lockedAt };
}

/** Snapshot a raw row (or `null`) into the shape callers consume. */
function toSnapshot(row: CircuitBreakerState | null): BreakerSnapshot | null {
  return row ? { failures: row.failures, locked: row.locked, lockedAt: row.lockedAt } : null;
}

/**
 * Whether the current snapshot satisfies the CAS expectation: `locked` equal, and `lockedAt` equal
 * by MILLISECOND value (`null` compares as `null`). A missing row never matches.
 */
function matchesExpectation(
  current: BreakerSnapshot | null,
  expect: ResetBreakerExpectation,
): boolean {
  if (!current) return false;
  return (
    current.locked === expect.locked &&
    (current.lockedAt?.getTime() ?? null) === (expect.lockedAt?.getTime() ?? null)
  );
}

/**
 * Clear (unlock) an owner's breaker state to `{failures:0, locked:false, lockedAt:null}`. Returns the
 * PRE-clear snapshot so the caller can write a complete `SECURITY_RESET` audit record. Callers MUST
 * enforce the unlock gate before invoking this.
 *
 * - Without `opts.expect`: UNCONDITIONAL clear (previous behavior) — always writes, `applied: true`.
 * - With `opts.expect`: an atomic compare-and-set — the clear is written ONLY when the current row
 *   matches `expect` (see {@link matchesExpectation}); on a mismatch NOTHING is written and it
 *   returns `applied: false` with `before` (= `after`) equal to the current snapshot (or the
 *   `EMPTY_SNAPSHOT` when no row exists, so `after` stays a non-null snapshot).
 *
 * `opts.client` optionally routes BOTH the read and the write through an OPEN interactive
 * transaction's client (so an unlock can commit in the same `prisma.$transaction` as its audit
 * event). When omitted, this opens its own `prisma.$transaction`.
 */
export async function resetBreakerState(
  key: string,
  opts?: { client?: DbClient; expect?: ResetBreakerExpectation },
): Promise<ResetBreakerResult> {
  const run = async (db: DbClient): Promise<ResetBreakerResult> => {
    const current = await db.circuitBreakerState.findUnique({ where: { key } });
    const before = toSnapshot(current);
    if (opts?.expect && !matchesExpectation(before, opts.expect)) {
      return { applied: false, before, after: before ?? EMPTY_SNAPSHOT };
    }
    const row = await db.circuitBreakerState.upsert({
      where: { key },
      create: { key, failures: 0, locked: false, lockedAt: null },
      update: { failures: 0, locked: false, lockedAt: null },
    });
    return {
      applied: true,
      before,
      after: { failures: row.failures, locked: row.locked, lockedAt: row.lockedAt },
    };
  };

  return opts?.client ? run(opts.client) : prisma.$transaction(run);
}

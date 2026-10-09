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

/**
 * Clear (unlock) an owner's breaker state. Returns the PRE-clear snapshot so the caller can write a
 * complete `SECURITY_RESET` audit record. Callers MUST enforce the unlock gate before invoking this.
 */
export async function resetBreakerState(
  key: string,
): Promise<{ before: BreakerSnapshot | null; after: BreakerSnapshot }> {
  return prisma.$transaction(async tx => {
    const current = await tx.circuitBreakerState.findUnique({ where: { key } });
    const before = current
      ? { failures: current.failures, locked: current.locked, lockedAt: current.lockedAt }
      : null;
    const row = await tx.circuitBreakerState.upsert({
      where: { key },
      create: { key, failures: 0, locked: false, lockedAt: null },
      update: { failures: 0, locked: false, lockedAt: null },
    });
    return { before, after: { failures: row.failures, locked: row.locked, lockedAt: row.lockedAt } };
  });
}

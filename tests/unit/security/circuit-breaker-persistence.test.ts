/**
 * Unit: security/circuit-breaker — DURABLE, PER-USER persistence + the GATED unlock.
 *
 * Pins the NEW contract that replaced the in-process, sessionId-keyed map:
 *  1. every session/user actor of the SAME user resolves to ONE owner key (`user:<userId>`), so
 *     consecutive failures ACCUMULATE ACROSS SESSIONS and lock the user;
 *  2. a NEW session for that user is still locked (a fresh cookie cannot bypass a lock);
 *  3. a SIMULATED fresh process (no in-memory state) is still locked — the state is read back from
 *     the DB and from a freshly re-imported module;
 *  4. the unlock is REFUSED (`AppError('CIRCUIT_OPEN')`) without the mock code or an elapsed
 *     cooldown, and the lock survives;
 *  5. it SUCCEEDS with `verificationCode: MFA_CODE` — clearing the lock for EVERY session of the
 *     user and writing exactly ONE `SECURITY_RESET` SecurityEvent carrying the resolved `userId`;
 *  6. it SUCCEEDS via the elapsed cooldown (`now >= lockedAt + RESET_COOLDOWN_MS`) with no code;
 *  7. the LLM can NEVER unlock: NO file under `agent/tools/**` references the circuit breaker.
 *
 * Uses the isolated `prisma/test.db` (`useFreshDatabase()`). The cooldown boundary is derived from
 * the REAL-stamped persisted `lockedAt` (`realNow()`, never the pinned demo clock).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getState,
  isLocked,
  recordFailure,
  resetSession,
  resolveBreakerOwner,
} from '@/security/circuit-breaker';
import { getBreakerState } from '@/lib/db/repositories/circuitBreaker';
import { createSession } from '@/lib/db/repositories/session';
import { MFA_CODE, MFA_MAX_ATTEMPTS, RESET_COOLDOWN_MS } from '@/lib/constants';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

/** The owner key the demo user's sessions must ALL resolve to. */
const EXPECTED_KEY = `user:${DEMO_USER_ID}`;

/** Mint a PERSISTED session row for the demo user (its breaker owner is `user:<DEMO_USER_ID>`). */
async function newSessionForDemoUser(): Promise<string> {
  const row = await createSession({ userId: DEMO_USER_ID, stateJson: '{}' });
  return row.id;
}

/** Trip `actor`'s owner by recording `MFA_MAX_ATTEMPTS` consecutive failures. */
async function trip(actor: string): Promise<void> {
  for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) await recordFailure(actor);
}

/** The persisted security events of one kind for an actor. */
function eventsOf(actor: string, kind: string) {
  return getTestPrisma().securityEvent.findMany({ where: { sessionId: actor, kind } });
}

describe('circuit-breaker · PER-USER durable state', () => {
  it('1 — failures accumulate ACROSS different sessions of the SAME user and lock `user:<id>`', async () => {
    const first = await newSessionForDemoUser();
    const second = await newSessionForDemoUser();
    expect(second).not.toBe(first);

    // Both actors resolve to the SAME owner key (the user id), not to their session ids.
    expect(await resolveBreakerOwner(first)).toMatchObject({ key: EXPECTED_KEY, userId: DEMO_USER_ID });
    expect(await resolveBreakerOwner(second)).toMatchObject({ key: EXPECTED_KEY, userId: DEMO_USER_ID });
    expect(await resolveBreakerOwner(DEMO_USER_ID)).toMatchObject({ key: EXPECTED_KEY });

    // Two failures through the FIRST session, the third through the SECOND one: same counter.
    await recordFailure(first);
    await recordFailure(first);
    await recordFailure(second);

    const state = await getState(second);
    expect(state.failures).toBe(MFA_MAX_ATTEMPTS);
    expect(state.locked).toBe(true);
    // Exactly ONE trip event per trip, attributed to the resolved user.
    const trips = await getTestPrisma().securityEvent.findMany({
      where: { kind: 'CIRCUIT_BREAKER_TRIPPED' },
    });
    expect(trips).toHaveLength(1);
    expect(trips[0]!.userId).toBe(DEMO_USER_ID);
  });

  it('2 — a NEW session for that user is STILL locked and denied (fail-closed)', async () => {
    await trip(await newSessionForDemoUser());

    const fresh = await newSessionForDemoUser();

    expect(await isLocked(fresh)).toBe(true);
    expect((await getState(fresh)).locked).toBe(true);
    expect((await getState(fresh)).failures).toBe(MFA_MAX_ATTEMPTS);
    // The user id itself is the same owner — also locked.
    expect(await isLocked(DEMO_USER_ID)).toBe(true);
  });

  it('3 — a SIMULATED fresh process is STILL locked (state is read from the DB, not memory)', async () => {
    const tripped = await newSessionForDemoUser();
    await trip(tripped);

    // (a) the persisted ROW is the source of truth, keyed by the owner (a "cold" direct read).
    const row = await getBreakerState(EXPECTED_KEY);
    expect(row?.locked).toBe(true);
    expect(row?.lockedAt).toBeInstanceOf(Date);

    // (b) a NEWLY created session of the user, asserted through a freshly re-imported module (every
    //     in-memory module state is discarded by `vi.resetModules()`).
    const fresh = await newSessionForDemoUser();
    vi.resetModules();
    const reloaded = await import('@/security/circuit-breaker');
    expect(await reloaded.isLocked(fresh)).toBe(true);
    expect((await reloaded.getState(fresh)).locked).toBe(true);
  });
});

describe('circuit-breaker · GATED unlock', () => {
  it('4 — REFUSES without the code or the cooldown and leaves the lock intact', async () => {
    const session = await newSessionForDemoUser();
    await trip(session);
    const before = await getState(session);

    await expect(resetSession(session)).rejects.toMatchObject({
      name: 'AppError',
      code: 'CIRCUIT_OPEN',
    });
    await expect(resetSession(session, { verificationCode: '000000' })).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
    });
    await expect(
      // The lock is stamped on the REAL clock, so derive the not-yet-elapsed boundary from the
      // PERSISTED `lockedAt` (NOT `demoNow()` — the pinned demo instant is unrelated to the real lock).
      resetSession(session, { now: before.lockedAt! + RESET_COOLDOWN_MS - 1 }),
    ).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });

    // The lock (and the recorded trip) survives every refused attempt.
    const after = await getState(session);
    expect(after.locked).toBe(true);
    expect(after.failures).toBe(before.failures);
    expect(after.lockedAt).toBe(before.lockedAt);
    expect(await isLocked(session)).toBe(true);
    expect(await eventsOf(session, 'SECURITY_RESET')).toHaveLength(0);
  });

  it('5 — the mock verification code clears the lock and writes ONE SECURITY_RESET with the userId', async () => {
    const session = await newSessionForDemoUser();
    const other = await newSessionForDemoUser();
    await trip(session);

    const state = await resetSession(session, {
      actor: 'security-admin',
      reason: '用户致电客服核实身份后解除',
      verificationCode: MFA_CODE,
    });

    expect(state.locked).toBe(false);
    expect(state.failures).toBe(0);
    expect(state.lockedAt).toBeUndefined();
    // The unlock is PER USER: every session of that user is released.
    expect(await isLocked(session)).toBe(false);
    expect(await isLocked(other)).toBe(false);
    expect(await getBreakerState(EXPECTED_KEY)).toMatchObject({ failures: 0, locked: false, lockedAt: null });

    const resets = await getTestPrisma().securityEvent.findMany({ where: { kind: 'SECURITY_RESET' } });
    expect(resets).toHaveLength(1);
    expect(resets[0]!.sessionId).toBe(session);
    expect(resets[0]!.userId).toBe(DEMO_USER_ID);
    const detail = JSON.parse(resets[0]!.detail ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({
      actor: 'security-admin',
      reason: '用户致电客服核实身份后解除',
      wasLocked: true,
      previousFailures: MFA_MAX_ATTEMPTS,
    });
    expect(typeof detail.priorLockedAt).toBe('number');
  });

  it('6 — the elapsed cooldown unlocks with NO code at the injected clock', async () => {
    const session = await newSessionForDemoUser();
    await trip(session);
    const lockedAt = (await getState(session)).lockedAt!;

    // The lock is stamped on the REAL clock (`realNow()`), so the cooldown boundary is derived from
    // the PERSISTED `lockedAt` — never the pinned demo clock.
    const state = await resetSession(session, { now: lockedAt + RESET_COOLDOWN_MS });

    expect(state.locked).toBe(false);
    expect(state.failures).toBe(0);
    expect(await isLocked(session)).toBe(false);
    const resets = await getTestPrisma().securityEvent.findMany({ where: { kind: 'SECURITY_RESET' } });
    expect(resets).toHaveLength(1);
    expect(JSON.parse(resets[0]!.detail ?? '{}')).toMatchObject({ wasLocked: true });
  });

  it('7 — the model can NEVER unlock: no tool file references the circuit breaker', () => {
    const toolsDir = join(process.cwd(), 'agent', 'tools');
    const files = readdirSync(toolsDir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(toolsDir, name), 'utf8');
      if (/circuitBreaker|isLocked|resetSession|circuit-breaker/.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Unit: security/mfa — mock strong verification for RED operations (the code NEVER leaks).
 *
 * Targets `@/security/mfa`: issueChallenge(actionId), verify(actionId, code), getChallenge(actionId)
 * (+ types MfaChallengeView, MfaVerifyResult), backed by MFA_CODE = '123456'.
 *
 * Issue/verify/getChallenge read & write MfaChallenge rows and feed the circuit breaker +
 * MFA_FAILURE SecurityEvent → EVERY case below is backed by the isolated test SQLite
 * (`useFreshDatabase()` from ../../helpers/db) and uses a UNIQUE sessionId, so the in-process
 * circuit breaker can never leak a lock across cases.
 */
import { describe, it, expect, vi } from 'vitest';
import { issueChallenge, verify, getChallenge } from '@/security/mfa';
import { security } from '@/security';
import { MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { AppError } from '@/lib/errors';
import type { Result } from '@/lib/errors';
import { createPendingAction } from '@/lib/db/repositories/pendingAction';
import { newId } from '@/lib/ids';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

// Reset + seed the test DB before every case (MfaChallenge rows + SecurityEvents are persisted).
// The full demo seed is the dominant cost on a slow disk and can exceed Vitest's 10s default hook
// budget, so raise it (MUST be set before the hook is registered) — the assertions are unaffected.
vi.setConfig({ hookTimeout: 30_000 });
useFreshDatabase();

/** A unique sessionId per case — breaker state is in-process keyed by sessionId. */
function newSessionId(): string {
  return newId('sess_mfa');
}

/** The prerequisite: a RED `transfer_money` action parked awaiting MFA. */
function seedAction(sessionId: string) {
  return createPendingAction({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { amount: 5000, toName: '张伟' },
    tier: 'RED',
    requiresMfa: true,
    status: 'awaiting_mfa',
    summary: {
      title: '转账',
      toolName: 'transfer_money',
      tier: 'RED',
      fields: [],
      requiresMfa: true,
    },
  });
}

/** Unwrap a success `Result` (fails loudly when the facade unexpectedly returned an error). */
function unwrap<T>(res: Result<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value;
}

/** Unwrap an error `Result` (fails loudly when the facade unexpectedly succeeded). */
function unwrapErr<T>(res: Result<T>): AppError {
  if (res.ok) throw new Error('expected err, got ok');
  return res.error;
}

/** Assert the code is absent from every field of a returned (code-free) payload. */
function expectCodeFree(payload: object, label: string): void {
  expect(JSON.stringify(payload), `${label} must not serialize the code`).not.toContain(MFA_CODE);
  for (const [field, value] of Object.entries(payload)) {
    expect(String(value), `${label}.${field} must not carry the code`).not.toContain(MFA_CODE);
  }
}

describe('mfa · issueChallenge', () => {
  it('returns a MfaChallengeView with actionId, attempts 0, maxAttempts MFA_MAX_ATTEMPTS, verified false, createdAt set', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);

    const view = await issueChallenge(action.id);

    expect(view.actionId).toBe(action.id);
    expect(view.attempts).toBe(0);
    expect(view.maxAttempts).toBe(MFA_MAX_ATTEMPTS);
    expect(view.maxAttempts).toBe(3);
    expect(view.verified).toBe(false);
    expect(typeof view.createdAt).toBe('number');
    expect(Number.isFinite(view.createdAt)).toBe(true);
    expect(view.createdAt).toBeGreaterThan(0);
    expect(typeof view.hint).toBe('string');
    expect(view.hint.length).toBeGreaterThan(0);

    // The persisted (server-side) challenge agrees with the view.
    const row = await getTestPrisma().mfaChallenge.findUnique({
      where: { actionId: action.id },
    });
    expect(row).not.toBeNull();
    expect(row?.attempts).toBe(0);
    expect(row?.maxAttempts).toBe(MFA_MAX_ATTEMPTS);
    expect(row?.status).toBe('pending');
  });

  it('the view NEVER contains the code ("123456" absent from every field, including hint)', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);

    const view = await issueChallenge(action.id);

    expectCodeFree(view, 'MfaChallengeView');

    // The code IS persisted server-side — proof the assertions above are meaningful.
    const row = await getTestPrisma().mfaChallenge.findUnique({
      where: { actionId: action.id },
    });
    expect(row?.code).toBe(MFA_CODE);
  });

  it('re-issuing for the same action refreshes the challenge view', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    // A failed attempt advances the persisted counter + attemptsLeft...
    const failed = unwrap(await verify(action.id, '000000'));
    expect(failed.ok).toBe(false);
    expect(failed.attemptsLeft).toBe(MFA_MAX_ATTEMPTS - 1);
    expect((await getChallenge(action.id))?.attempts).toBe(1);

    // ...re-issuing resets it.
    const reissued = await issueChallenge(action.id);
    expect(reissued.actionId).toBe(action.id);
    expect(reissued.attempts).toBe(0);
    expect(reissued.maxAttempts).toBe(MFA_MAX_ATTEMPTS);
    expect(reissued.verified).toBe(false);

    const afterReset = await getTestPrisma().mfaChallenge.findUnique({
      where: { actionId: action.id },
    });
    expect(afterReset?.attempts).toBe(0);
    expect(afterReset?.status).toBe('pending');

    // Re-issuing also de-verifies an already-verified challenge.
    expect(unwrap(await verify(action.id, MFA_CODE)).ok).toBe(true);
    expect((await getChallenge(action.id))?.verified).toBe(true);

    const reissuedAfterSuccess = await issueChallenge(action.id);
    expect(reissuedAfterSuccess.verified).toBe(false);
    expect(reissuedAfterSuccess.attempts).toBe(0);
  });

  it('an unknown / non-existent action surfaces a thrown AppError', async () => {
    const missingId = newId('pa_missing');

    const thrown = await issueChallenge(missingId).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('NOT_FOUND');
    // No challenge was created for the unknown action.
    expect(await getChallenge(missingId)).toBeNull();
  });
});

describe('mfa · verify success', () => {
  it("correct code '123456' → ok({ ok: true, locked: false }) with attemptsLeft == MFA_MAX_ATTEMPTS", async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    const res = await verify(action.id, MFA_CODE);

    expect(res.ok).toBe(true);
    expect(unwrap(res)).toEqual({
      ok: true,
      attemptsLeft: MFA_MAX_ATTEMPTS,
      locked: false,
    });
  });

  it('after success, getChallenge reports verified true', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    expect(unwrap(await verify(action.id, MFA_CODE)).ok).toBe(true);

    const view = await getChallenge(action.id);
    expect(view).not.toBeNull();
    expect(view?.verified).toBe(true);

    const row = await getTestPrisma().mfaChallenge.findUnique({
      where: { actionId: action.id },
    });
    expect(row?.status).toBe('verified');
  });

  it('a successful verification records a breaker success (resets consecutive failures)', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    // A wrong code first, so the reset is observable.
    const failed = unwrap(await verify(action.id, '000000'));
    expect(failed.ok).toBe(false);
    expect((await security.circuitBreaker.getState(sessionId)).failures).toBe(1);

    const succeeded = unwrap(await verify(action.id, MFA_CODE));
    expect(succeeded.ok).toBe(true);

    const breaker = await security.circuitBreaker.getState(sessionId);
    expect(breaker.failures).toBe(0);
    expect(breaker.locked).toBe(false);
    expect(await security.circuitBreaker.isLocked(sessionId)).toBe(false);
  });
});

describe('mfa · verify failure + breaker', () => {
  it('a wrong code → ok({ ok: false, locked: false, attemptsLeft: MFA_MAX_ATTEMPTS - 1 })', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    const res = await verify(action.id, '000000');

    expect(res.ok).toBe(true);
    expect(unwrap(res)).toEqual({
      ok: false,
      locked: false,
      attemptsLeft: MFA_MAX_ATTEMPTS - 1,
    });
    expect(unwrap(res).attemptsLeft).toBe(2);
  });

  it('each wrong code decrements attemptsLeft and increments the challenge attempts', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    const attemptsLeft: number[] = [];
    for (let attempt = 1; attempt <= MFA_MAX_ATTEMPTS; attempt += 1) {
      const value = unwrap(await verify(action.id, '000000'));
      expect(value.ok).toBe(false);
      attemptsLeft.push(value.attemptsLeft);

      const view = await getChallenge(action.id);
      expect(view?.attempts).toBe(attempt);
    }

    expect(attemptsLeft).toEqual([2, 1, 0]);
  });

  it('the 3rd wrong code → locked true (breaker tripped) in the returned result', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    const results = [];
    for (let attempt = 0; attempt < MFA_MAX_ATTEMPTS; attempt += 1) {
      results.push(unwrap(await verify(action.id, '000000')));
    }

    expect(results[0].locked).toBe(false);
    expect(results[1].locked).toBe(false);
    expect(results[2].locked).toBe(true);

    // The breaker really tripped (not just flagged in the returned value).
    const breaker = await security.circuitBreaker.getState(sessionId);
    expect(breaker.locked).toBe(true);
    expect(breaker.failures).toBe(MFA_MAX_ATTEMPTS);

    // ...and the challenge row is retired as locked.
    const row = await getTestPrisma().mfaChallenge.findUnique({
      where: { actionId: action.id },
    });
    expect(row?.attempts).toBe(MFA_MAX_ATTEMPTS);
    expect(row?.status).toBe('locked');
  });

  it('a wrong code emits an MFA_FAILURE SecurityEvent (needs test SQLite)', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    await verify(action.id, '000000');
    const afterFirst = await getTestPrisma().securityEvent.findMany({
      where: { sessionId, kind: 'MFA_FAILURE' },
    });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].severity).toBe('medium');
    expect(afterFirst[0].sessionId).toBe(sessionId);

    await verify(action.id, '000000');
    await verify(action.id, '000000');

    const events = await getTestPrisma().securityEvent.findMany({
      where: { sessionId, kind: 'MFA_FAILURE' },
    });
    expect(events).toHaveLength(MFA_MAX_ATTEMPTS);
    for (const event of events) {
      expect(event.severity).toBe('medium');
      expect(event.sessionId).toBe(sessionId);
    }
  });
});

describe('mfa · unknown action', () => {
  it("verify for an unknown actionId → err(AppError 'NOT_FOUND' | 'CONFLICT')", async () => {
    const missingId = newId('pa_missing');

    const res = await verify(missingId, MFA_CODE);

    expect(res.ok).toBe(false);
    const error = unwrapErr(res);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('getChallenge for an unknown actionId → null', async () => {
    expect(await getChallenge(newId('pa_missing'))).toBeNull();
  });
});

describe('mfa · code non-disclosure', () => {
  it('no exported function ever returns the code: it is absent from MfaChallengeView and MfaVerifyResult', async () => {
    const sessionId = newSessionId();
    const action = await seedAction(sessionId);

    const issued = await issueChallenge(action.id);
    const failed = unwrap(await verify(action.id, '000000'));
    const succeeded = unwrap(await verify(action.id, MFA_CODE));
    const fetched = await getChallenge(action.id);
    if (!fetched) throw new Error('expected a challenge view after verification');
    const reissued = await issueChallenge(action.id);

    for (const view of [issued, fetched, reissued]) {
      expectCodeFree(view, `MfaChallengeView(${view.actionId})`);
    }
    for (const result of [failed, succeeded]) {
      expectCodeFree(result, 'MfaVerifyResult');
    }

    // The error path does not echo the code either.
    const error = unwrapErr(await verify(newId('pa_missing'), MFA_CODE));
    expect(error.message).not.toContain(MFA_CODE);
  });
});

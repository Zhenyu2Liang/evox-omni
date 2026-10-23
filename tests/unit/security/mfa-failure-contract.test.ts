/**
 * Unit: security — the STRUCTURED failure contract across the MFA attempt limit.
 *
 * Three consecutive wrong codes must be reported as TYPED data (never as text the caller has to
 * parse): attempt 1/2 stay `awaiting_mfa` with `reason: 'mfa_code_invalid'` and the remaining
 * attempts, attempt 3 reaches the terminal state (`status: 'locked'`,
 * `reason: 'mfa_attempts_exhausted'`, challenge + pending action permanently `locked`).
 *
 * A re-attempt on the locked action — even with the CORRECT code — must report the SAME terminal
 * state (`code: 'CIRCUIT_OPEN'`), issue NO new challenge, consume NO attempt and execute NOTHING.
 *
 * DB-backed (challenges, pending actions and audit rows are persisted) → `useFreshDatabase()`.
 */
import { describe, expect, it, vi } from 'vitest';

import { issueChallenge } from '@/security/mfa';
import { securityGateway } from '@/security/security-gateway';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { createPendingAction, getMfaChallenge } from '@/lib/db/repositories/pendingAction';
import { newId } from '@/lib/ids';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

// The per-test DB reset + seed (`useFreshDatabase`) is I/O heavy and can exceed the 10 s default
// hook timeout; give it more room (assertions/determinism untouched).
vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** The wrong code every attempt submits (the simulator's step-up code is a different 6 digits). */
const WRONG_CODE = '000000';
/** The correct simulator code for this challenge. */
const CORRECT_CODE = '123456';

/** A unique sessionId per test — breaker state is keyed by the resolved owner. */
const freshSessionId = (): string => newId('mfa_contract');

/** The prerequisite: a RED `transfer_money` action parked awaiting MFA, with an issued challenge. */
async function seedLockableAction(sessionId: string) {
  const action = await createPendingAction({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { amount: '5000.00', contactId: 'contact_zhangwei' },
    tier: 'RED',
    requiresMfa: true,
    status: 'awaiting_mfa',
    summary: { title: '转账', toolName: 'transfer_money', tier: 'RED', fields: [], requiresMfa: true },
  });
  await issueChallenge(action.id);
  return action;
}

/** Submit one verification code through the gateway's public authorization entry point. */
function submitCode(actionId: string, sessionId: string, mfaCode: string) {
  return securityGateway.authorizeAction(actionId, { userId: DEMO_USER_ID, sessionId, mfaCode });
}

/** Parse the persisted JSON `detail` text of a security-event row. */
function detailOf(row: { detail: string | null }): Record<string, unknown> {
  return JSON.parse(row.detail ?? '{}') as Record<string, unknown>;
}

describe('security-gateway · MFA failure contract', () => {
  it('the attempt limit is 3', () => {
    expect(MFA_MAX_ATTEMPTS).toBe(3);
  });

  it('reports each wrong code as a typed, retryable failure with the remaining attempts', async () => {
    const sessionId = freshSessionId();
    const action = await seedLockableAction(sessionId);

    const first = await submitCode(action.id, sessionId, WRONG_CODE);
    expect(first.ok).toBe(false);
    expect(first.status).toBe('awaiting_mfa');
    expect(first.code).toBe('MFA_FAILED');
    expect(first.failure).toMatchObject({
      code: 'MFA_FAILED',
      reason: 'mfa_code_invalid',
      actionId: action.id,
      attemptsUsed: 1,
      attemptsLeft: 2,
      maxAttempts: MFA_MAX_ATTEMPTS,
    });

    const second = await submitCode(action.id, sessionId, WRONG_CODE);
    expect(second.ok).toBe(false);
    expect(second.status).toBe('awaiting_mfa');
    expect(second.code).toBe('MFA_FAILED');
    expect(second.failure).toMatchObject({
      code: 'MFA_FAILED',
      reason: 'mfa_code_invalid',
      actionId: action.id,
      attemptsUsed: 2,
      attemptsLeft: 1,
      maxAttempts: MFA_MAX_ATTEMPTS,
    });

    // Retryable failures NEVER carry the internal block marker in user-facing text.
    for (const outcome of [first, second]) {
      expect(outcome.message).not.toContain('__SECURITY_BLOCK__');
      expect(outcome.failure?.reason).not.toContain('__SECURITY_BLOCK__');
    }
  });

  it('the third wrong code locks the action, the challenge, and reports the terminal reason', async () => {
    const sessionId = freshSessionId();
    const action = await seedLockableAction(sessionId);

    await submitCode(action.id, sessionId, WRONG_CODE);
    await submitCode(action.id, sessionId, WRONG_CODE);
    const third = await submitCode(action.id, sessionId, WRONG_CODE);

    expect(third.ok).toBe(false);
    expect(third.status).toBe('locked');
    expect(third.failure).toMatchObject({
      code: 'MFA_LOCKED',
      reason: 'mfa_attempts_exhausted',
      actionId: action.id,
      attemptsUsed: MFA_MAX_ATTEMPTS,
      attemptsLeft: 0,
      maxAttempts: MFA_MAX_ATTEMPTS,
    });
    expect(third.message).not.toContain('__SECURITY_BLOCK__');

    const pending = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(pending?.status).toBe('locked');

    const challenge = await getMfaChallenge(action.id);
    expect(challenge?.status).toBe('locked');
  });

  it('a correct code on the locked action stays locked: no new challenge, no attempt, no execution', async () => {
    const sessionId = freshSessionId();
    const action = await seedLockableAction(sessionId);

    await submitCode(action.id, sessionId, WRONG_CODE);
    await submitCode(action.id, sessionId, WRONG_CODE);
    await submitCode(action.id, sessionId, WRONG_CODE);

    const challengeBefore = await getTestPrisma().mfaChallenge.count({ where: { actionId: action.id } });
    const attemptsBefore = (await getMfaChallenge(action.id))?.attempts;
    const transactionsBefore = await getTestPrisma().transaction.count();

    const retry = await submitCode(action.id, sessionId, CORRECT_CODE);

    expect(retry.ok).toBe(false);
    expect(retry.status).toBe('locked');
    expect(retry.code).toBe('CIRCUIT_OPEN');
    expect(retry.failure).toMatchObject({
      code: 'CIRCUIT_OPEN',
      reason: 'mfa_session_locked',
      actionId: action.id,
      attemptsLeft: 0,
      maxAttempts: MFA_MAX_ATTEMPTS,
    });
    expect(retry.message).not.toContain('__SECURITY_BLOCK__');

    // Terminal: the lock is NOT reopened and NO verification is re-issued.
    expect(await getTestPrisma().mfaChallenge.count({ where: { actionId: action.id } })).toBe(challengeBefore);
    expect((await getMfaChallenge(action.id))?.attempts).toBe(attemptsBefore);

    // Nothing executed.
    expect(await getTestPrisma().transaction.count()).toBe(transactionsBefore);
    const pending = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(pending?.status).toBe('locked');
    expect((await getMfaChallenge(action.id))?.status).toBe('locked');
  });

  it('audits three MFA_FAILURE records with renderable counts and exactly one breaker trip', async () => {
    const sessionId = freshSessionId();
    const action = await seedLockableAction(sessionId);

    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) await submitCode(action.id, sessionId, WRONG_CODE);

    const failures = await getTestPrisma().securityEvent.findMany({
      where: { sessionId, kind: 'MFA_FAILURE' },
    });
    expect(failures).toHaveLength(MFA_MAX_ATTEMPTS);
    const details = failures.map(detailOf).sort((a, b) => (a.attempts as number) - (b.attempts as number));
    expect(details.map((d) => d.attemptsLeft)).toEqual([2, 1, 0]);
    expect(details.map((d) => d.maxAttempts)).toEqual([MFA_MAX_ATTEMPTS, MFA_MAX_ATTEMPTS, MFA_MAX_ATTEMPTS]);

    const trips = await getTestPrisma().securityEvent.findMany({
      where: { sessionId, kind: 'CIRCUIT_BREAKER_TRIPPED' },
    });
    expect(trips).toHaveLength(1);
  });
});

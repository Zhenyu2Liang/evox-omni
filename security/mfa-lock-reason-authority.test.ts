/**
 * `security/mfa-lock-reason-authority.test.ts` — the SERVER-side authority for MFA refusal semantics.
 *
 * Two gaps are pinned here (DB-backed: challenges, pending actions and audit rows are persisted):
 *
 *  1. REASON AUTHORITY. `mfa_attempts_exhausted` may ONLY be reported for the operation whose OWN
 *     challenge consumed the attempt limit. A refusal caused by the ACCOUNT-level circuit breaker is
 *     `circuit_open` — even though `mfa.verify` reports `locked: true` for any operation of that
 *     account. The per-operation attempt record (`mfa.attemptState`) is the sole authority, never the
 *     breaker state and never the message text.
 *
 *  2. INVALIDATED-CHALLENGE SEMANTICS. A verification submitted for an ALREADY-CONSUMED challenge is
 *     an unambiguously settled decision: the operation moves to a terminal `cancelled` row instead of
 *     being reported as a retryable wrong code with `0` attempts left. Only a RENEWED challenge
 *     (`expired` / `command_changed`) legitimately returns to the "continue verifying" prompt state.
 *
 * RUN: `pnpm exec vitest run security/mfa-lock-reason-authority.test.ts`
 */
import { describe, expect, it, vi } from 'vitest';

import { issueChallenge } from '@/security/mfa';
import { securityGateway } from '@/security/security-gateway';
import type { AuthorizationResult } from '@/security/security-gateway';
import type { SecurityFailure } from '@/lib/contracts/security';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { AppError } from '@/lib/errors';
import { createPendingAction, getMfaChallenge } from '@/lib/db/repositories/pendingAction';
import { newId } from '@/lib/ids';
import { securityNotice } from '@/lib/public-text';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

// The per-test DB reset + seed (`useFreshDatabase`) is I/O heavy and can exceed the default hook
// timeout; give it more room (assertions/determinism untouched).
vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** A code that is never valid for the simulator's step-up challenge. */
const WRONG_CODE = '000000';
/** The correct simulator code for an issued challenge. */
const CORRECT_CODE = '123456';

/** A unique sessionId per test — the breaker state is durable and owner-scoped. */
const freshSessionId = (): string => newId('mfa_reason');

/**
 * A RED `transfer_money` action parked awaiting MFA, with an issued challenge. Distinct `amount`s
 * keep the parked actions of one test visually distinguishable.
 */
async function seedAction(sessionId: string, amount = '5000.00') {
  const action = await createPendingAction({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { amount, contactId: 'contact_zhangwei' },
    tier: 'RED',
    requiresMfa: true,
    status: 'awaiting_mfa',
    summary: { title: '转账', toolName: 'transfer_money', tier: 'RED', fields: [], requiresMfa: true },
  });
  await issueChallenge(action.id);
  return action;
}

/** Submit one verification code through the gateway's public authorization entry point. */
function submitCode(actionId: string, sessionId: string, mfaCode: string): Promise<AuthorizationResult> {
  return securityGateway.authorizeAction(actionId, { userId: DEMO_USER_ID, sessionId, mfaCode });
}

/** The structured refusal facts of a refused authorization (asserts they are present). */
function failureOf(outcome: AuthorizationResult): SecurityFailure {
  expect(outcome.failure, 'a refusal carries structured failure facts').toBeDefined();
  return outcome.failure as SecurityFailure;
}

describe('security/mfa · the per-operation attempt record is the reason authority', () => {
  it('A. an operation whose OWN attempts are exhausted reports mfa_attempts_exhausted and locks', async () => {
    const sessionId = freshSessionId();
    const action = await seedAction(sessionId);

    await submitCode(action.id, sessionId, WRONG_CODE);
    await submitCode(action.id, sessionId, WRONG_CODE);
    const third = await submitCode(action.id, sessionId, WRONG_CODE);

    expect(third.ok).toBe(false);
    expect(third.status).toBe('locked');
    expect(third.code).toBe('CIRCUIT_OPEN');
    expect(failureOf(third)).toMatchObject({
      code: 'MFA_LOCKED',
      reason: 'mfa_attempts_exhausted',
      actionId: action.id,
      attemptsUsed: MFA_MAX_ATTEMPTS,
      attemptsLeft: 0,
      maxAttempts: MFA_MAX_ATTEMPTS,
    });

    expect((await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } }))?.status).toBe('locked');
  });

  it('B. the account breaker tripped by ANOTHER operation reports circuit_open, not attempts-exhausted', async () => {
    const sessionId = freshSessionId();
    const opA = await seedAction(sessionId, '5000.00');
    const opB = await seedAction(sessionId, '6000.00');

    // op A burns two attempts: the breaker counts 2 failures and stays OPEN.
    await submitCode(opA.id, sessionId, WRONG_CODE);
    await submitCode(opA.id, sessionId, WRONG_CODE);

    // op B is a DIFFERENT operation with its OWN first attempt: it trips the account breaker but has
    // never exhausted its own attempt limit.
    const refused = await submitCode(opB.id, sessionId, WRONG_CODE);

    expect(refused.ok).toBe(false);
    expect(refused.status).toBe('locked');
    expect(refused.code).toBe('CIRCUIT_OPEN');
    const failure = failureOf(refused);
    expect(failure.code).toBe('CIRCUIT_OPEN');
    expect(failure.reason).toBe('circuit_open');
    expect(failure.reason).not.toBe('mfa_attempts_exhausted');
    expect(failure.attemptsUsed).toBe(1);
    expect(failure.attemptsLeft).toBe(MFA_MAX_ATTEMPTS - 1);
    expect(failure.maxAttempts).toBe(MFA_MAX_ATTEMPTS);

    // op A's own record is untouched: still undecided, still holding its two consumed attempts.
    expect((await getTestPrisma().pendingAction.findUnique({ where: { id: opA.id } }))?.status).toBe('awaiting_mfa');
    expect((await getMfaChallenge(opA.id))?.attempts).toBe(2);

    // op B consumed exactly one attempt and recorded exactly one failure event.
    const failures = await getTestPrisma().securityEvent.findMany({
      where: { sessionId, kind: 'MFA_FAILURE' },
    });
    const ownFailures = failures
      .map((row) => JSON.parse(row.detail ?? '{}') as Record<string, unknown>)
      .filter((detail) => detail.actionId === opB.id);
    expect(ownFailures).toHaveLength(1);
    expect(ownFailures[0]?.attempts).toBe(1);
  });

  it('C. an operation with ZERO own attempts stays circuit_open and is locked durably (never executed)', async () => {
    const sessionId = freshSessionId();
    const opA = await seedAction(sessionId, '5000.00');
    const opC = await seedAction(sessionId, '7000.00');

    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) await submitCode(opA.id, sessionId, WRONG_CODE);

    // op C never submitted a single code — and submits the CORRECT one here.
    const refused = await submitCode(opC.id, sessionId, CORRECT_CODE);

    expect(refused.ok).toBe(false);
    expect(refused.status).toBe('locked');
    expect(refused.code).toBe('CIRCUIT_OPEN');
    const failure = failureOf(refused);
    expect(failure.code).toBe('CIRCUIT_OPEN');
    expect(failure.reason).toBe('circuit_open');
    // No attempt was consumed by this refusal. The terminal-lock refusal deliberately OMITS the
    // per-attempt counter (`tests/app/mfa-lock-http-contract.test.ts` pins its absence), so an absent
    // value is exactly "0 attempts used".
    expect(failure.attemptsUsed ?? 0).toBe(0);

    // Fail-closed AND durable: the row can no longer read as an undecided operation.
    expect((await getTestPrisma().pendingAction.findUnique({ where: { id: opC.id } }))?.status).toBe('locked');
    // …and op C's own challenge is untouched: no attempt consumed, no verification marked.
    const challenge = await getMfaChallenge(opC.id);
    expect(challenge?.attempts).toBe(0);
    expect(challenge?.status).toBe('pending');
  });
});

describe('security/mfa · an invalidated challenge is a settled decision, not a retryable wrong code', () => {
  it('D. a CONSUMED challenge moves the operation to terminal cancelled (no retry, no attempt, no money)', async () => {
    const sessionId = freshSessionId();
    const action = await seedAction(sessionId);
    // The gateway only re-signs a challenge that is missing/expired/changed, so consuming the current
    // one reproduces exactly the case that reaches `verify` with a stale `consumedAt`.
    await getTestPrisma().mfaChallenge.update({
      where: { actionId: action.id },
      data: { consumedAt: new Date() },
    });

    const transactionsBefore = await getTestPrisma().transaction.count();
    const outcome = await submitCode(action.id, sessionId, CORRECT_CODE);

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('cancelled');
    expect(outcome.status).not.toBe('awaiting_mfa');
    expect(outcome.status).not.toBe('pending');
    const failure = failureOf(outcome);
    expect(failure.reason).not.toBe('mfa_code_invalid');
    expect(failure.code).not.toBe('MFA_FAILED');
    expect(failure.code).toBe('CONFLICT');
    expect(failure.reason).toBe('denied');
    // The public rendering must be "denied", never "N attempts left".
    expect(securityNotice(failure, (key) => key)).toBe('chat.error.securityDenied');

    // Terminal on the ROW, no attempt consumed, nothing executed.
    expect((await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } }))?.status).toBe('cancelled');
    expect((await getMfaChallenge(action.id))?.attempts).toBe(0);
    expect(await getTestPrisma().transaction.count()).toBe(transactionsBefore);

    // A second submission is a conflict: the decision is already settled.
    const again = await submitCode(action.id, sessionId, CORRECT_CODE).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(AppError);
    expect((again as AppError).code).toBe('CONFLICT');
  });

  it('E. an EXPIRED challenge is re-issued and returns the prompt state without consuming an attempt', async () => {
    const sessionId = freshSessionId();
    const action = await seedAction(sessionId);
    await getTestPrisma().mfaChallenge.update({
      where: { actionId: action.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const outcome = await submitCode(action.id, sessionId, WRONG_CODE);

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('awaiting_mfa');
    expect(outcome.requiresMfa).toBe(true);
    // A prompt state is NOT a refusal: it carries no `code` and no `failure`.
    expect(outcome.code).toBeUndefined();
    expect(outcome.failure).toBeUndefined();

    const challenge = await getMfaChallenge(action.id);
    expect(challenge?.attempts).toBe(0);
    expect(challenge?.consumedAt).toBeNull();
    expect(challenge?.status).toBe('pending');
    expect(challenge?.expiresAt).toBeInstanceOf(Date);
    expect((challenge?.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());

    // Still an undecided operation: a fresh code can still complete it.
    expect((await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } }))?.status).toBe('awaiting_mfa');
  });
});

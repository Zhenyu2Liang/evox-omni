/**
 * MFA — mock strong verification for RED operations.
 *
 * The accepted code is the fixed demo `MFA_CODE` ('123456'). It is stored against the
 * pending action and is **NEVER returned** by any function of this module (not to the
 * UI, not to the model, not in `MfaChallengeView`). The demo value is disclosed only in
 * `README.md`, so verification still requires an out-of-band knowledge step.
 *
 * Failures feed the session circuit breaker (`./circuit-breaker`) and emit a COMPLETE
 * `MFA_FAILURE` SecurityEvent (severity `medium`) whose `detail` carries the decision,
 * the outcome/result and the threshold counts.
 */
import { AppError, ok, err } from '../lib/errors';
import type { Result } from '../lib/errors';
import { MFA_CODE, MFA_MAX_ATTEMPTS } from '../lib/constants';
import {
  getPendingAction,
  getMfaChallenge,
  createMfaChallenge,
  incrementMfaAttempts,
  updateMfaChallengeStatus,
  resetMfaAttempts,
} from '../lib/db/repositories/pendingAction';
import { isLocked, recordFailure, recordSuccess, resolveBreakerOwner } from './circuit-breaker';
import { recordSecurityEvent } from '../audit';

/** Safe, code-free view of a challenge handed to the caller/UI. */
export interface MfaChallengeView {
  actionId: string;
  /** Failed attempts so far. */
  attempts: number;
  /** `MFA_MAX_ATTEMPTS`. */
  maxAttempts: number;
  verified: boolean;
  createdAt: number;
  /** Generic delivery message — MUST NOT contain the code. */
  hint: string;
}

export interface MfaVerifyResult {
  ok: boolean;
  /** Remaining attempts before the circuit breaker trips. */
  attemptsLeft: number;
  /** Circuit-breaker state for the owning session after this attempt. */
  locked: boolean;
}

/** Generic, code-free delivery hint shown to the user. */
const DELIVERY_HINT = '为完成高风险操作，请输入 6 位短信验证码。';

/** Persisted challenge row shape needed to build a view (structural — no repo import coupling). */
interface ChallengeRow {
  actionId: string;
  attempts: number;
  maxAttempts: number;
  status: string;
  createdAt: Date;
}

/** Map a persisted challenge row to the code-free public view. NEVER leaks `code`. */
function toView(ch: ChallengeRow): MfaChallengeView {
  return {
    actionId: ch.actionId,
    attempts: ch.attempts,
    maxAttempts: ch.maxAttempts,
    verified: ch.status === 'verified',
    createdAt: ch.createdAt.getTime(),
    hint: DELIVERY_HINT,
  };
}

/**
 * Issue (or re-issue) a challenge for `actionId`. Stores `MFA_CODE` server-side and
 * returns a code-free `MfaChallengeView`.
 * Errors (e.g. unknown action) surface as a thrown `AppError`.
 */
export async function issueChallenge(actionId: string): Promise<MfaChallengeView> {
  const action = await getPendingAction(actionId);
  if (!action) {
    throw new AppError('NOT_FOUND', `未找到待处理操作: ${actionId}`);
  }

  const existing = await getMfaChallenge(actionId);
  if (existing) {
    await resetMfaAttempts(actionId);
    const refreshed = await updateMfaChallengeStatus(actionId, 'pending');
    return toView(refreshed);
  }

  const challenge = await createMfaChallenge({
    actionId,
    code: MFA_CODE,
    maxAttempts: MFA_MAX_ATTEMPTS,
  });
  return toView(challenge);
}

/**
 * Verify a submitted code against the stored challenge.
 *  - correct code → mark verified, `recordSuccess` the breaker → `ok({ ok: true, ... })`.
 *  - wrong code   → increment attempts, `recordFailure` the breaker, emit `MFA_FAILURE`
 *                   → `ok({ ok: false, attemptsLeft, locked })`.
 *  - locked       → `ok({ ok: false, locked: true })` regardless of the code (checked FIRST).
 *  - no challenge → `err(AppError('NOT_FOUND' | 'CONFLICT'))`.
 * Never swallows errors.
 */
export async function verify(actionId: string, code: string): Promise<Result<MfaVerifyResult>> {
  const challenge = await getMfaChallenge(actionId);
  if (!challenge) {
    return err(new AppError('NOT_FOUND', `未找到验证码挑战: ${actionId}`));
  }

  const action = await getPendingAction(actionId);
  if (!action) {
    return err(new AppError('NOT_FOUND', `未找到待处理操作: ${actionId}`));
  }
  const sessionId = action.sessionId;

  // LOCKED wins: a locked session or a locked challenge fails verification regardless of the
  // submitted code. Do NOT mark verified, do NOT reset the breaker, do NOT consume an attempt
  // and do NOT emit a new event.
  if ((await isLocked(sessionId)) || challenge.status === 'locked') {
    return ok({
      ok: false,
      attemptsLeft: Math.max(0, challenge.maxAttempts - challenge.attempts),
      locked: true,
    });
  }

  // Already verified: report success without consuming a new attempt.
  if (challenge.status === 'verified') {
    return ok({
      ok: true,
      attemptsLeft: challenge.maxAttempts - challenge.attempts,
      locked: await isLocked(sessionId),
    });
  }

  // Correct code → verify + reset the consecutive-failure counter.
  if (code === challenge.code) {
    await updateMfaChallengeStatus(actionId, 'verified');
    await recordSuccess(sessionId);
    return ok({
      ok: true,
      attemptsLeft: challenge.maxAttempts,
      locked: await isLocked(sessionId),
    });
  }

  // Wrong code → count the attempt, feed the breaker, then emit a COMPLETE MFA_FAILURE record.
  const after = await incrementMfaAttempts(actionId);
  const breaker = await recordFailure(sessionId);
  const owner = await resolveBreakerOwner(sessionId);
  const attemptsLeft = Math.max(0, after.maxAttempts - after.attempts);
  await recordSecurityEvent({
    sessionId,
    ...(owner.userId !== undefined ? { userId: owner.userId } : {}),
    kind: 'MFA_FAILURE',
    severity: 'medium',
    message: `验证码错误（第 ${after.attempts} 次失败）。`,
    detail: {
      actionId,
      decision: 'reject_code',
      result: breaker.locked ? 'session_locked' : 'attempt_counted',
      attempts: after.attempts,
      maxAttempts: after.maxAttempts,
      attemptsLeft,
      locked: breaker.locked,
    },
  });

  if (after.attempts >= after.maxAttempts) {
    await updateMfaChallengeStatus(actionId, 'locked');
  }

  return ok({
    ok: false,
    attemptsLeft,
    locked: breaker.locked,
  });
}

/** Read the code-free challenge view for `actionId`, or `null` if none exists. */
export async function getChallenge(actionId: string): Promise<MfaChallengeView | null> {
  const challenge = await getMfaChallenge(actionId);
  return challenge ? toView(challenge) : null;
}

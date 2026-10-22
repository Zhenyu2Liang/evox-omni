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
import type { SecurityFailure } from '../lib/contracts/security';
import { MFA_MAX_ATTEMPTS } from '../lib/constants';
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
import { realNow } from '../lib/clock';
import { prisma } from '../lib/db/client';
import { requestDigest } from '../lib/ledger';
import { safeParse } from '../lib/json';
import { canonicalCommandArgs } from '../lib/contracts/command';
import { stepUpAuthenticator } from './step-up-authenticator';

export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;

function challengeDigest(action: { userId: string; toolName: string; argsJson: string }): string {
  return requestDigest({ userId: action.userId, toolName: action.toolName,
    args: canonicalCommandArgs(safeParse<Record<string, unknown>>(action.argsJson, {})) });
}

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
const DELIVERY_HINT = 'Enter the 6-digit demo verification code. No SMS is sent.';

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
 *
 * A TERMINAL `locked` action (MFA attempts exhausted) and already settled actions
 * (`executed`/`cancelled`) are refused with a typed `AppError` — see the guards below.
 */
export async function issueChallenge(actionId: string): Promise<MfaChallengeView> {
  const action = await getPendingAction(actionId);
  if (!action) {
    throw new AppError('NOT_FOUND', `未找到待处理操作: ${actionId}`);
  }

  // `locked` is TERMINAL and wins over everything: no challenge is issued, refreshed or reset and
  // nothing is written. Minting a code here would hand out fresh attempts against an operation the
  // MFA attempt limit already killed — an account unlock (`circuit-breaker.ts#resetSession`) clears
  // the breaker and the failure counter but never revives the operation, so a re-issued code plus a
  // later successful `verify` would be the only thing standing between `locked` and execution.
  // The refusal is typed data (`SecurityFailure`), never free text the caller has to parse.
  if (action.status === 'locked') {
    const failure: SecurityFailure = { code: 'MFA_LOCKED', reason: 'mfa_session_locked', actionId };
    throw new AppError('MFA_LOCKED', '该操作已因验证码错误次数过多被安全锁定，无法重新签发验证码；请重新发起新的操作。', failure);
  }

  // A settled operation can never be verified again, so no code is minted for it either.
  if (action.status === 'executed' || action.status === 'cancelled') {
    const failure: SecurityFailure = { code: 'CONFLICT', reason: 'denied', actionId };
    throw new AppError('CONFLICT', '该操作已执行或已取消，无法再签发验证码。', failure);
  }

  const existing = await getMfaChallenge(actionId);
  if (existing) {
    // A `locked` challenge is retired for good: resetting it to `pending` would replenish the attempt
    // counter even before (or without) the action row itself being locked. It may only be renewed by
    // `renewLockedMfaChallenges` (constrained to `awaiting_mfa` actions) or by a NEW operation.
    if (existing.status === 'locked') return toView(existing);
    if (existing.expiresAt && existing.expiresAt.getTime() > realNow() &&
        existing.commandDigest === challengeDigest(action)) return toView(existing);
    await resetMfaAttempts(actionId);
    const refreshed = await prisma.mfaChallenge.update({ where: { actionId }, data: {
      status: 'pending', code: await stepUpAuthenticator().issue(actionId, action.userId),
      expiresAt: new Date(realNow() + MFA_CHALLENGE_TTL_MS), commandDigest: challengeDigest(action),
      verifiedAt: null, consumedAt: null,
    } });
    return toView(refreshed);
  }

  const challenge = await createMfaChallenge({
    actionId,
    code: await stepUpAuthenticator().issue(actionId, action.userId),
    maxAttempts: MFA_MAX_ATTEMPTS,
    expiresAt: new Date(realNow() + MFA_CHALLENGE_TTL_MS),
    commandDigest: challengeDigest(action),
  });
  return toView(challenge);
}

/**
 * Verify a submitted code against the stored challenge.
 *  - correct code → mark verified, `recordSuccess` the breaker → `ok({ ok: true, ... })`.
 *  - wrong code   → increment attempts, `recordFailure` the breaker, emit `MFA_FAILURE`
 *                   → `ok({ ok: false, attemptsLeft, locked })`.
 *  - locked       → `ok({ ok: false, locked: true })` regardless of the code (checked FIRST: a
 *                   terminally `locked` action, a locked session or a locked challenge).
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
  if (challenge.consumedAt) return err(new AppError('MFA_FAILED', 'This verification challenge has already been consumed.'));
  if (!challenge.expiresAt || challenge.expiresAt.getTime() <= realNow() ||
      (challenge.commandDigest !== null && challenge.commandDigest !== challengeDigest(action))) {
    return err(new AppError('MFA_FAILED', 'The verification challenge expired or the operation changed. Request a new challenge.'));
  }

  // LOCKED action wins and is TERMINAL: once the MFA attempt limit locked the operation, no code —
  // not even the correct one — may verify it again. An account unlock clears the breaker and the
  // failure counter only; it never revives the action, so a successful verification here would be
  // the single remaining path from `locked` to execution. Nothing is written, no attempt is
  // consumed, no `MFA_FAILURE` event is emitted and the breaker is left untouched.
  if (action.status === 'locked') {
    return ok({ ok: false, attemptsLeft: 0, locked: true });
  }

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
  if (stepUpAuthenticator().verify(challenge.code, code)) {
    await prisma.mfaChallenge.update({ where: { actionId }, data: { status: 'verified', verifiedAt: new Date(realNow()) } });
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

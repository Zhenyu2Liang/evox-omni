/**
 * Unit: security/mfa — mock strong verification for RED operations (the code NEVER leaks).
 *
 * Targets `@/security/mfa`: issueChallenge(actionId), verify(actionId, code), getChallenge(actionId)
 * (+ types MfaChallengeView, MfaVerifyResult), backed by MFA_CODE = '123456'.
 *
 * Issue/verify/getChallenge read & write MfaChallenge rows and feed the circuit breaker +
 * MFA_FAILURE SecurityEvent → require test SQLite via ../helpers/db.
 */
import { describe, it } from 'vitest';

// import { issueChallenge, verify, getChallenge } from '@/security/mfa';   // <- uncomment in Phase 2
// import { MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';

describe('mfa · issueChallenge', () => {
  it.todo('returns a MfaChallengeView with actionId, attempts 0, maxAttempts MFA_MAX_ATTEMPTS, verified false, createdAt set');
  it.todo('the view NEVER contains the code ("123456" absent from every field, including hint)');
  it.todo('re-issuing for the same action refreshes the challenge view');
  it.todo('an unknown / non-existent action surfaces a thrown AppError');
});

describe('mfa · verify success', () => {
  it.todo("correct code '123456' → ok({ ok: true, locked: false }) with attemptsLeft == MFA_MAX_ATTEMPTS");
  it.todo('after success, getChallenge reports verified true');
  it.todo('a successful verification records a breaker success (resets consecutive failures)');
});

describe('mfa · verify failure + breaker', () => {
  it.todo('a wrong code → ok({ ok: false, locked: false, attemptsLeft: MFA_MAX_ATTEMPTS - 1 })');
  it.todo('each wrong code decrements attemptsLeft and increments the challenge attempts');
  it.todo('the 3rd wrong code → locked true (breaker tripped) in the returned result');
  it.todo('a wrong code emits an MFA_FAILURE SecurityEvent (needs test SQLite)');
});

describe('mfa · unknown action', () => {
  it.todo("verify for an unknown actionId → err(AppError 'NOT_FOUND' | 'CONFLICT')");
  it.todo('getChallenge for an unknown actionId → null');
});

describe('mfa · code non-disclosure', () => {
  it.todo('no exported function ever returns the code: it is absent from MfaChallengeView and MfaVerifyResult');
});

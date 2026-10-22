/**
 * tests/app/mfa-lock-http-contract.test.ts — the HTTP-EDGE contract of the "MFA three consecutive
 * wrong codes ⇒ TERMINAL lock" rule.
 *
 * WHY THIS EXISTS: `tests/app/mfa-terminal-lock-http.test.ts` proves the DYNAMIC fix (a locked row
 * stops being surfaced and stops re-prompting). This spec pins the TRANSPORT CONTRACT the client
 * depends on around the same lock, which no other spec asserts end-to-end:
 *   1. the per-attempt HTTP ladder — three wrong `POST /api/actions/:id/verify` calls answer a
 *      normal `200` each time, with `data.ok:false` and the FULL typed refusal (`status`, `code`,
 *      `failure.code`, `failure.reason`, `attemptsUsed` 1→2→3, `attemptsLeft` 2→1→0, `maxAttempts`);
 *   2. a retry AFTER the lock — even with the CORRECT code — is the terminal `CIRCUIT_OPEN` /
 *      `mfa_session_locked` refusal and every observable fact stays frozen;
 *   3. `cancel` / `recover` on the locked row hit the app-layer guard (`app/api/_lib/locked-action.ts`)
 *      and refuse without writing or replaying anything;
 *   4. `GET /api/security` surfaces the lock + the locked action.
 *
 * All four are driven through the REAL Next.js route handlers with real `NextRequest`s
 * (`./harness.ts`) and the real SQLite test DB; the plan-parked RED transfer is seeded through the
 * PRODUCTION `submit_plan` runner by `tests/helpers/locked-action.ts`, which also owns the gateway
 * MFA ladder and the DB probes (never `security/mfa.ts#verify` — it locks only the CHALLENGE and
 * leaves the action `awaiting_mfa`, i.e. exactly the popup-loop regression).
 *
 * Only the MODEL is scripted (`tests/setup.ts` forces `LLM_MODE=mock`). Offline, no network.
 * `beforeEach` resets the DB because the circuit breaker is OWNER-scoped: a lock left by one test
 * would otherwise leak into the next.
 *
 * A terminal lock is ALWAYS HTTP 200. `423 CIRCUIT_OPEN` is thrown ONLY by `POST /api/security/reset`
 * and is deliberately NOT reachable from any route asserted here.
 *
 * KNOWN RED (group 4, ONE expectation): the required contract is that `GET /api/security#lock` names
 * the MFA attempt exhaustion (`reason:'mfa_attempts_exhausted'` + its counters) while the account is
 * frozen. Production returns the FIXED `{ code:'CIRCUIT_OPEN', reason:'circuit_open' }` constant
 * (`app/api/security/route.ts#LOCKED_FAILURE`) with no counters. That expectation is kept UNWEAKENED
 * and is the only failing assertion in this file; the production root cause is documented inline.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as actionsGet } from '@/app/api/actions/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { GET as securityGet } from '@/app/api/security/route';
import type { SecurityData } from '@/app/api/security/route';
import type { ActionResponse, SurfacedPendingAction } from '@/app/api/_lib/types';
import { MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { normalizeMoney } from '@/lib/money';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS } from '@/tests/helpers/fixtures';
import {
  CORRECT_MFA_CODE,
  WRONG_MFA_CODE,
  auditLogCount,
  checkingBalance,
  demoSessionId,
  lockAction,
  mfaChallengesFor,
  parkRedTransferPlan,
  pendingActionRow,
  securityEventsOfKind,
  submitMfaCode,
  transactionsCount,
  zhangweiTransfers,
} from '@/tests/helpers/locked-action';
import { actionUrl, getJson, idCtx, postJson, type HttpResult, type RouteHandler } from './harness';

/* --------------------------------------------------------------------------------- fixtures */

/** The seeded 活期 account (`acct_checking`) — the account a parked transfer would debit. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance — a refused transfer must never move it. */
const SEEDED_BALANCE = normalizeMoney(CHECKING.balance);

/**
 * The FIXED, code-free sentence `app/api/_lib/locked-action.ts` returns for a refused decision on a
 * `locked` row. Pinned verbatim: it is part of the client contract, and it must never interpolate
 * the internal status token, an attempt count or a verification code.
 */
const LOCKED_ACTION_MESSAGE = '该操作已被安全锁定，无法继续执行；解锁后需要重新发起并重新确认。';

/**
 * The route envelope (`{ ok: true, data }` | `{ ok: false, error }`). Declared structurally — it is
 * the HTTP transport shape, not a frozen `@/lib/contracts` type.
 */
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/* -------------------------------------------------------------------------- envelope helpers */

/** Assert the envelope is a SUCCESS envelope and return its payload. */
function payload<T>(res: HttpResult<Envelope<T>>): T {
  expect(res.data?.ok, `expected a success envelope, got ${JSON.stringify(res.data)}`).toBe(true);
  return res.data!.data as T;
}

/**
 * Assert the TRANSPORT shape of a security refusal — HTTP `200` (a terminal lock is NEVER an HTTP
 * error) — and return the DOMAIN payload, whose own `ok` each caller then asserts to be `false`.
 */
function refusal(label: string, res: HttpResult<Envelope<ActionResponse>>): ActionResponse {
  expect(res.status, `${label}: a refusal is a normal 200, never an HTTP error status`).toBe(200);
  const data = payload(res);
  expect(data.ok, `${label}: the DOMAIN outcome must be ok:false`).toBe(false);
  return data;
}

/** The literal demo MFA code must never be echoed back in any captured body. */
function expectNoCodeLeak(label: string, ...bodies: unknown[]): void {
  for (const body of bodies) {
    expect(JSON.stringify(body), `${label}: the MFA code leaked into a response body`).not.toContain(
      MFA_CODE,
    );
  }
}

/* -------------------------------------------------------------------------------- invokers */

/** Drive the real verify route with the given code and the demo-session cookie. */
function verifyAction(
  id: string,
  code: string,
  sessionId: string,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(verifyPost, actionUrl(id, 'verify'), { code }, {
    ctx: idCtx(id),
    sessionId,
  });
}

/** Drive a bodyless decision route (`cancel` / `recover`) for `id`. */
function decisionAction(
  handler: RouteHandler,
  verb: 'cancel' | 'recover',
  id: string,
  sessionId: string,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(handler, actionUrl(id, verb), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

/** `GET /api/actions` — the actions the UI would surface as pending decisions. */
async function surfacedActions(sessionId: string): Promise<SurfacedPendingAction[]> {
  const res = await getJson<Envelope<SurfacedPendingAction[]>>(actionsGet, '/api/actions', {
    sessionId,
  });
  expect(res.status).toBe(200);
  return payload(res);
}

/** `GET /api/security` — the security-center read model. */
async function securityStatus(sessionId: string): Promise<SecurityData> {
  const res = await getJson<Envelope<SecurityData>>(securityGet, '/api/security', { sessionId });
  expect(res.status).toBe(200);
  return payload(res);
}

/* --------------------------------------------------------------- fail-closed side-effect probe */

/**
 * Every observable fact a refusal on a LOCKED action must leave EXACTLY as it was: the durable
 * action row (status + last write), the durable challenge marker (row count + consumed attempts),
 * the audit trail, security events, the ledger, execution receipts and the account cash.
 */
interface SideEffects {
  actionStatus: string;
  actionUpdatedAt: number;
  challengeRows: number;
  challengeAttempts: number;
  auditRows: number;
  /** Audit rows of THIS session (a refusal must add none to the caller's own trail). */
  sessionAuditRows: number;
  securityEvents: number;
  ledgerRows: number;
  receiptRows: number;
  balance: string;
  zhangweiLedgerRows: number;
}

/** Read the current side-effect snapshot for one action / session. */
async function sideEffects(actionId: string, sessionId: string): Promise<SideEffects> {
  const prisma = getTestPrisma();
  const row = await pendingActionRow(actionId);
  const challenges = await mfaChallengesFor(actionId);
  return {
    actionStatus: row?.status ?? 'MISSING',
    actionUpdatedAt: row?.updatedAt.getTime() ?? -1,
    challengeRows: challenges.length,
    challengeAttempts: challenges.reduce((total, challenge) => total + challenge.attempts, 0),
    auditRows: await auditLogCount(),
    sessionAuditRows: await auditLogCount(sessionId),
    securityEvents: await prisma.securityEvent.count({ where: { sessionId } }),
    ledgerRows: await transactionsCount(),
    receiptRows: await prisma.executionReceipt.count(),
    balance: await checkingBalance(),
    zhangweiLedgerRows: (await zhangweiTransfers()).length,
  };
}

/** Assert NOTHING observable moved since `before` (the whole refusal is fail-closed). */
async function expectFrozen(
  label: string,
  actionId: string,
  sessionId: string,
  before: SideEffects,
): Promise<void> {
  expect(
    await sideEffects(actionId, sessionId),
    `${label}: a refusal on a locked action must write nothing, replay nothing, consume no attempt and move no money`,
  ).toEqual(before);
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ============================================================ 1. the per-attempt HTTP ladder */

/** One row of the ladder: the COMPLETE typed refusal the verify route must answer with. */
interface LadderStep {
  /** Which consecutive wrong-code submission this is. */
  attempt: number;
  /** The persisted + returned action status. */
  status: 'awaiting_mfa' | 'locked';
  /** The route's TOP-LEVEL typed refusal code. */
  code: 'MFA_FAILED' | 'CIRCUIT_OPEN';
  /** The refusal's typed failure code (the `failure` payload keeps the finer-grained reason). */
  failureCode: 'MFA_FAILED' | 'MFA_LOCKED';
  reason: 'mfa_code_invalid' | 'mfa_attempts_exhausted';
  attemptsUsed: number;
  attemptsLeft: number;
  /** The durable `MfaChallenge.status` after this attempt. */
  challengeStatus: 'pending' | 'locked';
}

/**
 * The three-strike ladder, attempt by attempt. Attempts #1/#2 are NON-terminal (`MFA_FAILED` /
 * `mfa_code_invalid`, the action stays `awaiting_mfa`); only #3 trips the OWNER-scoped breaker and
 * persists the TERMINAL `locked` status (`CIRCUIT_OPEN` at the top level, `MFA_LOCKED` on the
 * failure, `mfa_attempts_exhausted` as the reason).
 */
const LADDER: readonly LadderStep[] = [
  {
    attempt: 1,
    status: 'awaiting_mfa',
    code: 'MFA_FAILED',
    failureCode: 'MFA_FAILED',
    reason: 'mfa_code_invalid',
    attemptsUsed: 1,
    attemptsLeft: 2,
    challengeStatus: 'pending',
  },
  {
    attempt: 2,
    status: 'awaiting_mfa',
    code: 'MFA_FAILED',
    failureCode: 'MFA_FAILED',
    reason: 'mfa_code_invalid',
    attemptsUsed: 2,
    attemptsLeft: 1,
    challengeStatus: 'pending',
  },
  {
    attempt: 3,
    status: 'locked',
    code: 'CIRCUIT_OPEN',
    failureCode: 'MFA_LOCKED',
    reason: 'mfa_attempts_exhausted',
    attemptsUsed: 3,
    attemptsLeft: 0,
    challengeStatus: 'locked',
  },
];

describe('MFA three-strike ladder over the HTTP edge', () => {
  it('[integration] three wrong codes answer 200/ok:false three times and only the THIRD persists the terminal lock', async () => {
    const sessionId = await demoSessionId();
    const parked = await parkRedTransferPlan();
    expect(parked.sessionId).toBe(sessionId);

    for (const step of LADDER) {
      const label = `attempt #${step.attempt}`;
      const res = await verifyAction(parked.actionId, WRONG_MFA_CODE, sessionId);
      const data = refusal(label, res);

      // The typed refusal the client renders — never a parsed message.
      expect(data.actionId, `${label}: the refusal names the action`).toBe(parked.actionId);
      expect(data.sessionId, `${label}: the refusal names the owning session`).toBe(sessionId);
      expect(data.status, `${label}: status`).toBe(step.status);
      expect(data.code, `${label}: top-level code`).toBe(step.code);
      expect(data.mfaResult, `${label}: a failed verification is mfaResult:failed`).toBe('failed');
      expect(data.tier, `${label}: a >¥1,000 transfer stays RED`).toBe('RED');
      expect(data.requiresMfa, `${label}: the action still needs strong verification`).toBe(true);
      expect(typeof data.message, `${label}: a safe user-facing message is present`).toBe('string');
      expect(data.message.length, `${label}: the message is never empty`).toBeGreaterThan(0);

      // The structured `failure` — the SAME numbers at both levels where the route exposes them.
      expect(data.failure, `${label}: a security refusal always carries its structured failure`).toBeDefined();
      const failure = data.failure!;
      expect(failure.code, `${label}: failure.code`).toBe(step.failureCode);
      expect(failure.reason, `${label}: failure.reason`).toBe(step.reason);
      expect(failure.actionId, `${label}: failure.actionId`).toBe(parked.actionId);
      expect(failure.attemptsUsed, `${label}: failure.attemptsUsed`).toBe(step.attemptsUsed);
      expect(failure.attemptsLeft, `${label}: failure.attemptsLeft`).toBe(step.attemptsLeft);
      expect(failure.maxAttempts, `${label}: failure.maxAttempts`).toBe(MFA_MAX_ATTEMPTS);
      expect(step.attemptsLeft, `${label}: the ladder itself must descend 2→1→0`).toBe(
        MFA_MAX_ATTEMPTS - step.attempt,
      );

      // The route hoists the same two counters to the TOP level for a code-free client read.
      expect(data.attemptsLeft, `${label}: top-level attemptsLeft`).toBe(step.attemptsLeft);
      expect(data.maxAttempts, `${label}: top-level maxAttempts`).toBe(MFA_MAX_ATTEMPTS);

      // Durable facts: the row and the challenge ladder move together, and only #3 is terminal.
      const row = await pendingActionRow(parked.actionId);
      expect(row?.status, `${label}: the persisted action status`).toBe(step.status);
      const challenges = await mfaChallengesFor(parked.actionId);
      expect(challenges, `${label}: exactly one durable MFA challenge per action`).toHaveLength(1);
      expect(challenges[0]?.attempts, `${label}: the challenge counted this attempt`).toBe(step.attempt);
      expect(challenges[0]?.maxAttempts, `${label}: the challenge carries the attempt limit`).toBe(
        MFA_MAX_ATTEMPTS,
      );
      expect(challenges[0]?.status, `${label}: the challenge ladder`).toBe(step.challengeStatus);

      // Fail-closed per attempt: no money ever moves and no verification code is echoed back.
      expect(await checkingBalance(), `${label}: no cash moved`).toBe(SEEDED_BALANCE);
      expect(await zhangweiTransfers(), `${label}: no ledger row written`).toHaveLength(0);
      expectNoCodeLeak(label, res.data);
    }

    // The THIRD attempt is the terminal lock, and it is durable on BOTH markers — the two facts the
    // popup-loop regression broke (the action used to stay `awaiting_mfa` and re-prompt forever).
    const lockedRow = await pendingActionRow(parked.actionId);
    expect(lockedRow?.status, 'the terminal lock is persisted on the PendingAction row').toBe('locked');
    const [terminalChallenge] = await mfaChallengesFor(parked.actionId);
    expect(terminalChallenge?.status, 'the terminal lock is persisted on the MfaChallenge row').toBe(
      'locked',
    );
    expect(terminalChallenge?.attempts, 'the lock consumed exactly the attempt limit').toBe(
      MFA_MAX_ATTEMPTS,
    );
  });
});

/* ================================================ 2. a retry AFTER the lock is a frozen refusal */

describe('a retry on a locked action', () => {
  it('[integration] the CORRECT code after the lock stays a 200 CIRCUIT_OPEN/mfa_session_locked refusal with nothing written', async () => {
    const sessionId = await demoSessionId();
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, sessionId);

    // The lock itself is observable in the audit trail BEFORE the retry, so the freeze below is
    // meaningful: the retry must add no event and no attempt to this trail.
    const failures = await securityEventsOfKind(sessionId, 'MFA_FAILURE');
    expect(failures, 'the three wrong codes each recorded an MFA_FAILURE event').toHaveLength(
      MFA_MAX_ATTEMPTS,
    );
    expect(
      await securityEventsOfKind(sessionId, 'CIRCUIT_BREAKER_TRIPPED'),
      'tripping the owner breaker recorded exactly one trip event',
    ).toHaveLength(1);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);

    const before = await sideEffects(parked.actionId, sessionId);
    expect(before.actionStatus, 'precondition: the row is locked').toBe('locked');
    expect(before.challengeRows, 'precondition: one durable challenge').toBe(1);
    expect(before.challengeAttempts, 'precondition: the attempt limit was consumed').toBe(
      MFA_MAX_ATTEMPTS,
    );

    const res = await verifyAction(parked.actionId, CORRECT_MFA_CODE, sessionId);
    const data = refusal('correct code after lock', res);

    expect(data.actionId).toBe(parked.actionId);
    expect(data.status, 'a correct code can NEVER lift a terminal lock').toBe('locked');
    expect(data.code, 'top-level code').toBe('CIRCUIT_OPEN');
    expect(data.mfaResult, 'the verification did not succeed').toBe('failed');
    expect(data.tier).toBe('RED');
    expect(data.requiresMfa).toBe(true);

    const failure = data.failure!;
    expect(failure).toBeDefined();
    expect(failure.code, 'failure.code').toBe('CIRCUIT_OPEN');
    expect(failure.reason, 'failure.reason distinguishes this from the attempt-exhaustion refusal').toBe(
      'mfa_session_locked',
    );
    expect(failure.actionId).toBe(parked.actionId);
    // The session-locked refusal carries no per-attempt counter: nothing was attempted.
    expect(
      'attemptsUsed' in failure,
      'failure.attemptsUsed must be ABSENT — no attempt was consumed by this refusal',
    ).toBe(false);

    // Fail-closed: no new challenge row/attempt, no audit row, no security event, no ledger row, no
    // receipt, no cash movement and no row rewrite (status AND last-write timestamp are frozen).
    await expectFrozen('correct code after lock', parked.actionId, sessionId, before);
    expect(await mfaChallengesFor(parked.actionId), 'no new MfaChallenge row was issued').toHaveLength(1);
    expect(
      await securityEventsOfKind(sessionId, 'mfa_required'),
      'the retry re-prompted no verification event',
    ).toHaveLength(0);

    // The locked row stays terminal — never written back to an undecided status.
    const after = await pendingActionRow(parked.actionId);
    expect(after?.status).toBe('locked');
    expect(after?.updatedAt.getTime()).toBe(before.actionUpdatedAt);
    expect((await surfacedActions(sessionId)).map((action) => action.id)).not.toContain(
      parked.actionId,
    );
    expectNoCodeLeak('correct code after lock', res.data);
  });

  it('[integration] the WRONG code after the lock is refused identically (the lock never reopens an attempt)', async () => {
    const sessionId = await demoSessionId();
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, sessionId);
    const before = await sideEffects(parked.actionId, sessionId);

    const data = refusal('wrong code after lock', await verifyAction(parked.actionId, WRONG_MFA_CODE, sessionId));
    expect(data.status).toBe('locked');
    expect(data.code).toBe('CIRCUIT_OPEN');
    expect(data.failure?.reason).toBe('mfa_session_locked');
    expect('attemptsUsed' in data.failure!).toBe(false);

    await expectFrozen('wrong code after lock', parked.actionId, sessionId, before);
  });
});

/* ==================================== 3. cancel / recover are refused by the app-layer guard */

describe('cancel and recover on a locked action', () => {
  it('[integration] both decision routes refuse with 200/ok:false, events:[] and write nothing at all', async () => {
    const sessionId = await demoSessionId();
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, sessionId);

    const lockedRow = await pendingActionRow(parked.actionId);
    expect(lockedRow?.status, 'precondition: the row is locked').toBe('locked');
    const lockedUpdatedAt = lockedRow!.updatedAt.getTime();
    const before = await sideEffects(parked.actionId, sessionId);

    for (const [verb, handler] of [
      ['cancel', cancelPost],
      ['recover', recoverPost],
    ] as const) {
      const label = `${verb} on a locked action`;
      const res = await decisionAction(handler, verb, parked.actionId, sessionId);
      const data = refusal(label, res);

      expect(data.actionId, `${label}: actionId`).toBe(parked.actionId);
      expect(data.sessionId, `${label}: sessionId`).toBe(sessionId);
      expect(data.status, `${label}: the terminal status is reported back`).toBe('locked');
      expect(data.code, `${label}: the typed lock signal`).toBe('CIRCUIT_OPEN');
      expect(data.mfaResult, `${label}: no verification is being requested`).toBe('not_required');
      expect(data.tier, `${label}: the parked tier is preserved`).toBe('RED');
      expect(data.requiresMfa, `${label}: a RED action still requires strong verification`).toBe(true);
      expect(data.failure, `${label}: the structured refusal is present`).toBeDefined();
      expect(data.failure?.code, `${label}: failure.code`).toBe('CIRCUIT_OPEN');
      expect(data.failure?.reason, `${label}: failure.reason`).toBe('mfa_session_locked');
      expect(data.failure?.actionId, `${label}: failure.actionId`).toBe(parked.actionId);
      // The guard fabricates NO attempt counters (it is not an MFA attempt).
      expect('attemptsLeft' in data.failure!, `${label}: failure.attemptsLeft must be absent`).toBe(false);
      expect('maxAttempts' in data.failure!, `${label}: failure.maxAttempts must be absent`).toBe(false);
      expect('attemptsLeft' in data, `${label}: top-level attemptsLeft must be absent`).toBe(false);
      expect('maxAttempts' in data, `${label}: top-level maxAttempts must be absent`).toBe(false);
      // No continuation events: nothing happened, so nothing may be narrated.
      expect(data.events, `${label}: no continuation events are emitted`).toEqual([]);
      expect(data.message, `${label}: the fixed, code-free sentence`).toBe(LOCKED_ACTION_MESSAGE);
      expectNoCodeLeak(label, res.data);

      // The row itself is untouched: same terminal status, same last-write instant.
      const after = await pendingActionRow(parked.actionId);
      expect(after?.status, `${label}: the row stays locked`).toBe('locked');
      expect(after?.updatedAt.getTime(), `${label}: the row was not rewritten`).toBe(lockedUpdatedAt);

      // ...and nothing else moved: no audit row, no ledger row, no receipt, no challenge, no cash.
      // (Compared against the pre-request snapshot, not `0`: the seeded world has its own history.)
      await expectFrozen(label, parked.actionId, sessionId, before);
      expect(await auditLogCount(sessionId), `${label}: no audit row was written`).toBe(
        before.sessionAuditRows,
      );
      expect(await transactionsCount(), `${label}: no ledger row was written`).toBe(
        before.ledgerRows,
      );
      expect(
        await getTestPrisma().executionReceipt.count(),
        `${label}: no receipt was created`,
      ).toBe(before.receiptRows);
      expect(await checkingBalance(), `${label}: no cash moved`).toBe(SEEDED_BALANCE);
    }

    // A locked row is never a pending decision, so it is never surfaced for confirmation/verification.
    expect((await surfacedActions(sessionId)).map((action) => action.id)).not.toContain(
      parked.actionId,
    );
  });
});

/* ================================================== 4. the security read model surfaces the lock */

describe('GET /api/security while the owner breaker is open', () => {
  it('[integration] the lock carries the attempt-exhaustion reason and its counters', async () => {
    const sessionId = await demoSessionId();
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, sessionId);

    const data = await securityStatus(sessionId);

    // The raw counter is account-scoped and reports the exact threshold.
    expect(data.circuitBreaker, 'the breaker reports the trip threshold as reached').toEqual({
      failures: MFA_MAX_ATTEMPTS,
      max: MFA_MAX_ATTEMPTS,
      locked: true,
    });

    // The structured lock reason, typed so the page never parses a message.
    expect(data.lock, 'a locked account MUST expose the structured lock reason').toBeDefined();
    expect(data.lock?.code, 'lock.code').toBe('CIRCUIT_OPEN');
    // ⚠️ RED AT HEAD (reported, NOT weakened). The required contract is that the security read model
    // reports WHY the account is frozen — the MFA attempt exhaustion — plus the counters behind it.
    // Production instead returns the FIXED `LOCKED_FAILURE` constant
    // (`app/api/security/route.ts:77`, `{ code:'CIRCUIT_OPEN', reason:'circuit_open' }`, with an
    // explicit doc comment saying it "deliberately carries no attempt counters" because the breaker
    // is ACCOUNT-scoped while the per-action attempts live on that action's own row). Consequence:
    // the three `lock.reason`/`lock.attempts*` expectations below fail against current production
    // while `circuitBreaker`/`lock.code`/`lockedActions` all pass. The fix belongs in that route
    // (project the per-action reason of the caller's `locked` rows), never in this assertion.
    expect(data.lock?.reason, 'lock.reason names the MFA attempt exhaustion').toBe(
      'mfa_attempts_exhausted',
    );
    expect(data.lock?.attemptsUsed, 'lock.attemptsUsed').toBe(MFA_MAX_ATTEMPTS);
    expect(data.lock?.attemptsLeft, 'lock.attemptsLeft').toBe(0);
    expect(data.lock?.maxAttempts, 'lock.maxAttempts').toBe(MFA_MAX_ATTEMPTS);
  });

  it('[integration] lockedActions lists exactly the one locked operation with its tool/tier/MFA facts', async () => {
    const sessionId = await demoSessionId();
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, sessionId);

    const row = await pendingActionRow(parked.actionId);
    expect(row?.status, 'precondition: the row is locked').toBe('locked');

    const data = await securityStatus(sessionId);
    expect(data.lockedActions, 'exactly the one terminal action is listed').toHaveLength(1);
    const summary = data.lockedActions[0]!;
    expect(summary.actionId).toBe(parked.actionId);
    expect(summary.toolName, 'the fact carries the tool that was parked').toBe('transfer_money');
    expect(summary.tier, 'the fact carries the parked tier').toBe('RED');
    expect(summary.requiresMfa, 'the fact carries the strong-verification flag').toBe(true);
    expect(summary.updatedAt, 'the fact carries the (approximate) lock instant').toBe(
      row!.updatedAt.getTime(),
    );
  });

  it('[integration] an unlocked account exposes NO lock and NO locked actions', async () => {
    const sessionId = await demoSessionId();
    // A parked RED action that never consumed a wrong code must not look locked.
    const parked = await parkRedTransferPlan();

    const fresh = await securityStatus(sessionId);
    expect(fresh.circuitBreaker).toEqual({ failures: 0, max: MFA_MAX_ATTEMPTS, locked: false });
    expect('lock' in fresh, 'the lock key is ABSENT (not null) while unlocked').toBe(false);
    expect(fresh.lockedActions, 'nothing is locked yet').toEqual([]);
    expect((await pendingActionRow(parked.actionId))?.status).toBe('awaiting_mfa');
  });

  it('[integration] an attempt BELOW the limit is not a lock (two failures, no lock entry)', async () => {
    const sessionId = await demoSessionId();
    const parked = await parkRedTransferPlan();

    const first = await submitMfaCode(parked.actionId, sessionId, WRONG_MFA_CODE);
    expect(first.status, 'attempt #1 is non-terminal').toBe('awaiting_mfa');
    const second = await submitMfaCode(parked.actionId, sessionId, WRONG_MFA_CODE);
    expect(second.status, 'attempt #2 is still non-terminal').toBe('awaiting_mfa');

    const data = await securityStatus(sessionId);
    expect(data.circuitBreaker, 'the breaker counted the two failures without tripping').toEqual({
      failures: MFA_MAX_ATTEMPTS - 1,
      max: MFA_MAX_ATTEMPTS,
      locked: false,
    });
    expect('lock' in data, 'a below-threshold account exposes no lock reason').toBe(false);
    expect(data.lockedActions, 'a non-terminal action is never a locked fact').toEqual([]);
    expect((await pendingActionRow(parked.actionId))?.status).toBe('awaiting_mfa');
    expect((await surfacedActions(sessionId)).map((action) => action.id)).toContain(parked.actionId);
  });
});

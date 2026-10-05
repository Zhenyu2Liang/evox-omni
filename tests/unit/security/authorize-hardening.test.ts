/**
 * Unit: security/security-gateway — CONFIRMATION-AUTHORIZATION HARDENING.
 *
 * Targets the hardened `securityGateway.authorizeAction` / `.cancelAction` (+ the new
 * `.recordActionResult`) on the `@/security` chokepoint. Proves the exactly-once claim, the
 * ownership check, and the execution-time transfer re-risk, i.e. the four defects:
 *   1. a repeat confirm no longer re-authorizes (duplicate money movement) → `CONFLICT`;
 *   2. cancel/confirm after the action has settled → `CONFLICT` (atomic claim, not a status peek);
 *   3. a confirm/cancel with a mismatching userId/sessionId → `AppError('SECURITY_DENIED')`;
 *   4. a YELLOW-parked transfer whose FRESH day total now exceeds ¥1000 escalates to MFA at
 *      EXECUTION time (anti stale-parked-transfer bypass) yet is still COMPLETABLE with the code;
 *   5. `recordActionResult` persists the TRUE terminal status so a later confirm is `CONFLICT`;
 *   6. a locked session still refuses a confirm (`status: 'locked'`).
 *
 * DB-backed (persists PendingAction rows + reads the transaction repository) → needs the test
 * SQLite. Breaker state is in-process keyed by sessionId → UNIQUE sessionId per test.
 *
 * NOTE (intended home): `tests/unit/security/` — this spec lives under `security/_tests/` only
 * because the node-local `security/_vitest.local.config.ts` includes it and the root
 * `vitest.config.ts` discovers only `tests/**`.
 */
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';
import { MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';
import type { PendingAction } from '@/lib/contracts/security';
import { recordFailure } from '@/security/circuit-breaker';
import { securityGateway, type GatewayContext } from '@/security/security-gateway';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { newSessionId } from '@/tests/helpers/scenario';

// The per-test DB reset + seed (`useFreshDatabase`) is I/O heavy and can exceed the default hook
// timeout; give it more room (assertions/determinism untouched).
vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** The seeded 活期 checking account the demo transactions hang off (`acct_checking`). */
const CHECKING_ACCOUNT_ID = ACCOUNTS[0].id;
/** A time inside the demo day (2026-09-25) — counts as "today's" outgoing transfer. */
const DEMO_DAY_MORNING = new Date(2026, 8, 25, 8, 0);

/** A proposed tool-call context; `sessionId` defaults to a fresh id so breaker state never leaks. */
function ctxFor(
  toolName: GatewayContext['toolName'],
  args: Record<string, unknown>,
  sessionId: string = newSessionId(),
): GatewayContext {
  return { sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: '演示请求' };
}

/** Park a YELLOW `transfer_money` action (status `pending`) for the given session. */
async function parkYellowTransfer(sessionId: string, amount: number): Promise<PendingAction> {
  const ctx = ctxFor('transfer_money', { amount, toName: '张伟' }, sessionId);
  return securityGateway.createPendingAction(ctx, await securityGateway.evaluate(ctx));
}

/** The persisted status of a PendingAction row. */
async function statusOf(actionId: string): Promise<string | undefined> {
  const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
  return row?.status;
}

/**
 * Insert a raw outgoing TRANSFER debit (NEGATIVE amount) into the demo user's checking account —
 * only TRANSFER/DEBIT rows are counted by `computeDailyTransferTotal` / the re-risk check.
 */
async function insertOutgoingTransfer(amount: number, occurredAt: Date): Promise<void> {
  await getTestPrisma().transaction.create({
    data: {
      accountId: CHECKING_ACCOUNT_ID,
      userId: DEMO_USER_ID,
      amount, // negative = DEBIT (outflow)
      currency: 'CNY',
      direction: 'DEBIT',
      category: '转账',
      merchant: '转账给张伟',
      channel: 'TRANSFER',
      occurredAt,
    },
  });
}

/** Assert a promise rejects with an `AppError` carrying `code`, and return that AppError. */
async function expectAppError(
  promise: Promise<unknown>,
  code: AppError['code'],
): Promise<AppError> {
  const thrown = await promise.catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe(code);
  return thrown as AppError;
}

describe('authorizeAction · exactly-once claim (no duplicate re-authorization)', () => {
  it('a repeat confirm on an already-confirmed action throws CONFLICT and does NOT re-authorize', async () => {
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 200);
    expect(await statusOf(action.id)).toBe('pending');

    const first = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId });
    expect(first.ok).toBe(true);
    expect(first.status).toBe('confirmed');
    expect(await statusOf(action.id)).toBe('confirmed');

    // Second confirm must be rejected — otherwise the caller would re-execute money movement.
    await expectAppError(securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId }), 'CONFLICT');
    expect(await statusOf(action.id)).toBe('confirmed');
  });

  it('an unknown action id surfaces NOT_FOUND', async () => {
    await expectAppError(securityGateway.authorizeAction('pa_missing', { userId: DEMO_USER_ID, sessionId: newSessionId() }), 'NOT_FOUND');
    await expectAppError(securityGateway.cancelAction('pa_missing', { userId: DEMO_USER_ID, sessionId: newSessionId() }), 'NOT_FOUND');
  });
});

describe('authorizeAction / cancelAction · settling transitions reject the other path', () => {
  it('confirm-after-cancel throws CONFLICT', async () => {
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 200);
    const cancelled = await securityGateway.cancelAction(action.id, { userId: DEMO_USER_ID, sessionId });
    expect(cancelled.status).toBe('cancelled');

    await expectAppError(securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId }), 'CONFLICT');
    expect(await statusOf(action.id)).toBe('cancelled');
  });

  it('cancel-after-confirm throws CONFLICT', async () => {
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 200);
    await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId });
    expect(await statusOf(action.id)).toBe('confirmed');

    await expectAppError(securityGateway.cancelAction(action.id, { userId: DEMO_USER_ID, sessionId }), 'CONFLICT');
    expect(await statusOf(action.id)).toBe('confirmed');
  });
});

describe('authorizeAction / cancelAction · ownership (userId / sessionId)', () => {
  it('a mismatching userId is rejected with SECURITY_DENIED (confirm + cancel) and the row is untouched', async () => {
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 200);

    await expectAppError(
      securityGateway.authorizeAction(action.id, { userId: 'user_someone_else', sessionId }),
      'SECURITY_DENIED',
    );
    await expectAppError(
      securityGateway.cancelAction(action.id, { userId: 'user_someone_else', sessionId }),
      'SECURITY_DENIED',
    );
    expect(await statusOf(action.id)).toBe('pending');
  });

  it('a mismatching sessionId is rejected with SECURITY_DENIED', async () => {
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 200);

    await expectAppError(
      securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId: newSessionId() }),
      'SECURITY_DENIED',
    );
    await expectAppError(
      securityGateway.cancelAction(action.id, { userId: DEMO_USER_ID, sessionId: newSessionId() }),
      'SECURITY_DENIED',
    );
    expect(await statusOf(action.id)).toBe('pending');
  });

  it('the matching userId/sessionId is accepted', async () => {
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 200);

    const res = await securityGateway.authorizeAction(action.id, {
      userId: DEMO_USER_ID,
      sessionId,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('confirmed');
  });
});

describe('authorizeAction · execution-time transfer re-risk (anti bypass)', () => {
  it('a YELLOW-parked ¥600 transfer escalates to MFA when the FRESH daily total exceeds ¥1000, then completes WITH the code', async () => {
    const sessionId = newSessionId();
    // Parked at ¥600 with no prior transfers → YELLOW (confirmation only).
    const action = await parkYellowTransfer(sessionId, 600);
    expect(action.tier).toBe('YELLOW');
    expect(action.requiresMfa).toBe(false);

    // Another ¥600 transfer lands earlier today, so the FRESH total is ¥600 → ¥600 + ¥600 = ¥1200 > ¥1000.
    await insertOutgoingTransfer(-600, DEMO_DAY_MORNING);

    // Confirmation ALONE must now be refused: the transfer escalated to RED at execution time.
    const escalated = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId });
    expect(escalated.ok).toBe(false);
    expect(escalated.status).toBe('awaiting_mfa');
    expect(escalated.requiresMfa).toBe(true);
    expect(escalated.message).not.toContain(MFA_CODE); // never leaks the code
    expect(await statusOf(action.id)).toBe('awaiting_mfa'); // NOT confirmed — escalated at execution time

    // ...and it must be COMPLETABLE with strong verification (not a dead-end loop).
    const verified = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId, mfaCode: MFA_CODE });
    expect(verified.ok).toBe(true);
    expect(verified.status).toBe('confirmed');
    expect(verified.mfaResult).toBe('success');
    expect(await statusOf(action.id)).toBe('confirmed');
  });

  it('a YELLOW-parked transfer that stays under the FRESH limit confirms with no code', async () => {
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 600);

    // A prior ¥300 → ¥600 + ¥300 = ¥900 ≤ ¥1000 → still YELLOW.
    await insertOutgoingTransfer(-300, DEMO_DAY_MORNING);

    const res = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('confirmed');
    expect(res.mfaResult).toBe('not_required');
  });
});

describe('recordActionResult · true terminal status', () => {
  it("persists 'executed' and 'failed', and a confirm after 'executed' is CONFLICT", async () => {
    const sessionId = newSessionId();
    const executed = await parkYellowTransfer(sessionId, 200);
    await securityGateway.recordActionResult(executed.id, 'executed');
    expect(await statusOf(executed.id)).toBe('executed');

    // The action was really executed → a later confirm must be rejected (no double movement).
    await expectAppError(securityGateway.authorizeAction(executed.id, { userId: DEMO_USER_ID, sessionId }), 'CONFLICT');
    expect(await statusOf(executed.id)).toBe('executed');

    const failed = await parkYellowTransfer(sessionId, 200);
    await securityGateway.recordActionResult(failed.id, 'failed');
    expect(await statusOf(failed.id)).toBe('failed');
  });

  it("is exposed on the securityGateway object (facade-visible) and does not throw for a failure status", async () => {
    expect(typeof securityGateway.recordActionResult).toBe('function');
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 200);
    await expect(securityGateway.recordActionResult(action.id, 'failed')).resolves.toBeUndefined();
  });
});

describe('authorizeAction · circuit breaker stays the first hard gate', () => {
  it("a locked session refuses a confirm with status 'locked' (row unchanged)", async () => {
    const sessionId = newSessionId();
    const action = await parkYellowTransfer(sessionId, 200);

    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
      await recordFailure(sessionId);
    }

    const res = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId, mfaCode: MFA_CODE });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('locked');
    expect(res.mfaResult).toBeUndefined();
    expect(await statusOf(action.id)).toBe('pending');
  });
});

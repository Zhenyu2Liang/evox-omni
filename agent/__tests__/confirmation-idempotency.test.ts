/**
 * confirmation-idempotency.test.ts — the TWO-PHASE confirmation flow's idempotency + ownership
 * invariants, exercised against the REAL security gateway, Banking SDK and test SQLite.
 *
 * SECURITY BOUNDARY under test:
 *   - money moves ONLY through a human decision that the gateway authorizes, and ONLY ONCE:
 *     a repeat confirm (or a confirm after cancel) is a typed `ok:false` (CONFLICT), never a
 *     second execution;
 *   - a confirm/cancel carrying a FOREIGN `userId`/`sessionId` propagates `SECURITY_DENIED`
 *     (never executed, never silently downgraded to a success).
 *
 * Offline + deterministic: only the model is the `LLM_MODE=mock` faux provider; the agent facade,
 * gateway, SDK and DB are the production ones. A UNIQUE persisted session per test keeps the
 * in-process circuit breaker (keyed by sessionId, no global reset) isolated.
 *
 * Run with: `npx vitest run --config agent/vitest.config.ts`
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { cancelAction, confirmAction, getOrCreateSession } from '@/agent';
import { security } from '@/security';
import { CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

/** The gateway's ONLY runtime member; the agent node captures this same object. */
const gateway = security.gateway.securityGateway;

/** Recipient 张伟 — resolves unambiguously to the seeded contact. */
const RECIPIENT = CONTACTS[0];
/** ≤ ¥1000 ⇒ YELLOW (confirmation-only). */
const YELLOW_AMOUNT = 200;
const FUNDING_ACCOUNT_ID = 'acct_checking';
/** Seeded 活期 balance (`tests/helpers/fixtures.ACCOUNTS`). */
const STARTING_BALANCE = 23580;
const USER_MESSAGE = '给张伟转200元，备注AA';

/* ---------------------------------------------------------------------------------- helpers */

/** Create + persist a fresh AgentSession for the demo user and return its id. */
async function newPersistedSessionId(): Promise<string> {
  const snapshot = await getOrCreateSession(DEMO_USER_ID);
  return snapshot.sessionId;
}

/**
 * Propose a `transfer_money` call through the REAL gateway, assert it was BLOCKED (gated) and a
 * `PendingAction` was persisted, then return that action's id.
 */
async function parkTransfer(sessionId: string): Promise<string> {
  const auth = await gateway.handleToolCall({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { name: RECIPIENT.name, amount: YELLOW_AMOUNT },
    userRequest: USER_MESSAGE,
  });
  expect(auth.evaluation.blocked).toBe(true);
  expect(auth.action).toBeDefined();
  return auth.action!.id;
}

/** The funding account's current balance (the money-movement proof). */
async function balanceOf(accountId: string = FUNDING_ACCOUNT_ID): Promise<number> {
  const row = await getTestPrisma().account.findUnique({ where: { id: accountId } });
  return row!.balance;
}

/** The persisted status of a `PendingAction`. */
async function actionStatus(actionId: string): Promise<string> {
  const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
  return row!.status;
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ tests */

describe('confirmation idempotency', () => {
  it('a repeated confirm executes exactly once; the second is a typed ok:false', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId);

    const first = await confirmAction(actionId);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('executed');
    expect(first.actionId).toBe(actionId);
    // Money moved exactly once.
    expect(await balanceOf()).toBe(STARTING_BALANCE - YELLOW_AMOUNT);
    expect(await actionStatus(actionId)).toBe('executed');

    const second = await confirmAction(actionId);
    // An already-settled action is a DOMAIN outcome, never a fabricated success.
    expect(second.ok).toBe(false);
    expect(second.actionId).toBe(actionId);
    expect(second.status).toBe('executed');
    expect(typeof second.message).toBe('string');
    expect(second.message.length).toBeGreaterThan(0);
    // Still debited exactly once.
    expect(await balanceOf()).toBe(STARTING_BALANCE - YELLOW_AMOUNT);

    // Only the successful execution wrote an audit row (the CONFLICT wrote none).
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe('success');
  });

  it('confirm after cancel does NOT execute and is a typed ok:false', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId);

    const cancelled = await cancelAction(actionId);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.status).toBe('cancelled');
    expect(await actionStatus(actionId)).toBe('cancelled');
    expect(await balanceOf()).toBe(STARTING_BALANCE);

    const late = await confirmAction(actionId);
    expect(late.ok).toBe(false);
    expect(late.status).toBe('cancelled');
    expect(await balanceOf()).toBe(STARTING_BALANCE);
    expect(await actionStatus(actionId)).toBe('cancelled');
  });
});

describe('confirmation ownership', () => {
  it('a foreign userId is rejected with SECURITY_DENIED and nothing executes', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId);

    await expect(confirmAction(actionId, { userId: 'user_intruder' })).rejects.toMatchObject({
      code: 'SECURITY_DENIED',
    });
    await expect(cancelAction(actionId, { userId: 'user_intruder' })).rejects.toMatchObject({
      code: 'SECURITY_DENIED',
    });

    expect(await balanceOf()).toBe(STARTING_BALANCE);
    expect(await actionStatus(actionId)).toBe('pending');
  });

  it('a foreign sessionId is rejected with SECURITY_DENIED and nothing executes', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId);

    await expect(confirmAction(actionId, { sessionId: 'sess_intruder' })).rejects.toMatchObject({
      code: 'SECURITY_DENIED',
    });
    await expect(cancelAction(actionId, { sessionId: 'sess_intruder' })).rejects.toMatchObject({
      code: 'SECURITY_DENIED',
    });

    expect(await balanceOf()).toBe(STARTING_BALANCE);
    expect(await actionStatus(actionId)).toBe('pending');
  });
});

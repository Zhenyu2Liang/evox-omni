/**
 * Unit: security/security-gateway — AUTHORIZATION CONCURRENCY & EXECUTION-TIME RE-RISK.
 *
 * Two invariants the gateway must hold under concurrency / delayed execution. Both are driven
 * end-to-end through the REAL `@/agent` confirm/verify façade, which authorizes via
 * `security.gateway.securityGateway.authorizeAction`, then executes the ORIGINAL validated args
 * through the Banking SDK and records the TRUE terminal status — i.e. the production money path,
 * not a mock.
 *
 *   1. CONCURRENT CONFIRM — two SIMULTANEOUS confirms of ONE pending YELLOW action. The gateway's
 *      atomic exactly-once claim lets EXACTLY ONE authorize + execute (`status: 'executed'`); the
 *      other is a typed `ok:false` (a `CONFLICT`), never a second execution. Money moves EXACTLY
 *      ONCE and only the winner is audited. A further SEQUENTIAL confirm is likewise a typed
 *      `ok:false`.
 *   2. TWO QUEUED TRANSFERS ESCALATE AT EXECUTION TIME — two YELLOW transfers are parked while the
 *      day's transfer total is still ¥0 (each individually ≤ ¥1000 ⇒ confirmation-only, no MFA) —
 *      the STALE pre-authorization scenario. Once the FIRST executes (¥600), the SECOND is re-risked
 *      against the FRESH day total at confirm time (¥600 + ¥600 = ¥1200 > ¥1000) ⇒ it escalates to
 *      RED, does NOT execute, and returns `awaiting_mfa`: a stale pre-authorization can never bypass
 *      MFA. It stays completable with the code (not a dead-end).
 *
 * DB-backed (real PendingAction / Transaction / AuditLog rows) → test SQLite via `../../helpers/db`.
 * Each test uses a UNIQUE persisted session (`getOrCreateSession`) so the in-process circuit breaker
 * (keyed by sessionId, no global reset) never leaks across tests. Only the model is the
 * `LLM_MODE=mock` faux provider; the agent facade, gateway, SDK and DB are the production ones.
 */
import { describe, expect, it, vi } from 'vitest';

import { confirmAction, getOrCreateSession, verifyAction } from '@/agent';
import { AppError } from '@/lib/errors';
import { MFA_CODE } from '@/lib/constants';
import { security } from '@/security';
import { CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';

/** The gateway's ONLY runtime member (the object `@/agent` also captures). */
const gateway = security.gateway.securityGateway;

// The per-test DB reset + seed (`useFreshDatabase` → truncateAll + seedDemoData) is I/O heavy and
// can exceed Vitest's default hook timeout. Give it more room (nothing faked/skipped).
vi.setConfig({ hookTimeout: 60_000 });
useFreshDatabase();

/* ---------------------------------------------------------------------------------- fixtures */

/** 张伟 — resolves unambiguously to the seeded contact. */
const ZHANGWEI = CONTACTS[0];
/** 王芳 — the second (queued) transfer recipient. */
const WANGFANG = CONTACTS[1];
const FUNDING_ACCOUNT_ID = 'acct_checking';
/** Seeded 活期 balance (`tests/helpers/fixtures.ACCOUNTS`). */
const STARTING_BALANCE = 23580;
/** Each queued transfer is ≤ ¥1000 (YELLOW alone); together ¥1200 > the ¥1000 daily limit. */
const HALF_LIMIT = 600;

/* ----------------------------------------------------------------------------------- helpers */

/** Create + persist a fresh AgentSession for the demo user (unique sessionId ⇒ breaker isolation). */
async function newPersistedSessionId(): Promise<string> {
  return (await getOrCreateSession(DEMO_USER_ID)).sessionId;
}

/** Propose a `transfer_money` call through the REAL gateway, assert it was GATED, return the id. */
async function parkTransfer(
  sessionId: string,
  recipientName: string,
  amount: number,
): Promise<string> {
  const auth = await gateway.handleToolCall({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { name: recipientName, amount },
    userRequest: `给${recipientName}转${amount}元`,
  });
  expect(auth.evaluation.blocked).toBe(true);
  expect(auth.action).toBeDefined();
  return auth.action!.id;
}

/** The funding account's current balance (the money-movement proof). */
async function balanceOf(): Promise<number> {
  const row = await getTestPrisma().account.findUnique({ where: { id: FUNDING_ACCOUNT_ID } });
  return row!.balance;
}

/** The persisted status of a `PendingAction` row. */
async function actionStatus(actionId: string): Promise<string> {
  const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
  return row!.status;
}

/** The number of EXECUTED transfer ledger rows for a recipient (merchant `转账给<name>`). */
async function transferLedgerCount(recipientName: string): Promise<number> {
  return getTestPrisma().transaction.count({
    where: { channel: 'TRANSFER', merchant: `转账给${recipientName}` },
  });
}

/* --------------------------------------------------------------------- 1. concurrent confirm */

type ConfirmOutcome = Awaited<ReturnType<typeof confirmAction>>;

const isWinner = (r: PromiseSettledResult<ConfirmOutcome>): r is PromiseFulfilledResult<ConfirmOutcome> =>
  r.status === 'fulfilled' && r.value.ok;

describe('authorizeAction · concurrent confirm (exactly-once execution)', () => {
  it('two SIMULTANEOUS confirms of one YELLOW action: exactly one executes; balance moves once', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId, ZHANGWEI.name, 200);
    expect(await actionStatus(actionId)).toBe('pending');
    expect(await balanceOf()).toBe(STARTING_BALANCE);

    // Both confirms race for the SAME action. Only one can win the atomic `pending → confirmed` claim.
    const settled = await Promise.allSettled([confirmAction(actionId), confirmAction(actionId)]);

    const winners = settled.filter(isWinner);
    // Widen explicitly: the negated type predicate would otherwise narrow this to `PromiseRejectedResult[]`
    // and make the `status === 'fulfilled'` branch below untypeable (the loser MAY be a typed `ok:false`).
    const others: PromiseSettledResult<ConfirmOutcome>[] = settled.filter((r) => !isWinner(r));

    expect(winners).toHaveLength(1);
    expect(winners[0]!.value.status).toBe('executed');
    expect(winners[0]!.value.actionId).toBe(actionId);

    // The loser is a TYPED, non-executing outcome: an `ok:false` CONFLICT (or a thrown AppError).
    expect(others).toHaveLength(1);
    const loser = others[0]!;
    if (loser.status === 'fulfilled') {
      expect(loser.value.ok).toBe(false);
      expect(loser.value.actionId).toBe(actionId);
      expect(typeof loser.value.message).toBe('string');
      expect(loser.value.message.length).toBeGreaterThan(0);
    } else {
      expect(loser.reason).toBeInstanceOf(AppError);
      expect((loser.reason as AppError).code).toBe('CONFLICT');
    }

    // Money moved EXACTLY once — no double debit, one ledger row.
    expect(await balanceOf()).toBe(STARTING_BALANCE - 200);
    expect(await actionStatus(actionId)).toBe('executed');
    expect(await transferLedgerCount(ZHANGWEI.name)).toBe(1);

    // Only the winning execution is audited (the CONFLICT wrote nothing).
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe('success');

    // A further SEQUENTIAL confirm is likewise a typed `ok:false` — never a second execution.
    const third = await confirmAction(actionId);
    expect(third.ok).toBe(false);
    expect(third.actionId).toBe(actionId);
    expect(await balanceOf()).toBe(STARTING_BALANCE - 200);
    expect(await transferLedgerCount(ZHANGWEI.name)).toBe(1);
  });
});

/* ------------------------------------------- 2. two queued transfers escalate at execution time */

describe('authorizeAction · two queued YELLOW transfers escalate at execution time', () => {
  it('the SECOND queued ¥600 transfer parks for MFA once the FIRST executed (stale pre-auth cannot bypass MFA)', async () => {
    const sessionId = await newPersistedSessionId();

    // Park BOTH while today's transfer total is still ¥0 ⇒ each sees the STALE total and is YELLOW
    // (confirmation only, no MFA) — precisely the stale-pre-authorization scenario.
    const first = await parkTransfer(sessionId, ZHANGWEI.name, HALF_LIMIT);
    const second = await parkTransfer(sessionId, WANGFANG.name, HALF_LIMIT);

    for (const actionId of [first, second]) {
      const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
      expect(row!.status).toBe('pending');
      expect(row!.riskLevel).toBe('YELLOW');
      expect(row!.requiresMfa).toBe(false);
    }

    // The FIRST confirmation executes (¥600 ≪ ¥1000) — money moves once.
    const firstConfirm = await confirmAction(first);
    expect(firstConfirm.ok).toBe(true);
    expect(firstConfirm.status).toBe('executed');
    expect(await actionStatus(first)).toBe('executed');
    expect(await balanceOf()).toBe(STARTING_BALANCE - HALF_LIMIT);

    // The SECOND confirmation RE-RISKS against the FRESH day total (¥600 + ¥600 = ¥1200 > ¥1000):
    // it must NOT execute and must come back `awaiting_mfa`.
    const secondConfirm = await confirmAction(second);
    expect(secondConfirm.ok).toBe(false);
    expect(secondConfirm.status).toBe('awaiting_mfa');
    expect(secondConfirm.actionId).toBe(second);
    expect(typeof secondConfirm.message).toBe('string');
    expect(secondConfirm.message).not.toContain(MFA_CODE); // never leaks the code

    // NOT executed: balance unchanged, action still unsettled, no ledger row for 王芳.
    expect(await balanceOf()).toBe(STARTING_BALANCE - HALF_LIMIT);
    expect(await actionStatus(second)).toBe('pending');
    expect(await transferLedgerCount(WANGFANG.name)).toBe(0);

    // ...and it is COMPLETABLE with strong verification (not a dead-end loop).
    const verified = await verifyAction(second, MFA_CODE);
    expect(verified.ok).toBe(true);
    expect(verified.status).toBe('executed');
    expect(await actionStatus(second)).toBe('executed');
    expect(await balanceOf()).toBe(STARTING_BALANCE - HALF_LIMIT * 2);
    expect(await transferLedgerCount(WANGFANG.name)).toBe(1);
  });
});

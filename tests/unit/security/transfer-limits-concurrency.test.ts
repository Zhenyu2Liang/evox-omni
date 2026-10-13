/**
 * Unit: security — DYNAMIC TRANSFER-LIMIT + CONCURRENCY INVARIANTS (regression).
 *
 * Pins the money-safety invariants that depend on the transfer risk rule
 * (`security/risk-engine.evaluateTransferRisk`: RED iff `amount > ¥1000` OR
 * `projectedDailyTotal > ¥1000`) interacting with the gateway's execution-time re-risk
 * (`security/security-gateway.authorizeTransfer`) and the Banking SDK's atomic debit
 * (`banking-sdk/transfer.createTransfer`).
 *
 * Everything here is driven through the REAL production path — NO mocks: the `@/agent`
 * `confirmAction`/`verifyAction` façade and/or the raw `securityGateway`, the real Banking SDK and
 * the test SQLite. Only the model is the `LLM_MODE=mock` faux provider. `DEMO_NOW` (2026-09-25
 * 12:00) fixes "today" so the day-transfer window is deterministic (the seeded ¥500 转账给妈妈 row
 * is dated 2026-09-04, i.e. OUTSIDE today ⇒ the day total starts at ¥0).
 *
 * Invariants under test:
 *   1. Concurrent/queued confirmations can never let the day's EXECUTED transfer total exceed the
 *      ¥1000 confirmation-only limit: the first parked transfer executes, every later one re-risks
 *      against the FRESH effective total (executed + in-flight) and escalates to RED/`awaiting_mfa`
 *      (still completable with the code) — never a second execution.
 *   2. The day total is USER-scoped, not session-scoped: a ¥600 parked in a different session still
 *      pushes the next confirm over the limit.
 *   3. The boundary is a STRICT `>`: exactly ¥1000 confirms without a code; ¥1001 is RED and a
 *      code-free `authorizeAction` stays `awaiting_mfa` and executes nothing.
 *   4. Repeat/concurrent confirms of ONE action are a typed `CONFLICT` (or `ok:false`): money moves
 *      exactly once and only the winner is audited.
 *   5. Success ⇒ exactly one debit + one ledger row; refusal ⇒ no partial write. Under a lowered
 *      balance the SDK's `INSUFFICIENT_FUNDS` refusal (`banking-sdk/transfer.ts`) is surfaced, never
 *      swallowed: the balance never goes negative and executions equal successful debits.
 *
 * DB-backed (real PendingAction / Transaction / AuditLog rows) → test SQLite via `../../helpers/db`.
 * The in-process circuit breaker is keyed by `sessionId` and has NO global reset, so every test uses
 * a UNIQUE session (`getOrCreateSession` for `@/agent`-driven cases, `newSessionId()` for
 * gateway-only cases).
 */
import { describe, expect, it, vi } from 'vitest';

import { confirmAction, getOrCreateSession, verifyAction } from '@/agent';
import { AppError } from '@/lib/errors';
import { DAILY_TRANSFER_LIMIT, MFA_CODE } from '@/lib/constants';
import { addMoney, moneyToCents, type MoneyInput } from '@/lib/money';
import { security } from '@/security';
import { CONTACTS, DEMO_USER_ID } from '../../helpers/fixtures';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { newSessionId } from '../../helpers/scenario';

/** The gateway's ONLY runtime member (the object `@/agent` also captures). */
const gateway = security.gateway.securityGateway;

// The per-test DB reset + seed (`useFreshDatabase` → truncateAll + seedDemoData) is I/O heavy and
// can exceed Vitest's default hook timeout. Give it more room (nothing faked/skipped).
vi.setConfig({ hookTimeout: 60_000 });
useFreshDatabase();

/* ---------------------------------------------------------------------------------- fixtures */

/** 张伟 — resolves unambiguously to the seeded contact. */
const ZHANGWEI = CONTACTS[0];
/** 王芳 — second transfer recipient. */
const WANGFANG = CONTACTS[1];
/** 李华 — third transfer recipient. */
const LIHUA = CONTACTS[3];
/** The seeded checking (活期) account every transfer debits. */
const FUNDING_ACCOUNT_ID = 'acct_checking';
/** Seeded 活期 balance (`tests/helpers/fixtures.ACCOUNTS`). */
const STARTING_BALANCE = 2_358_000n;
/** ¥600 ≤ ¥1000 alone (YELLOW); a second one makes the day total ¥1200 > the ¥1000 limit. */
const HALF_LIMIT = '600.00';
/** Balance we temporarily lower to so the SDK must refuse (¥500 < ¥600). */
const UNDER_FUNDED_BALANCE = 50_000n;

type ConfirmOutcome = Awaited<ReturnType<typeof confirmAction>>;

/* ----------------------------------------------------------------------------------- helpers */

/** Create + persist a fresh AgentSession for the demo user (unique sessionId ⇒ breaker isolation). */
async function newPersistedSessionId(): Promise<string> {
  return (await getOrCreateSession(DEMO_USER_ID)).sessionId;
}

/** Propose a `transfer_money` call through the REAL gateway, assert it was GATED, return the id. */
async function parkTransfer(
  sessionId: string,
  recipientName: string,
  amount: MoneyInput,
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
async function balanceOf(): Promise<bigint> {
  const row = await getTestPrisma().account.findUnique({ where: { id: FUNDING_ACCOUNT_ID } });
  return row!.balanceMinor;
}

/** The persisted status of a `PendingAction` row. */
async function actionStatus(actionId: string): Promise<string> {
  const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
  return row!.status;
}

/** The persisted risk level of a `PendingAction` row. */
async function actionRiskLevel(actionId: string): Promise<string> {
  const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
  return row!.riskLevel;
}

/** Seeded/parked transfer-risk invariants for a freshly parked `transfer_money` (`pending`/YELLOW). */
async function expectParkedYellowNoMfa(actionId: string): Promise<void> {
  const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
  expect(row!.status).toBe('pending');
  expect(row!.riskLevel).toBe('YELLOW');
  expect(row!.requiresMfa).toBe(false);
}

/** The number of EXECUTED transfer ledger rows for a recipient (merchant `转账给<name>`). */
async function transferLedgerCount(recipientName: string): Promise<number> {
  return getTestPrisma().transaction.count({
    where: { channel: 'TRANSFER', merchant: `转账给${recipientName}` },
  });
}

/** Sum of the transfer ledger rows across several recipients. */
async function ledgerTotal(recipientNames: readonly string[]): Promise<number> {
  let total = 0;
  for (const name of recipientNames) total += await transferLedgerCount(name);
  return total;
}

/** The user-scoped EXECUTED day-transfer total (the public risk-engine helper). */
async function dailyTotal(): Promise<bigint> {
  return moneyToCents(await security.risk.computeDailyTransferTotal(DEMO_USER_ID));
}

function isFulfilled(
  r: PromiseSettledResult<ConfirmOutcome>,
): r is PromiseFulfilledResult<ConfirmOutcome> {
  return r.status === 'fulfilled';
}

/** Every settled outcome must be a DOMAIN outcome (a confirm never throws for a lost race). */
function domainOutcomes(settled: readonly PromiseSettledResult<ConfirmOutcome>[]): ConfirmOutcome[] {
  for (const r of settled) {
    expect(r.status).toBe('fulfilled');
  }
  return settled.filter(isFulfilled).map((r) => r.value);
}

/* --------------------------------------------- 1. concurrent confirm of two parked ¥600 transfers */

describe('transfer limits · concurrent confirmations hold the ≤ ¥1000 day-total invariant', () => {
  it('two parked ¥600 transfers confirmed concurrently: exactly one executes, the other escalates to RED/awaiting_mfa and still completes via verifyAction', async () => {
    const sessionId = await newPersistedSessionId();

    // Both parked while today's total is ¥0 ⇒ each individually YELLOW (confirmation only, no MFA).
    const first = await parkTransfer(sessionId, ZHANGWEI.name, HALF_LIMIT);
    const second = await parkTransfer(sessionId, WANGFANG.name, HALF_LIMIT);
    await expectParkedYellowNoMfa(first);
    await expectParkedYellowNoMfa(second);
    expect(await balanceOf()).toBe(STARTING_BALANCE);

    // Race both confirmations (distinct actions) through the REAL agent façade.
    const settled = await Promise.allSettled([confirmAction(first), confirmAction(second)]);
    const outcomes = domainOutcomes(settled);

    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);

    // EXACTLY ONE executes.
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe('executed');
    expect(await actionStatus(winners[0]!.actionId)).toBe('executed');

    // The other re-risks against the FRESH effective total (¥600 + ¥600 > ¥1000) and escalates:
    // NOT executed, effective tier RED, strong verification required.
    expect(losers).toHaveLength(1);
    const loser = losers[0]!;
    expect(loser.status).toBe('awaiting_mfa');
    expect(loser.requiresMfa).toBe(true);
    expect(loser.tier).toBe('RED');
    expect(loser.message.length).toBeGreaterThan(0);
    expect(loser.message).not.toContain(MFA_CODE); // never leaks the code

    // THE INVARIANT: the day's EXECUTED transfer total never exceeds the ¥1000 confirmation-only limit.
    expect(await dailyTotal()).toBeLessThanOrEqual(moneyToCents(DAILY_TRANSFER_LIMIT));

    // Money moved EXACTLY ONCE (¥600): one debit, one ledger row for the winner, one audit row.
    const recipientOf = new Map<string, string>([
      [first, ZHANGWEI.name],
      [second, WANGFANG.name],
    ]);
    expect(await balanceOf()).toBe(STARTING_BALANCE - moneyToCents(HALF_LIMIT));
    expect(await transferLedgerCount(recipientOf.get(winners[0]!.actionId)!)).toBe(1);
    expect(await transferLedgerCount(recipientOf.get(loser.actionId)!)).toBe(0);
    expect(await ledgerTotal([ZHANGWEI.name, WANGFANG.name])).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId } })).toBe(1);

    // The loser is parked RED/awaiting_mfa (persisted escalation, nothing executed for it).
    expect(await actionStatus(loser.actionId)).toBe('awaiting_mfa');
    expect(await actionRiskLevel(loser.actionId)).toBe('RED');

    // ...and it is COMPLETABLE with the code (not a dead-end): it executes on strong verification.
    const verified = await verifyAction(loser.actionId, MFA_CODE);
    expect(verified.ok).toBe(true);
    expect(verified.status).toBe('executed');
    expect(await actionStatus(loser.actionId)).toBe('executed');
    expect(await balanceOf()).toBe(STARTING_BALANCE - moneyToCents(HALF_LIMIT) * 2n);
    expect(await transferLedgerCount(recipientOf.get(loser.actionId)!)).toBe(1);
  });
});

/* ------------------------------------------------------ 2. cross-session accumulation (user-scoped) */

describe('transfer limits · the day total is USER-scoped (cross-session accumulation)', () => {
  it('¥600 parked in session A and ¥600 in session B: confirming B after A executes escalates (600 + 600 > 1000)', async () => {
    const sessionA = await newPersistedSessionId();
    const sessionB = await newPersistedSessionId();

    // Both are parked while today's total is still ¥0 (the total is user-scoped, so each sees ¥0).
    const inA = await parkTransfer(sessionA, ZHANGWEI.name, HALF_LIMIT);
    const inB = await parkTransfer(sessionB, WANGFANG.name, HALF_LIMIT);
    await expectParkedYellowNoMfa(inA);
    await expectParkedYellowNoMfa(inB);

    // A executes ⇒ the day total is now ¥600.
    const firstConfirm = await confirmAction(inA);
    expect(firstConfirm.ok).toBe(true);
    expect(firstConfirm.status).toBe('executed');
    expect(await dailyTotal()).toBe(moneyToCents(HALF_LIMIT));
    expect(await balanceOf()).toBe(STARTING_BALANCE - moneyToCents(HALF_LIMIT));

    // B's ¥600 now crosses the limit (¥600 + ¥600 = ¥1200 > ¥1000) despite being in ANOTHER session:
    // it escalates to RED, does NOT execute, and writes no ledger row.
    const secondConfirm = await confirmAction(inB);
    expect(secondConfirm.ok).toBe(false);
    expect(secondConfirm.status).toBe('awaiting_mfa');
    expect(secondConfirm.requiresMfa).toBe(true);
    expect(secondConfirm.tier).toBe('RED');

    expect(await dailyTotal()).toBeLessThanOrEqual(moneyToCents(DAILY_TRANSFER_LIMIT));
    expect(await balanceOf()).toBe(STARTING_BALANCE - moneyToCents(HALF_LIMIT));
    expect(await actionStatus(inB)).toBe('awaiting_mfa');
    expect(await transferLedgerCount(WANGFANG.name)).toBe(0);
  });
});

/* ------------------------------------------------------------------- 3. the exact ¥1000 boundary */

describe('transfer limits · the STRICT ¥1000 boundary', () => {
  it('¥1000 confirms without any code (allowed); ¥1001 is RED and a code-free authorizeAction stays awaiting_mfa and executes nothing', async () => {
    const sessionId = newSessionId();

    // ── exactly ¥1000 (projected total == the limit) ⇒ still YELLOW / confirmation-only.
    const atLimit = await parkTransfer(sessionId, ZHANGWEI.name, DAILY_TRANSFER_LIMIT);
    await expectParkedYellowNoMfa(atLimit);

    const atLimitAuth = await gateway.authorizeAction(atLimit, {
      userId: DEMO_USER_ID,
      sessionId,
    });
    expect(atLimitAuth.ok).toBe(true);
    expect(atLimitAuth.status).toBe('confirmed');
    expect(atLimitAuth.mfaResult).toBe('not_required');
    expect(atLimitAuth.requiresMfa).toBe(false);

    // ── one over (¥1001) ⇒ RED at park time (amount > ¥1000).
    const overLimit = await parkTransfer(sessionId, WANGFANG.name, addMoney(DAILY_TRANSFER_LIMIT, '1.00'));
    expect(await actionRiskLevel(overLimit)).toBe('RED');
    expect(await actionStatus(overLimit)).toBe('awaiting_mfa');

    const balanceBefore = await balanceOf();
    const ledgerBefore = await transferLedgerCount(WANGFANG.name);

    // A code-free authorize of a RED action must NOT execute — it waits for verification.
    const noCode = await gateway.authorizeAction(overLimit, { userId: DEMO_USER_ID, sessionId });
    expect(noCode.ok).toBe(false);
    expect(noCode.status).toBe('awaiting_mfa');
    expect(noCode.requiresMfa).toBe(true);
    expect(noCode.tier).toBe('RED');
    expect(noCode.message.length).toBeGreaterThan(0);

    // NO partial write: nothing moved and no ledger row was written.
    expect(await balanceOf()).toBe(balanceBefore);
    expect(await transferLedgerCount(WANGFANG.name)).toBe(ledgerBefore);
  });
});

/* --------------------------------------------------------- 4. three queued transfers stay ≤ ¥1000 */

describe('transfer limits · three queued ¥600 transfers preserve the ≤ ¥1000 invariant', () => {
  it('at most ONE of three queued ¥600 transfers executes; the rest escalate to awaiting_mfa', async () => {
    const sessionId = await newPersistedSessionId();

    const ids = [
      await parkTransfer(sessionId, ZHANGWEI.name, HALF_LIMIT),
      await parkTransfer(sessionId, WANGFANG.name, HALF_LIMIT),
      await parkTransfer(sessionId, LIHUA.name, HALF_LIMIT),
    ];
    const recipientOf = new Map<string, string>([
      [ids[0]!, ZHANGWEI.name],
      [ids[1]!, WANGFANG.name],
      [ids[2]!, LIHUA.name],
    ]);
    for (const id of ids) await expectParkedYellowNoMfa(id);

    const outcomes = domainOutcomes(
      await Promise.allSettled(ids.map((id) => confirmAction(id))),
    );

    // AT MOST ONE executes — the FIRST to claim sees ¥0 and passes; every later one sees ≥ ¥600.
    const executed = outcomes.filter((o) => o.status === 'executed');
    expect(executed.length).toBeLessThanOrEqual(1);

    for (const outcome of outcomes) {
      if (outcome.status === 'executed') {
        expect(outcome.ok).toBe(true);
        continue;
      }
      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe('awaiting_mfa');
      expect(outcome.requiresMfa).toBe(true);
      expect(outcome.tier).toBe('RED');
    }

    // The day total and the balance both reflect EXACTLY the number of executions (never more).
    expect(await dailyTotal()).toBeLessThanOrEqual(moneyToCents(DAILY_TRANSFER_LIMIT));
    expect(await dailyTotal()).toBe(moneyToCents(HALF_LIMIT) * BigInt(executed.length));
    expect(await ledgerTotal([ZHANGWEI.name, WANGFANG.name, LIHUA.name])).toBe(executed.length);
    expect(await balanceOf()).toBe(STARTING_BALANCE - moneyToCents(HALF_LIMIT) * BigInt(executed.length));
    expect(executed.length).toBeGreaterThanOrEqual(1); // the first claim always passes (¥0 + ¥600)
  });
});

/* ------------------------------------------- 5. repeat / concurrent confirm of ONE action = CONFLICT */

describe('transfer limits · repeat confirm of the SAME action (exactly-once execution)', () => {
  it('confirm then confirm again (sequential) is a typed ok:false and executes exactly once', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId, ZHANGWEI.name, '200.00');

    const first = await confirmAction(actionId);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('executed');
    expect(await balanceOf()).toBe(STARTING_BALANCE - 20_000n);
    expect(await transferLedgerCount(ZHANGWEI.name)).toBe(1);

    // The repeat is a typed DOMAIN outcome (never a thrown error at the façade, never a second run).
    const repeat = await confirmAction(actionId);
    expect(repeat.ok).toBe(false);
    expect(repeat.actionId).toBe(actionId);
    expect(repeat.message.length).toBeGreaterThan(0);

    // Still exactly one execution / debit / ledger row / audit row.
    expect(await balanceOf()).toBe(STARTING_BALANCE - 20_000n);
    expect(await transferLedgerCount(ZHANGWEI.name)).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId } })).toBe(1);
  });

  it('gateway authorizeAction twice → the second throws AppError(CONFLICT); two SIMULTANEOUS confirms of one action execute once', async () => {
    // (a) Direct gateway double-authorize: the second is rejected as CONFLICT.
    const sessionId = newSessionId();
    const gatewayAction = await parkTransfer(sessionId, WANGFANG.name, '200.00');

    const authorized = await gateway.authorizeAction(gatewayAction, {
      userId: DEMO_USER_ID,
      sessionId,
    });
    expect(authorized.ok).toBe(true);
    expect(authorized.status).toBe('confirmed');

    const repeatError = await gateway
      .authorizeAction(gatewayAction, { userId: DEMO_USER_ID, sessionId })
      .catch((e: unknown) => e);
    expect(repeatError).toBeInstanceOf(AppError);
    expect((repeatError as AppError).code).toBe('CONFLICT');

    // (b) Two SIMULTANEOUS confirms of the SAME action → exactly one wins, money moves once.
    const sessionId2 = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId2, LIHUA.name, '300.00');

    const outcomes = domainOutcomes(
      await Promise.allSettled([confirmAction(actionId), confirmAction(actionId)]),
    );
    const executed = outcomes.filter((o) => o.status === 'executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]!.actionId).toBe(actionId);

    // The loser is a typed, non-executing outcome (nothing moved twice).
    for (const outcome of outcomes.filter((o) => o.status !== 'executed')) {
      expect(outcome.ok).toBe(false);
      expect(outcome.actionId).toBe(actionId);
      expect(outcome.message.length).toBeGreaterThan(0);
    }

    expect(await balanceOf()).toBe(STARTING_BALANCE - 30_000n);
    expect(await transferLedgerCount(LIHUA.name)).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: sessionId2 } })).toBe(1);
  });
});

/* -------------------------------------- 6. balance / ledger consistency & no overspend (SDK refusal) */

describe('transfer limits · balance & ledger consistency (no overspend)', () => {
  it('a lowered balance makes the SDK refuse: no overspend, executions equal successful debits', async () => {
    // Temporarily lower the funding balance below a single ¥600 transfer.
    await getTestPrisma().account.update({
      where: { id: FUNDING_ACCOUNT_ID },
      data: { balanceMinor: UNDER_FUNDED_BALANCE },
    });
    expect(await balanceOf()).toBe(UNDER_FUNDED_BALANCE);

    const sessionId = await newPersistedSessionId();
    const ids = [
      await parkTransfer(sessionId, ZHANGWEI.name, HALF_LIMIT),
      await parkTransfer(sessionId, WANGFANG.name, HALF_LIMIT),
    ];
    // Sum ¥1200 > the ¥500 balance; the risk engine still gates them (¥500 < ¥600 per transfer is a
    // FUNDS concern, not a permission one — the gateway classifies by amount/daily total only).
    for (const id of ids) await expectParkedYellowNoMfa(id);

    const outcomes = domainOutcomes(
      await Promise.allSettled(ids.map((id) => confirmAction(id))),
    );

    // NOTHING can execute: ¥600 > the ¥500 balance, and a confirmed one escalates the next.
    const executed = outcomes.filter((o) => o.status === 'executed');
    expect(executed).toHaveLength(0);

    // The honest refusal is surfaced, never swallowed: at least one confirm hit the SDK's
    // `INSUFFICIENT_FUNDS` (status 'failed'); the other either did too or escalated to awaiting_mfa.
    expect(outcomes.filter((o) => o.status === 'failed').length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(outcome.message.length).toBeGreaterThan(0);
    }

    // The balance never went negative and was never overspent.
    const finalBalance = await balanceOf();
    expect(finalBalance).toBe(UNDER_FUNDED_BALANCE);
    expect(finalBalance).toBeGreaterThanOrEqual(0n);

    // No overspend ledger row was written; executions === successful debits.
    const successfulDebits = await ledgerTotal([ZHANGWEI.name, WANGFANG.name]);
    expect(successfulDebits).toBe(0);
    expect(executed.length).toBe(successfulDebits);
  });

  it('a successful confirm writes EXACTLY one debit + one ledger row', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId, ZHANGWEI.name, '250.00');

    const outcome = await confirmAction(actionId);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    const debits = await getTestPrisma().transaction.findMany({
      where: { channel: 'TRANSFER', merchant: `转账给${ZHANGWEI.name}` },
    });
    expect(debits).toHaveLength(1);
    expect(debits[0]!.amountMinor).toBe(-25_000n);
    expect(debits[0]!.direction).toBe('DEBIT');
    expect(await balanceOf()).toBe(STARTING_BALANCE - 25_000n);
    expect(await dailyTotal()).toBe(25_000n);
  });
});

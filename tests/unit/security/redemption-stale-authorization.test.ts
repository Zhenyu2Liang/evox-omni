/**
 * Unit: security — a redemption authorization must not survive a net-value / share change.
 *
 * Workflow item 7 (`docs/cn/investments.md`): what the user approved must be what executes. The
 * gateway mints the 「净值 + 份额 + 到账金额 + 净值日期」 quote when the `PendingAction` is parked
 * (`security/security-gateway.ts` `quoteRedemption` → `redemptionSnapshot`), and
 * `banking-sdk/investment.ts` `assertConfirmedSnapshot` re-checks that snapshot against the FRESHLY
 * re-read holding + product INSIDE the write transaction. A drift therefore rejects the old
 * authorization (typed `CONFLICT` '净值或持仓已变化，请重新确认') instead of silently settling at the new
 * price — and NOTHING moves: no balance change, no share change, no ledger row.
 *
 * Everything is driven through the REAL production path — no mocks, no stubs:
 *   `securityGateway.handleToolCall` (park + snapshot)
 *   → `@/agent` `verifyAction(actionId, MFA_CODE)` (MFA claim + `executeAuthorizedAction` + settle)
 *   → the real Banking SDK on the test SQLite. The only faux piece is the `LLM_MODE=mock` provider
 * used for post-execution narration (exactly as `transfer-limits-concurrency.test.ts` does).
 *
 * Seeded world (`tests/helpers/fixtures.ts`, canonicalized on insert): holding `holding_wenjiana`
 * holds `shares '5050'` at net value `'1'`, so the position is worth ¥5,050.00 against a ¥5,000.00
 * cost; the 活期 balance is ¥23,580.00 (2 358 000 minor units).
 *
 * DB-backed (real PendingAction / InvestmentProduct / InvestmentHolding / Transaction rows) → the
 * shared test SQLite via `../../helpers/db`; never run this file concurrently with another suite.
 */
import { describe, expect, it, vi } from 'vitest';

import { getOrCreateSession, verifyAction } from '@/agent';
import { createToolRegistry } from '@/agent/tools';
import { banking } from '@/banking-sdk';
import { MFA_CODE } from '@/lib/constants';
import { businessCalendarParts } from '@/lib/date';
import { decimalText } from '@/lib/decimal';
import { AppError } from '@/lib/errors';
import { security } from '@/security';
import type { ToolCallAuthorization } from '@/security/security-gateway';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID, LATEST_NET_VALUE_DATE } from '../../helpers/fixtures';
import { newSessionId } from '../../helpers/scenario';

const gateway = security.gateway.securityGateway;

// The per-test reset + seed (`useFreshDatabase` → truncateAll + seedDemoData) is I/O heavy and can
// exceed Vitest's default hook timeout. Nothing is faked or skipped.
vi.setConfig({ hookTimeout: 60_000 });
useFreshDatabase();

/* ---------------------------------------------------------------------------------- fixtures */

/** The single seeded HOLDING position (稳健理财A). */
const HOLDING_ID = 'holding_wenjiana';
const PRODUCT_ID = 'prod_wenjiana';
/** The seeded 活期 account a redemption credits. */
const CHECKING_ACCOUNT_ID = 'acct_checking';
/** Seeded 活期 balance (`tests/helpers/fixtures.ACCOUNTS`). */
const SEEDED_BALANCE = 2_358_000n;
/** Seeded holding: `shares '5050' × net value '1'` — canonical text, as stored. */
const SEEDED_SHARES = '5050';
const SEEDED_NET_VALUE = '1';
/** `HALF_UP(5050 × 1)` — the amount the approval card shows and the SDK must settle. */
const SEEDED_SETTLEMENT = '5050.00';
/** The redemption flow category the ledger row is booked under. */
const INVESTMENT_FLOW_CATEGORY = '投资';
/** The server clarification for a redemption that states no口径 — there is no default. */
const CLARIFY = '赎回需要明确口径：请确认按「份额」还是按「金额」赎回';
/** A口径 that names two inputs at once is refused, never reinterpreted. */
const MIXED = '赎回口径不可混用：按份额与按金额只能二选一，全额赎回不接受份额或金额';
/** The stale-authorization refusal minted by `banking-sdk/investment.ts#assertConfirmedSnapshot`. */
const STALE = '净值或持仓已变化，请重新确认';

/** The redemption result payload the approval path returns (`InvestResult`), narrowed to the proof. */
interface RedemptionResult {
  success: boolean;
  holdingId: string;
  mode: 'SHARES' | 'AMOUNT' | 'ALL';
  amount: string;
  newBalance: string;
  redeemedShares: string;
  remainingShares: string;
  netValuePerUnit: string;
  netValueDate?: number;
  feeAmount: string;
  feeRule: string;
}

type ParkArgs = Record<string, unknown>;

/* ----------------------------------------------------------------------------------- helpers */

/** A proposed tool call; `sessionId` is either a persisted one (execution) or a throwaway (denial). */
function ctxFor(args: ParkArgs, sessionId: string) {
  return { sessionId, userId: DEMO_USER_ID, toolName: 'redeem_investment' as const, args,
    userRequest: '赎回理财持仓' };
}

/** A persisted `AgentSession` — required by the confirm/MFA ownership check. */
async function newPersistedSessionId(): Promise<string> {
  return (await getOrCreateSession(DEMO_USER_ID)).sessionId;
}

/** Propose a redemption through the REAL gateway and assert it was parked (gated, not executed). */
async function parkRedemption(sessionId: string, args: ParkArgs): Promise<ToolCallAuthorization> {
  const auth = await gateway.handleToolCall(ctxFor(args, sessionId));
  expect(auth.evaluation.blocked).toBe(true);
  expect(auth.decision.kind).toBe('require_mfa');
  expect(auth.action).toBeDefined();
  return auth;
}

/** The persisted `PendingAction` row (args + summary + status are the confirmation evidence). */
async function pendingRow(actionId: string) {
  const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
  if (row === null) throw new Error(`missing PendingAction: ${actionId}`);
  return row;
}

/** The parked (executable) arguments — exactly what the SDK will be handed on approval. */
async function parkedArgs(actionId: string): Promise<ParkArgs> {
  return JSON.parse((await pendingRow(actionId)).argsJson) as ParkArgs;
}

/** One labelled field of the confirmation card. */
async function summaryField(actionId: string, label: string): Promise<string | undefined> {
  const summary = JSON.parse((await pendingRow(actionId)).summaryJson) as {
    amount?: string;
    fields: { label: string; value: string }[];
  };
  return summary.fields.find((field) => field.label === label)?.value;
}

/** The money this action moves, as the card states it (the settlement, never a principal figure). */
async function summaryAmount(actionId: string): Promise<string | undefined> {
  return (JSON.parse((await pendingRow(actionId)).summaryJson) as { amount?: string }).amount;
}

/** Current 活期 balance — the money-movement proof. */
async function checkingBalance(): Promise<bigint> {
  const account = await getTestPrisma().account.findUnique({ where: { id: CHECKING_ACCOUNT_ID } });
  if (account === null) throw new Error('test seed is missing the checking account');
  return account.balanceMinor;
}

/** Current position (shares + status) — the holding-movement proof. */
async function holding(): Promise<{ shares: string; status: string; redeemExecutionKey: string | null }> {
  const row = await getTestPrisma().investmentHolding.findUnique({ where: { id: HOLDING_ID } });
  if (row === null) throw new Error('test seed is missing the holding');
  return { shares: row.shares ?? '', status: row.status, redeemExecutionKey: row.redeemExecutionKey };
}

/** Number of investment-flow ledger rows (a redemption books exactly one CREDIT). */
async function investmentLedgerCount(): Promise<number> {
  return getTestPrisma().transaction.count({
    where: { category: INVESTMENT_FLOW_CATEGORY, accountId: CHECKING_ACCOUNT_ID },
  });
}

/** Change the product's published net value through the SAME canonicalization the seed uses. */
async function publishNetValue(raw: string): Promise<void> {
  await getTestPrisma().investmentProduct.update({
    where: { id: PRODUCT_ID },
    data: { latestNetValuePerUnit: decimalText(raw) },
  });
}

/** Change the holding's recorded share count (a drifted position the approval never saw). */
async function setHoldingShares(raw: string): Promise<void> {
  await getTestPrisma().investmentHolding.update({
    where: { id: HOLDING_ID },
    data: { shares: decimalText(raw) },
  });
}

/** Business-date text (UTC+08:00) of a net value date — the SAME projection the card renders. */
function businessDateText(ts: number): string {
  const parts = businessCalendarParts(ts);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Assert the world is untouched by a refusal: no cash, no shares, no ledger row, no execution key. */
async function expectNothingMoved(before: {
  balance: bigint;
  shares: string;
  ledger: number;
}): Promise<void> {
  expect(await checkingBalance()).toBe(before.balance);
  expect((await holding()).shares).toBe(before.shares);
  expect((await holding()).redeemExecutionKey).toBeNull();
  expect(await investmentLedgerCount()).toBe(before.ledger);
}

/* ------------------------------------------- 1. stale authorization — the net value moved */

describe('赎回陈旧授权 · 净值在确认之后变动', () => {
  it('a changed net value rejects the approved quote (CONFLICT) and moves no money, no shares, no ledger row', async () => {
    const sessionId = await newPersistedSessionId();
    const parked = await parkRedemption(sessionId, { holdingId: HOLDING_ID, mode: 'SHARES', shares: '1000' });
    const actionId = parked.action!.id;

    // The approval card quoted 1000 shares at net value 1 ⇒ ¥1,000.00.
    expect(await parkedArgs(actionId)).toMatchObject({
      mode: 'SHARES', shares: '1000',
      expectedShares: '1000', expectedNetValue: SEEDED_NET_VALUE,
      expectedNetValueDate: LATEST_NET_VALUE_DATE, expectedSettlementAmount: '1000.00',
    });

    const before = { balance: await checkingBalance(), shares: SEEDED_SHARES, ledger: await investmentLedgerCount() };

    // The product republished its net value AFTER the human decision: 1.0000 → 1.0100.
    await publishNetValue('1.0100');
    expect((await getTestPrisma().investmentProduct.findUnique({ where: { id: PRODUCT_ID } }))?.latestNetValuePerUnit)
      .toBe('1.01');

    // (a) The SDK-level proof of WHAT was refused: the FIRST stale check to fire is the settlement
    // recomputation (the very same shares now settle at ¥1,010.00 ≠ the approved ¥1,000.00).
    const direct = await banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      ...(await parkedArgs(actionId)),
      idempotencyKey: 'probe-stale-net-value',
    } as Parameters<typeof banking.investment.redeemInvestment>[0]).catch((error: unknown) => error);
    expect(direct).toBeInstanceOf(AppError);
    expect((direct as AppError).code).toBe('CONFLICT');
    expect((direct as AppError).message).toBe(STALE);
    expect((direct as AppError).detail).toMatchObject({ holdingId: HOLDING_ID, field: 'expectedSettlementAmount' });

    // (b) The real approval path (MFA + authorized execution) refuses the SAME stale authorization.
    const outcome = await verifyAction(actionId, MFA_CODE);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('failed');
    expect(outcome.result?.errorCode).toBe('CONFLICT');
    expect(outcome.message).toContain(STALE);

    // The action is settled as failed — it can never be re-executed by a stray confirm.
    expect((await pendingRow(actionId)).status).toBe('failed');

    // NOTHING moved: the rejection happened before any write.
    await expectNothingMoved(before);
    expect((await holding()).status).toBe('HOLDING');
  });
});

/* --------------------------------------------- 2. stale authorization — the shares moved */

describe('赎回陈旧授权 · 份额在确认之后变动', () => {
  it('a changed share count rejects ALL-mode approval instead of redeeming the new count', async () => {
    const sessionId = await newPersistedSessionId();
    const parked = await parkRedemption(sessionId, { holdingId: HOLDING_ID, mode: 'ALL' });
    const actionId = parked.action!.id;

    // The approval card promised to close the position at 5050 shares / ¥5,050.00.
    expect(await parkedArgs(actionId)).toMatchObject({
      mode: 'ALL', expectedShares: SEEDED_SHARES,
      expectedNetValue: SEEDED_NET_VALUE, expectedSettlementAmount: SEEDED_SETTLEMENT,
    });

    // A maintenance write / another redemption changed the recorded shares after the decision.
    await setHoldingShares('5000.000000');
    const before = { balance: await checkingBalance(), shares: '5000', ledger: await investmentLedgerCount() };

    const outcome = await verifyAction(actionId, MFA_CODE);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('failed');
    expect(outcome.result?.errorCode).toBe('CONFLICT');
    expect(outcome.message).toContain(STALE);
    expect((await pendingRow(actionId)).status).toBe('failed');

    // It did NOT settle at the new share count: the position keeps its drifted 5000 shares and stays
    // `HOLDING` (not closed, not partially redeemed), and no cash was credited.
    await expectNothingMoved(before);
    expect((await holding()).status).toBe('HOLDING');
  });
});

/* ---------------------------------------------------------- 3. 口径: required, never guessed */

describe('赎回口径 · 缺失或混用一律澄清，不产生任何写入', () => {
  it('a redemption with no mode is a VALIDATION clarification: no PendingAction, no write', async () => {
    const before = { balance: await checkingBalance(), shares: SEEDED_SHARES, ledger: await investmentLedgerCount() };

    const res = await gateway.handleToolCall(ctxFor({ holdingId: HOLDING_ID }, newSessionId()));

    expect(res.evaluation.blocked).toBe(true);
    expect(res.decision.kind).toBe('deny');
    expect(res.blockReason).toBe(CLARIFY);
    expect(res.action).toBeUndefined();

    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    await expectNothingMoved(before);
  });

  it('the retired principal field (redeemAmount) and a mixed口径 are refused with no PendingAction', async () => {
    const before = { balance: await checkingBalance(), shares: SEEDED_SHARES, ledger: await investmentLedgerCount() };

    // 「赎回 2000」 is NOT a principal: it must be clarified, never defaulted to a口径.
    const principal = await gateway.handleToolCall(
      ctxFor({ holdingId: HOLDING_ID, redeemAmount: '2000.00' }, newSessionId()),
    );
    expect(principal.decision.kind).toBe('deny');
    expect(principal.blockReason).toBe(CLARIFY);

    // Two口径 at once is refused, not reinterpreted.
    const mixed = await gateway.handleToolCall(
      ctxFor({ holdingId: HOLDING_ID, mode: 'SHARES', shares: '1000', amount: '1000.00' }, newSessionId()),
    );
    expect(mixed.decision.kind).toBe('deny');
    expect(mixed.blockReason).toBe(MIXED);

    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    await expectNothingMoved(before);
  });
});

/* ------------------------------------------------------------ 4. the three explicit 口径 paths */

describe('赎回口径 · 显式口径的正常路径', () => {
  it('SHARES: 1000 shares at net value 1 credit ¥1,000.00 and leave 4050 shares', async () => {
    const sessionId = await newPersistedSessionId();
    const parked = await parkRedemption(sessionId, { holdingId: HOLDING_ID, mode: 'SHARES', shares: '1000.000000' });
    const actionId = parked.action!.id;

    const outcome = await verifyAction(actionId, MFA_CODE);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    const result = outcome.result?.data as RedemptionResult;
    expect(result).toMatchObject({
      mode: 'SHARES', redeemedShares: '1000', remainingShares: '4050',
      netValuePerUnit: SEEDED_NET_VALUE, amount: '1000.00', feeAmount: '0.00', feeRule: 'SIMULATED_NONE',
    });
    expect(await checkingBalance()).toBe(SEEDED_BALANCE + 100_000n);
    expect(await holding()).toMatchObject({ shares: '4050', status: 'HOLDING' });
    expect(await investmentLedgerCount()).toBe(1);
  });

  it('AMOUNT: ¥2,000.00 converts to 2000 shares at the published net value and credits exactly ¥2,000.00', async () => {
    const sessionId = await newPersistedSessionId();
    const parked = await parkRedemption(sessionId, { holdingId: HOLDING_ID, mode: 'AMOUNT', amount: '2000.00' });
    const actionId = parked.action!.id;

    // The gateway converts the stated AMOUNT口径 into shares with the SDK's own helper.
    expect(await parkedArgs(actionId)).toMatchObject({
      mode: 'AMOUNT', amount: '2000.00', expectedShares: '2000', expectedSettlementAmount: '2000.00',
    });

    const outcome = await verifyAction(actionId, MFA_CODE);
    expect(outcome.ok).toBe(true);

    const result = outcome.result?.data as RedemptionResult;
    expect(result).toMatchObject({
      mode: 'AMOUNT', redeemedShares: '2000', remainingShares: '3050', amount: '2000.00',
    });
    expect(await checkingBalance()).toBe(SEEDED_BALANCE + 200_000n);
    expect(await holding()).toMatchObject({ shares: '3050', status: 'HOLDING' });
    expect(await investmentLedgerCount()).toBe(1);
  });

  it('ALL: closes the position — every share redeemed, ¥5,050.00 credited, holding REDEEMED', async () => {
    const sessionId = await newPersistedSessionId();
    const parked = await parkRedemption(sessionId, { holdingId: HOLDING_ID, mode: 'ALL' });
    const actionId = parked.action!.id;

    const outcome = await verifyAction(actionId, MFA_CODE);
    expect(outcome.ok).toBe(true);

    const result = outcome.result?.data as RedemptionResult;
    expect(result).toMatchObject({
      mode: 'ALL', redeemedShares: SEEDED_SHARES, remainingShares: '0',
      amount: SEEDED_SETTLEMENT, netValuePerUnit: SEEDED_NET_VALUE,
    });
    expect(await checkingBalance()).toBe(SEEDED_BALANCE + 505_000n);
    expect(await holding()).toMatchObject({ shares: '0', status: 'REDEEMED' });
    expect(await investmentLedgerCount()).toBe(1);
  });
});

/* --------------------------------------------------- 5. the snapshot is visible AND is the trade */

describe('赎回快照 · 确认卡片可见的净值/份额/到账/费用口径与成交结果一致', () => {
  it('the PendingAction states 赎回份额/成交净值(含日期)/预计到账金额/费用口径, and the settlement matches it exactly', async () => {
    const sessionId = await newPersistedSessionId();
    const parked = await parkRedemption(sessionId, { holdingId: HOLDING_ID, mode: 'ALL' });
    const actionId = parked.action!.id;
    const snapshot = await parkedArgs(actionId);

    // Snapshot fields the SDK re-checks at execution (canonical decimal text — never a display string).
    expect(snapshot).toMatchObject({
      expectedShares: SEEDED_SHARES,
      expectedNetValue: SEEDED_NET_VALUE,
      expectedNetValueDate: LATEST_NET_VALUE_DATE,
      expectedSettlementAmount: SEEDED_SETTLEMENT,
    });

    // The human sees the same four facts on the confirmation card, plus the fee口径.
    expect(await summaryField(actionId, '赎回口径')).toBe('全部赎回');
    expect(await summaryField(actionId, '赎回份额')).toBe(SEEDED_SHARES);
    expect(await summaryField(actionId, '成交净值')).toBe('1.0000');
    expect(await summaryField(actionId, '净值日期')).toBe(businessDateText(LATEST_NET_VALUE_DATE));
    expect(await summaryField(actionId, '预计到账金额')).toBe('¥5,050.00');
    expect(await summaryField(actionId, '费用口径')).toContain('SIMULATED_NONE');
    expect(await summaryField(actionId, '金额变化')).toBe('净值、份额或到账金额变化时停止执行，需重新确认');
    // The money the action moves is the SETTLEMENT, not a principal figure.
    expect(await summaryAmount(actionId)).toBe(SEEDED_SETTLEMENT);

    // ...and the settled result is the snapshot, field for field.
    const outcome = await verifyAction(actionId, MFA_CODE);
    expect(outcome.ok).toBe(true);
    const result = outcome.result?.data as RedemptionResult;
    expect(result.redeemedShares).toBe(snapshot.expectedShares);
    expect(result.netValuePerUnit).toBe(snapshot.expectedNetValue);
    expect(result.netValueDate).toBe(snapshot.expectedNetValueDate);
    expect(result.amount).toBe(snapshot.expectedSettlementAmount);
    expect(result.feeRule).toBe('SIMULATED_NONE');
    expect(result.feeAmount).toBe('0.00');
  });
});

/* ---------------------------------------------- 6. idempotent replay is immune to repricing */

describe('赎回幂等重放 · 不因净值变化重新定价', () => {
  it('replaying the same execution identity returns the ORIGINAL receipt (original net value), crediting nothing again', async () => {
    const sessionId = await newPersistedSessionId();
    const parked = await parkRedemption(sessionId, { holdingId: HOLDING_ID, mode: 'ALL' });
    const actionId = parked.action!.id;
    const approved = await parkedArgs(actionId);

    const first = await verifyAction(actionId, MFA_CODE);
    expect(first.ok).toBe(true);
    expect((first.result?.data as RedemptionResult).amount).toBe(SEEDED_SETTLEMENT);
    const balanceAfterExecution = await checkingBalance();
    expect(balanceAfterExecution).toBe(SEEDED_BALANCE + 505_000n);
    const ledgerAfterExecution = await investmentLedgerCount();
    expect(ledgerAfterExecution).toBe(1);

    // The product reprices AFTER the settlement — a replay must not use the new price.
    await publishNetValue('1.0100');
    expect((await getTestPrisma().investmentProduct.findUnique({ where: { id: PRODUCT_ID } }))?.latestNetValuePerUnit)
      .toBe('1.01');

    // The REAL replay path: the same server-owned execution identity (`ledgerKeyForAction` = the
    // action id for a standalone action) hits the committed receipt before any mutable lookup.
    const replay = await createToolRegistry(DEMO_USER_ID)
      .executeDirect('redeem_investment', approved, { idempotencyKey: actionId });

    expect(replay.ok).toBe(true);
    expect(replay.data as RedemptionResult).toMatchObject({
      mode: 'ALL',
      redeemedShares: SEEDED_SHARES,
      netValuePerUnit: SEEDED_NET_VALUE,          // the ORIGINAL net value, not '1.01'
      netValueDate: LATEST_NET_VALUE_DATE,
      amount: SEEDED_SETTLEMENT,                  // ¥5,050.00, not the repriced ¥5,100.50
      feeRule: 'SIMULATED_NONE',
    });

    // A replay credits nothing and writes nothing.
    expect(await checkingBalance()).toBe(balanceAfterExecution);
    expect(await investmentLedgerCount()).toBe(ledgerAfterExecution);
    expect((await holding()).status).toBe('REDEEMED');
  });
});

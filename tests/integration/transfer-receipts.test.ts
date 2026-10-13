/**
 * integration/transfer-receipts.test.ts — transaction-fact ATOMICITY, IDEMPOTENCY and EXECUTION-IDENTITY
 * conflicts on the money-movement ledger + the unified execution receipt.
 *
 * The banking SDK writes the DEBIT, its ledger row and the `ExecutionReceipt` (the durable proof the
 * side effect committed) in ONE `runInTransaction` (`banking-sdk/transfer.ts#createTransfer`), and the
 * gated continuation lands the action's RESULT + terminal STATUS + audit in ONE `prisma.$transaction`
 * (`agent/confirmation.ts#executeAuthorizedAction` → `settlePendingAction`). This suite pins those
 * atomicity/idempotency guarantees against the REAL isolated test SQLite (`prisma/test.db`):
 *
 *  1. REVIEW_RECEIPT_WRITE_ROLLBACK — a receipt write that fails AFTER the debit is attempted rolls
 *     the debit AND its ledger row back atomically (no orphan debit, no receipt).
 *  2. REVIEW_SAME_IDENTITY_CONCURRENT_RECOVERY — TWO concurrent recoveries of a standalone ¥200 wedge
 *     (side effect already committed, result write rolled back) apply the side effect EXACTLY ONCE
 *     and both settle the action `executed` (no fabricated status, no second debit).
 *  3. REVIEW_IDENTITY_REQUEST_CONFLICT — the SAME `idempotencyKey` used for a DIFFERENT request is
 *     rejected with `AppError('CONFLICT')` and writes no additional debit.
 *  4. REVIEW_RECEIPT_REPLAY_IDEMPOTENT — the SAME key with the SAME request replays the ORIGINAL
 *     result verbatim (same transactionId/newBalance) with exactly one debit.
 *
 * Real app-entry layer: the REAL route handlers, the REAL confirmation/recovery continuation, the REAL
 * Banking SDK and the REAL test SQLite run in-process; the ONLY mocks are REAL fault injections
 * (`vi.spyOn(...).mockRejectedValueOnce`) that are asserted to have HIT before any outcome is checked.
 * Every assertion re-reads persisted DB state.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executeGatedTool, getOrCreateSession } from '@/agent';
import { banking } from '@/banking-sdk';
import type { TransferInput, TransferResult } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { centsToMoney, moneyToCents, subtractMoney } from '@/lib/money';
import { executionReceiptId, idempotentTransferTxId } from '@/lib/ledger';
import * as executionReceiptRepo from '@/lib/db/repositories/executionReceipt';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import * as commandExecution from '@/agent/command-execution';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const userId = 'user_liming';
/** Primary CHECKING account every transfer funds from (seed balance ¥23,580). */
const CHECKING = 'acct_checking';
const START_BALANCE = '23580.00';
/** Seeded contact 张伟 — the transfer recipient. */
const ZHANGWEI = 'contact_zhangwei';

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

function db() {
  return getTestPrisma();
}

function createTransfer(input: TransferInput): Promise<TransferResult> {
  return banking.transfer.createTransfer(input);
}

/** Current CHECKING balance (CNY). */
async function balance(): Promise<string> {
  return centsToMoney((await db().account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor);
}

/** Ledger DEBIT rows written by THIS suite to 张伟 for `amount` (magnitude, CNY). */
function debitCount(amount: string): Promise<number> {
  return db().transaction.count({ where: { userId, counterpartyId: ZHANGWEI, amountMinor: -moneyToCents(amount) } });
}

/** Await `fn`, returning whatever it threw; fails loudly if it unexpectedly resolves. */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it resolved');
}

/** POST a confirm for a specific action through the REAL route handler, carrying the session cookie. */
async function confirm(id: string, sessionId: string) {
  const res = await confirmPost(
    new NextRequest(`http://localhost/api/actions/${id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${sessionId}` },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { http: res.status, body: await res.json() };
}

/** POST a recover for a specific action through the REAL route handler, carrying the session cookie. */
async function recover(id: string, sessionId: string) {
  const res = await recoverPost(
    new NextRequest(`http://localhost/api/actions/${id}/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${sessionId}` },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { http: res.status, body: await res.json() };
}

it('REVIEW_RECEIPT_WRITE_ROLLBACK: a failed receipt write rolls the debit + ledger row back atomically', async () => {
  const key = 'review-rollback-1';

  // REAL fault injection: the NEXT `putExecutionReceipt` rejects. It is called INSIDE the same
  // `runInTransaction` that already applied the debit + ledger row, so a rejection must roll BOTH back.
  const spy = vi
    .spyOn(executionReceiptRepo, 'putExecutionReceipt')
    .mockRejectedValueOnce(new Error('review: receipt write failed after debit'));

  const thrown = await captureError(() =>
    createTransfer({ userId, idempotencyKey: key, name: '张伟', amount: '150.00', remark: 'REVIEW_ROLLBACK' }),
  );

  // The injection HIT the receipt write (guards against a silently non-intercepted spy).
  expect(spy).toHaveBeenCalledTimes(1);
  expect(thrown).toBeInstanceOf(Error);

  // NO orphan debit, NO ledger row, NO receipt — the transaction rolled back as ONE unit.
  const debits = await debitCount('150.00');
  const receipts = await db().executionReceipt.count({ where: { userId, key } });
  const ledgerRow = await db().transaction.findUnique({ where: { id: idempotentTransferTxId(userId, key) } });

  console.log(
    'REVIEW_RECEIPT_WRITE_ROLLBACK',
    JSON.stringify({ spyCalls: spy.mock.calls.length, debits, receipts, ledgerRow: ledgerRow?.id ?? null, balance: await balance() }),
  );

  expect(debits).toBe(0);
  expect(receipts).toBe(0);
  expect(ledgerRow).toBeNull();
  expect(await balance()).toBe(START_BALANCE);
});

it('REVIEW_SAME_IDENTITY_CONCURRENT_RECOVERY: two concurrent recoveries apply the side effect exactly once', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();

  // --- Build a STANDALONE ¥200 wedge: the SDK side effect commits, the result+status write rolls back.
  const gate = await executeGatedTool({
    sessionId,
    userId,
    toolName: 'transfer_money',
    args: { name: '张伟', amount: '200.00' },
    userRequest: '给张伟转200元',
  });
  expect(gate.ok).toBe(false);
  expect(gate.requiresConfirmation).toBe(true);
  const id = gate.pendingActionId;
  expect(id).toBeTruthy();

  const wedgeSpy = vi
    .spyOn(pendingActionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('review: result write failed after debit'));
  const wedged = await confirm(id!, sessionId);
  expect(wedgeSpy).toHaveBeenCalledTimes(1); // the injection HIT the result+status transaction
  wedgeSpy.mockRestore();

  const wedgedRow = await p.pendingAction.findUniqueOrThrow({ where: { id: id! } });
  expect(wedged.http).toBe(500);
  expect(wedgedRow.status).toBe('confirmed');
  expect(wedgedRow.resultJson).toBeNull();
  // Pre-recovery persisted facts: exactly ONE debit, ONE committed receipt, balance already reduced.
  expect(await debitCount('200.00')).toBe(1);
  expect(await p.executionReceipt.count({ where: { userId, key: id! } })).toBe(1);
  expect((await p.account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor).toBe(2338000n);

  // --- CONTROLLABLE BARRIER: both recoveries must reach the committed-receipt read before either
  // proceeds, so they genuinely OVERLAP on the same `confirmed` row instead of racing sequentially.
  const originalGetReceipt = commandExecution.readCommandReceipt;
  let arrived = 0;
  let releaseBarrier: () => void = () => {};
  const barrierGate = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const receiptSpy = vi
    .spyOn(commandExecution, 'readCommandReceipt')
    .mockImplementation(async (...args) => {
      arrived += 1;
      if (arrived >= 2) releaseBarrier();
      await barrierGate;
      return originalGetReceipt(...args);
    });

  const [first, second] = await Promise.all([recover(id!, sessionId), recover(id!, sessionId)]);

  expect(receiptSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(arrived).toBeGreaterThanOrEqual(2); // Both recoveries reached the read before either continued.
  receiptSpy.mockRestore();

  // --- The side effect happened EXACTLY ONCE; the action settled `executed`; no fabricated status.
  const settled = await p.pendingAction.findUniqueOrThrow({ where: { id: id! } });
  const debits = await debitCount('200.00');
  const receipts = await p.executionReceipt.count({ where: { userId, key: id! } });
  const finalBalance = centsToMoney((await p.account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor);

  console.log(
    'REVIEW_SAME_IDENTITY_CONCURRENT_RECOVERY',
    JSON.stringify({
      firstHttp: first.http,
      secondHttp: second.http,
      firstOk: first.body.data?.ok,
      secondOk: second.body.data?.ok,
      firstStatus: first.body.data?.status,
      secondStatus: second.body.data?.status,
      settledStatus: settled.status,
      debits,
      receipts,
      finalBalance,
    }),
  );

  expect(first.http).toBe(200);
  expect(second.http).toBe(200);
  expect(first.body.data?.ok).toBe(true);
  expect(second.body.data?.ok).toBe(true);
  expect(first.body.data?.status).toBe('executed');
  expect(second.body.data?.status).toBe('executed');
  expect(settled.status).toBe('executed');
  expect(settled.resultJson).not.toBeNull(); // the recovered result was persisted
  expect(debits).toBe(1); // exactly one side effect
  expect(receipts).toBe(1);
  expect(finalBalance).toBe('23380.00');
});

it('REVIEW_IDENTITY_REQUEST_CONFLICT: the same key for a different request is rejected (CONFLICT) with no extra debit', async () => {
  const key = 'review-fixed-key';

  const first = await createTransfer({ userId, idempotencyKey: key, name: '张伟', amount: '100.00', remark: 'REVIEW_CONFLICT' });
  expect(first.amount).toBe('100.00');
  expect(first.transactionId).toBe(idempotentTransferTxId(userId, key));

  // SAME execution identity, DIFFERENT request (amount 200 ≠ 100) → explicit CONFLICT, never executed.
  const thrown = await captureError(() =>
    createTransfer({ userId, idempotencyKey: key, name: '张伟', amount: '200.00', remark: 'REVIEW_CONFLICT' }),
  );
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe('CONFLICT');

  const debits100 = await debitCount('100.00');
  const debits200 = await debitCount('200.00');
  const receipts = await db().executionReceipt.count({ where: { userId, key } });
  const finalBalance = await balance();

  console.log(
    'REVIEW_IDENTITY_REQUEST_CONFLICT',
    JSON.stringify({ code: (thrown as AppError).code, debits100, debits200, receipts, finalBalance }),
  );

  expect(debits100).toBe(1); // only the ORIGINAL request debited
  expect(debits200).toBe(0); // the conflicting request wrote nothing
  expect(receipts).toBe(1); // the original receipt stands
  expect(finalBalance).toBe(subtractMoney(START_BALANCE, '100.00')); // Balance reflects only the first transfer.
});

it('REVIEW_RECEIPT_REPLAY_IDEMPOTENT: same key + same request replays the original result with one debit', async () => {
  const key = 'review-replay-key';
  const input: TransferInput = { userId, idempotencyKey: key, name: '张伟', amount: '120.00', remark: 'REVIEW_REPLAY' };

  const first = await createTransfer(input);
  const second = await createTransfer(input);

  const receipt = await db().executionReceipt.findUniqueOrThrow({ where: { userId_key: { userId, key } } });
  const debits = await debitCount('120.00');
  const finalBalance = await balance();

  console.log(
    'REVIEW_RECEIPT_REPLAY_IDEMPOTENT',
    JSON.stringify({
      sameTxId: second.transactionId === first.transactionId,
      firstBalance: first.newBalance,
      secondBalance: second.newBalance,
      receiptId: receipt.id,
      debits,
      finalBalance,
    }),
  );

  // The replayed result is the ORIGINAL snapshot — same transaction id and balance.
  expect(second.transactionId).toBe(first.transactionId);
  expect(second.newBalance).toBe(first.newBalance);
  expect(first.newBalance).toBe(subtractMoney(START_BALANCE, '120.00'));
  expect(first.transactionId).toBe(idempotentTransferTxId(userId, key));

  // Exactly ONE debit + ONE receipt addressed by the deterministic identity.
  expect(debits).toBe(1);
  expect(receipt.id).toBe(executionReceiptId(userId, key));
  expect(receipt.txId).toBe(first.transactionId);
  expect(JSON.parse(receipt.resultJson)).toEqual(first);
  expect(finalBalance).toBe(subtractMoney(START_BALANCE, '120.00')); // Debited exactly once.
});

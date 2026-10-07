/**
 * review-idempotent-replay.test.ts — idempotent replay is SERIAL- and CONCURRENT-safe and never
 * returns a WRONG recipient/amount.
 *
 * The Banking SDK's `createTransfer` gives a transfer AT-MOST-ONCE semantics through the optional
 * `idempotencyKey`: the ledger row id is derived deterministically from `(userId, key)`, and the
 * SAME execution identity also writes an `ExecutionReceipt` (a snapshot of the ORIGINAL result +
 * a canonical digest of the ORIGINAL request) in ONE `runInTransaction` together with the debit
 * (`banking-sdk/transfer.ts#createTransfer`). This suite pins those guarantees against the REAL
 * isolated test SQLite (`prisma/test.db`):
 *
 *  1. REVIEW_REPLAY_SERIAL_IDEMPOTENT — two SEQUENTIAL identical calls (same key + same request)
 *     return the SAME transaction id, write exactly ONE ledger row / receipt and debit ONCE; the
 *     second call replays from the COMMITTED fact and never re-resolves the mutable recipient.
 *  2. REVIEW_REPLAY_CONCURRENT_SAME_REQUEST — two OVERLAPPING identical calls (threaded barrier)
 *     converge on the SAME committed result: ONE debit, ONE receipt, ONE ledger row.
 *  3. REVIEW_REPLAY_CONCURRENT_DIFFERENT_REQUEST — the SAME key used for a DIFFERENT request
 *     (a `王芳` ¥300 call overlapped with a `张伟` ¥200 call) makes the loser fail with
 *     `AppError('CONFLICT')`; the winner's returned recipient/amount MATCH its persisted ledger row
 *     (never a contradictory recipient) and there is exactly ONE receipt / ONE debit.
 *  4. REVIEW_REPLAY_RETURNS_ORIGINAL_SNAPSHOT — a same-key replay returns the ORIGINAL committed
 *     snapshot verbatim (its `transactionId` equals the persisted ledger row id), never a value
 *     spliced from the current request.
 *
 * Real app-entry layer: the REAL Banking SDK + the REAL test SQLite run in-process; the ONLY mocks
 * are a `vi.spyOn(contactRepo, 'searchContacts')` hold (a controllable barrier, never a fabricated
 * value) — every test asserts the barrier FIRED via call counts. Every invariant is re-read from
 * persisted DB state.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { banking } from '@/banking-sdk';
import type { TransferInput, TransferResult } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { executionReceiptId, idempotentTransferTxId } from '@/lib/ledger';
import * as contactRepo from '@/lib/db/repositories/contact';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const userId = 'user_liming';
/** Primary CHECKING account every transfer funds from (seed balance ¥23,580). */
const CHECKING = 'acct_checking';
const START_BALANCE = 23580;
/** Seeded contacts — the transfer recipients. */
const ZHANGWEI = 'contact_zhangwei';
const WANGFANG = 'contact_wangfang';

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

function db() {
  return getTestPrisma();
}

function createTransfer(input: TransferInput): Promise<TransferResult> {
  return banking.transfer.createTransfer(input);
}

/** A one-shot latch pair: `reached` is released by the spy, `release` unblocks the held call. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** Await `p`, but fail loudly if the barrier never releases (a non-intercepted spy would hang). */
async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000);
      }),
    ])) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Current CHECKING balance (CNY). */
async function balance(): Promise<number> {
  return (await db().account.findUniqueOrThrow({ where: { id: CHECKING } })).balance;
}

/** Ledger DEBIT rows written to `counterpartyId` for `amount` (magnitude, CNY). */
function debitCount(amount: number, counterpartyId: string): Promise<number> {
  return db().transaction.count({ where: { userId, counterpartyId, amount: -amount } });
}

/** Persisted ledger row addressed by the deterministic identity of `key`. */
function ledgerRow(key: string) {
  return db().transaction.findUniqueOrThrow({ where: { id: idempotentTransferTxId(userId, key) } });
}

/** Number of `ExecutionReceipt` rows for `key`. */
function receiptCount(key: string): Promise<number> {
  return db().executionReceipt.count({ where: { userId, key } });
}

it('REVIEW_REPLAY_SERIAL_IDEMPOTENT: two sequential identical calls replay one committed transfer', async () => {
  const key = 'review-replay-serial';
  // Barrier: the replay must be COMMITTED-FACT FIRST — the second call replays the receipt WITHOUT
  // re-resolving the mutable recipient, so `searchContacts` is entered exactly ONCE (the first call).
  const searchSpy = vi.spyOn(contactRepo, 'searchContacts');
  const request: TransferInput = { userId, idempotencyKey: key, name: '张伟', amount: 200, remark: 'REVIEW_SERIAL' };

  const first = await createTransfer(request);
  const second = await createTransfer(request);

  const row = await ledgerRow(key);
  const debits = await debitCount(200, ZHANGWEI);
  const receipts = await receiptCount(key);
  const finalBalance = await balance();

  console.log(
    'REVIEW_REPLAY_SERIAL_IDEMPOTENT',
    JSON.stringify({
      searchCalls: searchSpy.mock.calls.length,
      sameTxId: second.transactionId === first.transactionId,
      firstTxId: first.transactionId,
      ledgerRowId: row.id,
      debits,
      receipts,
      finalBalance,
    }),
  );

  // The replay path fired: the winner was resolved ONCE, the second call never re-resolved 张伟.
  expect(searchSpy.mock.calls.length).toBe(1);

  // Both calls succeeded and returned the SAME original transaction id.
  expect(first.success).toBe(true);
  expect(second.success).toBe(true);
  expect(second.transactionId).toBe(first.transactionId);
  expect(first.transactionId).toBe(idempotentTransferTxId(userId, key));

  // Exactly ONE ledger row for that key, ONE receipt, ONE debit.
  expect(row.id).toBe(first.transactionId);
  expect(debits).toBe(1);
  expect(receipts).toBe(1);
  expect(finalBalance).toBe(START_BALANCE - 200);
});

it('REVIEW_REPLAY_CONCURRENT_SAME_REQUEST: overlapping identical calls debited exactly once', async () => {
  const key = 'review-replay-concurrent-same-request';
  const reached = deferred();
  const release = deferred();

  // Thread the barrier: hold the FIRST call inside `searchContacts` while the SECOND completes.
  const original = contactRepo.searchContacts;
  let held = 0;
  const spy = vi.spyOn(contactRepo, 'searchContacts').mockImplementation(async (uid, keyword) => {
    const rows = await original(uid, keyword);
    if (keyword === '张伟' && held === 0) {
      held += 1;
      reached.release();
      await release.promise;
    }
    return rows;
  });

  const request: TransferInput = { userId, idempotencyKey: key, name: '张伟', amount: 200 };
  const firstPromise = createTransfer(request);
  let first: TransferResult;
  let second: TransferResult;
  try {
    await bounded(reached.promise);
    expect(held).toBe(1); // the barrier genuinely fired — the first call is parked mid-resolution
    second = await createTransfer(request); // wins the write race while the first is held
  } finally {
    release.release();
    first = await firstPromise; // resumes and replays the committed fact
  }

  const row = await ledgerRow(key);
  const debits = await debitCount(200, ZHANGWEI);
  const receipts = await receiptCount(key);
  const finalBalance = await balance();

  console.log(
    'REVIEW_REPLAY_CONCURRENT_SAME_REQUEST',
    JSON.stringify({
      held,
      searchCalls: spy.mock.calls.length,
      sameTxId: first.transactionId === second.transactionId,
      firstBalance: first.newBalance,
      secondBalance: second.newBalance,
      debits,
      receipts,
      finalBalance,
    }),
  );

  // The barrier fired and both calls overlapped on the same identity.
  expect(held).toBe(1);
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);

  // Both calls converge on the SAME committed result — one debit, one receipt, one ledger row.
  expect(first.transactionId).toBe(second.transactionId);
  expect(first.transactionId).toBe(idempotentTransferTxId(userId, key));
  expect(first.newBalance).toBe(second.newBalance);
  expect(row.id).toBe(first.transactionId);
  expect(debits).toBe(1);
  expect(receipts).toBe(1);
  expect(finalBalance).toBe(START_BALANCE - 200);
});

it('REVIEW_REPLAY_CONCURRENT_DIFFERENT_REQUEST: overlapping different request conflicts, winner matches its ledger row', async () => {
  const key = 'review-replay-concurrent-different-request';
  const reached = deferred();
  const release = deferred();

  // Hold the `王芳` ¥300 call inside `searchContacts`, then let the `张伟` ¥200 call win the write.
  const original = contactRepo.searchContacts;
  let held = 0;
  const spy = vi.spyOn(contactRepo, 'searchContacts').mockImplementation(async (uid, keyword) => {
    const rows = await original(uid, keyword);
    if (keyword === '王芳') {
      held += 1;
      reached.release();
      await release.promise;
    }
    return rows;
  });

  const slow = createTransfer({ userId, idempotencyKey: key, name: '王芳', amount: 300 }).then(
    (result) => ({ ok: true as const, result, code: undefined as string | undefined, error: undefined }),
    (error) => ({ ok: false as const, result: undefined, code: error.code as string, error }),
  );
  let winner: TransferResult;
  let loser: Awaited<typeof slow>;
  try {
    await bounded(reached.promise);
    expect(held).toBe(1); // the barrier genuinely fired — the 王芳 call is parked mid-resolution
    winner = await createTransfer({ userId, idempotencyKey: key, name: '张伟', amount: 200 });
  } finally {
    release.release();
    loser = await slow;
  }

  const row = await ledgerRow(key);
  const zhangweiDebits = await debitCount(200, ZHANGWEI);
  const wangfangDebits = await debitCount(300, WANGFANG);
  const receipts = await receiptCount(key);

  console.log(
    'REVIEW_REPLAY_CONCURRENT_DIFFERENT_REQUEST',
    JSON.stringify({
      held,
      searchCalls: spy.mock.calls.length,
      loserOk: loser.ok,
      loserCode: loser.code,
      winnerRecipient: winner.recipient.name,
      winnerAmount: winner.amount,
      ledgerRecipient: row.counterpartyId,
      ledgerAmount: row.amount,
      zhangweiDebits,
      wangfangDebits,
      receipts,
    }),
  );

  // The barrier fired; the loser is an explicit CONFLICT, never a false success.
  expect(held).toBe(1);
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(loser.ok).toBe(false);
  expect(loser.code).toBe('CONFLICT');
  expect(loser.error).toBeInstanceOf(AppError);
  expect((loser.error as AppError).code).toBe('CONFLICT');

  // The WINNER's returned recipient/amount MATCH the persisted ledger row — no contradictory recipient.
  expect(winner.recipient.name).toBe('张伟');
  expect(winner.recipient.contactId).toBe(ZHANGWEI);
  expect(winner.amount).toBe(200);
  expect(row.counterpartyId).toBe(ZHANGWEI);
  expect(row.amount).toBe(-200);
  expect(winner.transactionId).toBe(row.id);

  // Exactly ONE receipt and exactly ONE debit (only the winner's request wrote).
  expect(receipts).toBe(1);
  expect(zhangweiDebits).toBe(1);
  expect(wangfangDebits).toBe(0);
  expect(await balance()).toBe(START_BALANCE - 200);
});

it('REVIEW_REPLAY_RETURNS_ORIGINAL_SNAPSHOT: a replay returns the committed snapshot, never the current request', async () => {
  const key = 'review-replay-original-snapshot';
  // The replay must NOT re-resolve the mutable recipient: `searchContacts` runs for the FIRST call
  // only (proving the second call returned the PERSISTED snapshot, not a fresh resolution).
  const searchSpy = vi.spyOn(contactRepo, 'searchContacts');
  const request: TransferInput = { userId, idempotencyKey: key, name: '张伟', amount: 200, remark: 'REVIEW_SNAPSHOT' };

  const first = await createTransfer(request);
  const replayed = await createTransfer(request);

  const row = await ledgerRow(key);
  const receipt = await db().executionReceipt.findUniqueOrThrow({ where: { userId_key: { userId, key } } });
  const storedSnapshot = JSON.parse(receipt.resultJson) as TransferResult;

  console.log(
    'REVIEW_REPLAY_RETURNS_ORIGINAL_SNAPSHOT',
    JSON.stringify({
      searchCalls: searchSpy.mock.calls.length,
      replayedTxId: replayed.transactionId,
      ledgerRowId: row.id,
      receiptId: receipt.id,
      sameAsStored: JSON.stringify(storedSnapshot) === JSON.stringify(replayed),
      replayedRecipient: replayed.recipient.name,
    }),
  );

  // Barrier fired: the recipient was resolved exactly ONCE — the replay short-circuited on the receipt.
  expect(searchSpy.mock.calls.length).toBe(1);

  // The replayed value is the ORIGINAL committed snapshot, addressed by the persisted ledger row id.
  expect(replayed.transactionId).toBe(row.id);
  expect(replayed.transactionId).toBe(first.transactionId);
  expect(replayed.newBalance).toBe(first.newBalance);
  expect(replayed.recipient.name).toBe('张伟');
  expect(receipt.id).toBe(executionReceiptId(userId, key));
  expect(receipt.txId).toBe(row.id);
  expect(storedSnapshot).toEqual(first);
  expect(replayed).toEqual(storedSnapshot);

  // One debit, one receipt.
  expect(await debitCount(200, ZHANGWEI)).toBe(1);
  expect(await receiptCount(key)).toBe(1);
  expect(await balance()).toBe(START_BALANCE - 200);
});

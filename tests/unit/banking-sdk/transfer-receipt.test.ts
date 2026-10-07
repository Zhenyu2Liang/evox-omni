/**
 * Unit: banking-sdk/transfer — COMMITTED-FACT (execution-receipt) semantics.
 *
 * Proves an already-debited transfer is recognized from PERSISTED facts and never re-resolved
 * through MUTABLE data (a recipient looked up by name):
 *   (a) same key + same request → replays the ORIGINAL result, no second debit;
 *   (b) same key + DIFFERENT request → throws AppError('CONFLICT'), no new debit;
 *   (c) a LEGACY ledger row (debit present, NO receipt) is recognized as already-credited even when
 *       the contact was renamed/deleted — no fabricated fields, no NOT_FOUND;
 *   (d) a fresh (never-executed) transfer with an unknown recipient still throws NOT_FOUND;
 *   (e) a fresh successful transfer writes a receipt whose resultJson == the returned TransferResult.
 *
 * DB-backed: the isolated test SQLite via ../../helpers/db (fresh canonical fixtures per case).
 * Seed: 李明 checking balance 23580; contacts 张伟/王芳/妈妈/李华.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { TransferInput, TransferResult } from '@/banking-sdk';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { executionReceiptId, idempotentTransferTxId } from '@/lib/ledger';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

/** Primary CHECKING account every transfer funds from (seed balance ¥23,580). */
const CHECKING = 'acct_checking';
const CHECKING_START_BALANCE = 23580;

function db() {
  return getTestPrisma();
}

function transfer(input: TransferInput): Promise<TransferResult> {
  return banking.transfer.createTransfer(input);
}

/** Current CHECKING balance (CNY). */
async function balance(): Promise<number> {
  const account = await db().account.findUniqueOrThrow({ where: { id: CHECKING } });
  return account.balance;
}

/** Ledger DEBIT rows written by THIS test, isolated by a unique remark. */
function ledgerCount(remark: string): Promise<number> {
  return db().transaction.count({
    where: { userId: DEMO_USER_ID, category: '转账', remark },
  });
}

function receiptCount(): Promise<number> {
  return db().executionReceipt.count({ where: { userId: DEMO_USER_ID } });
}

/** Await `fn`, returning the thrown `AppError`; fails loudly if it unexpectedly resolves. */
async function captureError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the call to throw an AppError, but it resolved');
}

describe('banking-sdk/transfer · committed-fact replay', () => {
  it('(a) same key + same request replays the ORIGINAL result with no second debit', async () => {
    const key = 'unit:receipt:same';
    const input: TransferInput = {
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: 200,
      remark: 'REPLAY_SAME',
      idempotencyKey: key,
    };

    const first = await transfer(input);
    const second = await transfer(input);

    // The replayed result is the ORIGINAL snapshot, verbatim.
    expect(second).toEqual(first);
    expect(second.success).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.newBalance).toBe(23380);
    expect(second.amount).toBe(200);
    expect(second.recipient).toEqual(first.recipient);

    // Exactly ONE debit + ONE ledger row + ONE receipt.
    expect(await ledgerCount('REPLAY_SAME')).toBe(1);
    expect(await receiptCount()).toBe(1);
    expect(await balance()).toBe(CHECKING_START_BALANCE - 200);
  });

  it('(b) same key + a DIFFERENT request throws CONFLICT and writes no new debit', async () => {
    const key = 'unit:receipt:conflict';
    await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: 200,
      remark: 'CONFLICT_BASE',
      idempotencyKey: key,
    });

    // Different amount, same identity.
    const byAmount = await captureError(() =>
      transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: 300, idempotencyKey: key }),
    );
    expect(byAmount).toBeInstanceOf(AppError);
    expect(byAmount.code).toBe('CONFLICT');
    expect(byAmount.message).toBe('same execution identity, different request');

    // Different recipient, same identity.
    const byRecipient = await captureError(() =>
      transfer({ userId: DEMO_USER_ID, name: '妈妈', amount: 200, idempotencyKey: key }),
    );
    expect(byRecipient.code).toBe('CONFLICT');

    // Neither rejection debited the account nor wrote a ledger row / a second receipt.
    expect(await ledgerCount('CONFLICT_BASE')).toBe(1);
    expect(await db().transaction.count({ where: { userId: DEMO_USER_ID, category: '转账', amount: -300 } })).toBe(0);
    expect(await receiptCount()).toBe(1);
    expect(await balance()).toBe(CHECKING_START_BALANCE - 200);
  });
});

describe('banking-sdk/transfer · legacy ledger row (no receipt)', () => {
  it('(c1) a renamed contact does NOT make an already-ledgered transfer fail — replayed from persisted facts', async () => {
    const key = 'unit:receipt:legacy:renamed';
    const first = await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: 200,
      remark: 'LEGACY_RENAMED',
      idempotencyKey: key,
    });

    // Simulate a LEGACY row: the debit + ledger exist, but there is NO receipt (pre-upgrade data),
    // and the mutable recipient lookup no longer matches the original name.
    await db().executionReceipt.deleteMany({ where: { userId: DEMO_USER_ID, key } });
    await db().contact.update({ where: { id: 'contact_zhangwei' }, data: { name: '张伟（已更名）' } });

    const replayed = await transfer({ userId: DEMO_USER_ID, name: '张伟', amount: 200, idempotencyKey: key });

    expect(replayed.success).toBe(true);
    expect(replayed.transactionId).toBe(first.transactionId);
    expect(replayed.amount).toBe(200); // from the persisted ledger row, not re-derived from the request
    expect(replayed.newBalance).toBe(23380); // from the account
    // Recipient from the PERSISTED counterparty (still resolves) — the current contact row, never invented.
    expect(replayed.recipient.contactId).toBe('contact_zhangwei');
    expect(replayed.recipient.name).toBe('张伟（已更名）');

    expect(await ledgerCount('LEGACY_RENAMED')).toBe(1);
    expect(await receiptCount()).toBe(0);
    expect(await balance()).toBe(23380);
  });

  it('(c2) a DELETED counterparty still replays from persisted fields with a MINIMAL recipient (never NOT_FOUND, never fabricated)', async () => {
    const key = 'unit:receipt:legacy:removed';
    const first = await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: 200,
      remark: 'LEGACY_REMOVED',
      idempotencyKey: key,
    });

    // Legacy: drop the receipt AND the contact, so the counterparty can no longer be resolved.
    await db().executionReceipt.deleteMany({ where: { userId: DEMO_USER_ID, key } });
    await db().contact.delete({ where: { id: 'contact_zhangwei' } });

    const replayed = await transfer({ userId: DEMO_USER_ID, name: '张伟', amount: 200, idempotencyKey: key });

    expect(replayed.success).toBe(true);
    expect(replayed.transactionId).toBe(first.transactionId);
    expect(replayed.amount).toBe(200);
    expect(replayed.newBalance).toBe(23380);
    // MINIMAL recipient built from PERSISTED ledger fields only — no invented contact id/phone.
    expect(replayed.recipient.contactId).toBeUndefined();
    expect(replayed.recipient.phone).toBe('');
    expect(replayed.recipient.name).toBe('张伟'); // the name the ledger row itself recorded (merchant)

    expect(await ledgerCount('LEGACY_REMOVED')).toBe(1);
    expect(await balance()).toBe(23380);
  });

  it('(c3) the deterministic ledger row is addressed by the SAME derived identity the SDK wrote', async () => {
    const key = 'unit:receipt:legacy:identity';
    const first = await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: 200,
      remark: 'LEGACY_IDENTITY',
      idempotencyKey: key,
    });

    expect(idempotentTransferTxId(DEMO_USER_ID, key)).toBe(first.transactionId);
    const row = await db().transaction.findUniqueOrThrow({ where: { id: idempotentTransferTxId(DEMO_USER_ID, key) } });
    expect(row.amount).toBe(-200);
    expect(demoNow()).toBe(first.occurredAt);
  });
});

describe('banking-sdk/transfer · fresh requests keep their boundaries', () => {
  it('(d) a never-executed transfer with an unknown recipient still throws NOT_FOUND and writes nothing', async () => {
    const key = 'unit:receipt:unknown';
    const error = await captureError(() =>
      transfer({ userId: DEMO_USER_ID, name: '不存在的人', amount: 100, idempotencyKey: key }),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('NOT_FOUND');

    // A fresh miss records NO receipt and writes no ledger row (only the seeded 转账 row remains).
    expect(await db().executionReceipt.count({ where: { userId: DEMO_USER_ID, key } })).toBe(0);
    expect(await db().transaction.count({ where: { userId: DEMO_USER_ID, category: '转账' } })).toBe(1);
    expect(await balance()).toBe(CHECKING_START_BALANCE);
  });

  it('(e) a fresh successful transfer writes a receipt whose resultJson == the returned TransferResult', async () => {
    const key = 'unit:receipt:snapshot';
    const result = await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: 200,
      remark: 'SNAPSHOT',
      idempotencyKey: key,
    });

    const receipt = await db().executionReceipt.findUniqueOrThrow({
      where: { userId_key: { userId: DEMO_USER_ID, key } },
    });

    expect(receipt.id).toBe(executionReceiptId(DEMO_USER_ID, key));
    expect(receipt.toolName).toBe('transfer_money');
    expect(receipt.txId).toBe(result.transactionId);
    expect(receipt.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(receipt.resultJson)).toEqual(result);
  });

  it('(e2) two DIFFERENT keys produce two independent receipts and two debits', async () => {
    const first = await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: 200,
      remark: 'SNAPSHOT_A',
      idempotencyKey: 'unit:receipt:distinct:a',
    });
    const second = await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: 200,
      remark: 'SNAPSHOT_B',
      idempotencyKey: 'unit:receipt:distinct:b',
    });

    expect(second.transactionId).not.toBe(first.transactionId);
    expect(await ledgerCount('SNAPSHOT_A')).toBe(1);
    expect(await ledgerCount('SNAPSHOT_B')).toBe(1);
    expect(await receiptCount()).toBe(2);
    expect(await balance()).toBe(CHECKING_START_BALANCE - 400);
  });

  it('(e3) the no-key path stays unreserved: two identical keyless calls both debit', async () => {
    await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: 200, remark: 'NO_KEY' });
    await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: 200, remark: 'NO_KEY' });

    expect(await ledgerCount('NO_KEY')).toBe(2);
    expect(await receiptCount()).toBe(0);
    expect(await balance()).toBe(CHECKING_START_BALANCE - 400);
  });
});

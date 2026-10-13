/**
 * Unit: banking-sdk/transfer — COMMITTED-FACT (execution-receipt) semantics.
 *
 * Proves an already-debited transfer is recognized from PERSISTED facts and never re-resolved
 * through MUTABLE data (a recipient looked up by name):
 *   (a) same key + same request → replays the ORIGINAL result, no second debit;
 *   (b) same key + DIFFERENT request → throws AppError('CONFLICT'), no new debit;
 *   (c) incomplete committed evidence fails closed, while complete receipts survive contact edits;
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
import { centsToMoney, subtractMoney } from '@/lib/money';
import { executionReceiptId, idempotentTransferTxId, requestDigest } from '@/lib/ledger';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

/** Primary CHECKING account every transfer funds from (seed balance ¥23,580). */
const CHECKING = 'acct_checking';
const CHECKING_START_BALANCE = '23580.00';

function db() {
  return getTestPrisma();
}

function transfer(input: TransferInput): Promise<TransferResult> {
  return banking.transfer.createTransfer(input);
}

/** Current CHECKING balance (CNY). */
async function balance(): Promise<string> {
  const account = await db().account.findUniqueOrThrow({ where: { id: CHECKING } });
  return centsToMoney(account.balanceMinor);
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
  it.each(['rename', 'delete'] as const)('replays a complete current receipt after contact %s', async (change) => {
    const key = `unit:receipt:contact:${change}`;
    const input: TransferInput = { userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: key, idempotencyKey: key };
    const original = await transfer(input);
    if (change === 'rename') {
      await db().contact.update({ where: { id: 'contact_zhangwei' }, data: { name: 'Renamed recipient', phone: 'New phone' } });
    } else {
      await db().contact.delete({ where: { id: 'contact_zhangwei' } });
    }
    expect(await transfer(input)).toEqual(original);
    expect(await banking.transfer.getCommittedTransfer(input)).toEqual(original);
    expect(await ledgerCount(key)).toBe(1);
    expect(await balance()).toBe('23380.00');
  });

  it.each(['invalid-json', 'missing-balance', 'wrong-account', 'numeric-amount'] as const)(
    'rejects corrupt receipt result %s without another debit', async (corruption) => {
      const key = `unit:receipt:corrupt:${corruption}`;
      const input: TransferInput = { userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: key, idempotencyKey: key };
      const original = await transfer(input);
      let resultJson: string;
      switch (corruption) {
        case 'invalid-json': resultJson = '{invalid'; break;
        case 'missing-balance': resultJson = JSON.stringify({ ...original, newBalance: undefined }); break;
        case 'wrong-account': resultJson = JSON.stringify({ ...original, sourceAccountId: 'wrong-account' }); break;
        case 'numeric-amount': resultJson = JSON.stringify({ ...original, amount: 200 }); break;
      }
      await db().executionReceipt.update({ where: { userId_key: { userId: DEMO_USER_ID, key } }, data: { resultJson } });
      await expect(transfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(banking.transfer.getCommittedTransfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await ledgerCount(key)).toBe(1);
      expect(await balance()).toBe('23380.00');
    },
  );

  it('rejects a receipt whose ledger is missing without another debit', async () => {
    const key = 'unit:receipt:missing-ledger';
    const input: TransferInput = { userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: key, idempotencyKey: key };
    const original = await transfer(input);
    await db().transaction.delete({ where: { id: original.transactionId } });
    await expect(transfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await ledgerCount(key)).toBe(0);
    expect(await balance()).toBe('23380.00');
  });

  it('rejects the obsolete numeric fingerprint without another debit', async () => {
    const key = 'unit:receipt:legacy:numeric-fingerprint';
    const input: TransferInput = { userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: 'LEGACY_FINGERPRINT', idempotencyKey: key };
    await transfer(input);
    const legacyDigest = requestDigest({
      userId: DEMO_USER_ID, toolName: 'transfer_money', name: null, contactId: 'contact_zhangwei', phone: null,
      amount: 200, sourceAccountId: null, remark: 'LEGACY_FINGERPRINT',
    });
    await db().executionReceipt.update({ where: { userId_key: { userId: DEMO_USER_ID, key } }, data: { requestDigest: legacyDigest } });
    await expect(transfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(banking.transfer.getCommittedTransfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await ledgerCount('LEGACY_FINGERPRINT')).toBe(1);
    expect(await balance()).toBe('23380.00');
  });

  it('(a) same key + same request replays the ORIGINAL result with no second debit', async () => {
    const key = 'unit:receipt:same';
    const input: TransferInput = {
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: '200.00',
      remark: 'REPLAY_SAME',
      idempotencyKey: key,
    };

    const first = await transfer(input);
    const second = await transfer(input);

    // The replayed result is the ORIGINAL snapshot, verbatim.
    expect(second).toEqual(first);
    expect(second.success).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.newBalance).toBe('23380.00');
    expect(second.amount).toBe('200.00');
    expect(second.recipient).toEqual(first.recipient);

    // Exactly ONE debit + ONE ledger row + ONE receipt.
    expect(await ledgerCount('REPLAY_SAME')).toBe(1);
    expect(await receiptCount()).toBe(1);
    expect(await balance()).toBe(subtractMoney(CHECKING_START_BALANCE, '200.00'));
  });

  it('(b) same key + a DIFFERENT request throws CONFLICT and writes no new debit', async () => {
    const key = 'unit:receipt:conflict';
    await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: '200.00',
      remark: 'CONFLICT_BASE',
      idempotencyKey: key,
    });

    // Different amount, same identity.
    const byAmount = await captureError(() =>
      transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '300.00', idempotencyKey: key }),
    );
    expect(byAmount).toBeInstanceOf(AppError);
    expect(byAmount.code).toBe('CONFLICT');
    expect(byAmount.message).toBe('same execution identity, different request');

    // Different recipient, same identity.
    const byRecipient = await captureError(() =>
      transfer({ userId: DEMO_USER_ID, name: '妈妈', amount: '200.00', idempotencyKey: key }),
    );
    expect(byRecipient.code).toBe('CONFLICT');

    // Neither rejection debited the account nor wrote a ledger row / a second receipt.
    expect(await ledgerCount('CONFLICT_BASE')).toBe(1);
    expect(await db().transaction.count({ where: { userId: DEMO_USER_ID, category: '转账', amountMinor: -30_000n } })).toBe(0);
    expect(await receiptCount()).toBe(1);
    expect(await balance()).toBe(subtractMoney(CHECKING_START_BALANCE, '200.00'));
  });
});

describe('banking-sdk/transfer · missing committed receipt', () => {
  it('(c1) a receiptless ledger fails closed after a contact rename', async () => {
    const key = 'unit:receipt:legacy:renamed';
    await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: '200.00',
      remark: 'LEGACY_RENAMED',
      idempotencyKey: key,
    });

    // A missing receipt is incomplete execution evidence, independent of mutable contacts.
    await db().executionReceipt.deleteMany({ where: { userId: DEMO_USER_ID, key } });
    await db().contact.update({ where: { id: 'contact_zhangwei' }, data: { name: '张伟（已更名）' } });

    const input: TransferInput = { userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: 'LEGACY_RENAMED', idempotencyKey: key };
    await expect(transfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(banking.transfer.getCommittedTransfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await ledgerCount('LEGACY_RENAMED')).toBe(1);
    expect(await receiptCount()).toBe(0);
    expect(await balance()).toBe('23380.00');
  });

  it('(c2) a receiptless ledger fails closed after a contact deletion', async () => {
    const key = 'unit:receipt:legacy:removed';
    await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: '200.00',
      remark: 'LEGACY_REMOVED',
      idempotencyKey: key,
    });

    // Missing results must not be reconstructed from ledger fields.
    await db().executionReceipt.deleteMany({ where: { userId: DEMO_USER_ID, key } });
    await db().contact.delete({ where: { id: 'contact_zhangwei' } });

    const input: TransferInput = { userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: 'LEGACY_REMOVED', idempotencyKey: key };
    await expect(transfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(banking.transfer.getCommittedTransfer(input)).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await ledgerCount('LEGACY_REMOVED')).toBe(1);
    expect(await balance()).toBe('23380.00');
  });

  it('(c3) the deterministic ledger row is addressed by the SAME derived identity the SDK wrote', async () => {
    const key = 'unit:receipt:legacy:identity';
    const first = await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: '200.00',
      remark: 'LEGACY_IDENTITY',
      idempotencyKey: key,
    });

    expect(idempotentTransferTxId(DEMO_USER_ID, key)).toBe(first.transactionId);
    const row = await db().transaction.findUniqueOrThrow({ where: { id: idempotentTransferTxId(DEMO_USER_ID, key) } });
    expect(row.amountMinor).toBe(-20_000n);
    expect(demoNow()).toBe(first.occurredAt);
  });
});

describe('banking-sdk/transfer · fresh requests keep their boundaries', () => {
  it('(d) a never-executed transfer with an unknown recipient still throws NOT_FOUND and writes nothing', async () => {
    const key = 'unit:receipt:unknown';
    const error = await captureError(() =>
      transfer({ userId: DEMO_USER_ID, name: '不存在的人', amount: '100.00', idempotencyKey: key }),
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
      amount: '200.00',
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
      amount: '200.00',
      remark: 'SNAPSHOT_A',
      idempotencyKey: 'unit:receipt:distinct:a',
    });
    const second = await transfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: '200.00',
      remark: 'SNAPSHOT_B',
      idempotencyKey: 'unit:receipt:distinct:b',
    });

    expect(second.transactionId).not.toBe(first.transactionId);
    expect(await ledgerCount('SNAPSHOT_A')).toBe(1);
    expect(await ledgerCount('SNAPSHOT_B')).toBe(1);
    expect(await receiptCount()).toBe(2);
    expect(await balance()).toBe(subtractMoney(CHECKING_START_BALANCE, '400.00'));
  });

  it('(e3) the no-key path stays unreserved: two identical keyless calls both debit', async () => {
    await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: 'NO_KEY' });
    await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: 'NO_KEY' });

    expect(await ledgerCount('NO_KEY')).toBe(2);
    expect(await receiptCount()).toBe(0);
    expect(await balance()).toBe(subtractMoney(CHECKING_START_BALANCE, '400.00'));
  });
});

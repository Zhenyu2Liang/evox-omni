/**
 * Unit: banking-sdk/transfer — money-movement execution (execute only; tier policy lives in security/).
 *
 * Targets `@/banking-sdk` → banking.transfer.createTransfer(input)
 * (+ types TransferInput, TransferResult, TransactionView, ContactView from '@/banking-sdk').
 *
 * Reads accounts & contacts and writes DEBIT transactions via Prisma → requires test SQLite
 * via ../../helpers/db. Seed: 李明 checking balance 23580; contacts 张伟/王芳/妈妈/李华.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { ContactView, TransactionView, TransferInput, TransferResult } from '@/banking-sdk';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { centsToMoney, moneyToCents, subtractMoney } from '@/lib/money';
import { getTestPrisma, truncateAll, useFreshDatabase } from '../../helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID, seedDemoData } from '../../helpers/fixtures';

// Fresh seeded DB before each case + disconnect afterwards (registers the Vitest hooks once).
useFreshDatabase();

/** The primary CHECKING account every transfer funds from (seed balance ¥23,580). */
const CHECKING = ACCOUNTS.find((a) => a.id === 'acct_checking');
if (!CHECKING) throw new Error('fixture missing acct_checking');
const CHECKING_START_BALANCE = centsToMoney(moneyToCents(CHECKING.balance));

const ZHANGWEI = CONTACTS.find((c) => c.id === 'contact_zhangwei');
if (!ZHANGWEI) throw new Error('fixture missing contact_zhangwei');

/** Thin wrapper so every case exercises the frozen SDK input/output types. */
function transfer(input: TransferInput): Promise<TransferResult> {
  return banking.transfer.createTransfer(input);
}

/** The user's 转账 (transfer) ledger rows, most recent first — read back through the SDK facade. */
function transferRows(): Promise<TransactionView[]> {
  return banking.transaction.listTransactions(DEMO_USER_ID, { category: '转账' });
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

describe('banking-sdk/transfer · happy path', () => {
  it('transfers ¥200 from the checking account (balance 23580 → 23380), success true, recipient + transactionId returned', async () => {
    const result = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00' });

    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(subtractMoney(CHECKING_START_BALANCE, '200.00'));
    expect(result.newBalance).toBe('23380.00');
    expect(result.recipient.contactId).toBe('contact_zhangwei');
    expect(result.recipient.name).toBe('张伟');
    expect(typeof result.transactionId).toBe('string');
    expect(result.transactionId).not.toBe('');
  });

  it('TransferResult.newBalance = 23380 and occurredAt is set', async () => {
    const result = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00' });

    expect(result.newBalance).toBe('23380.00');
    expect(Number.isFinite(result.occurredAt)).toBe(true);
    // The SDK stamps the demo clock instant (epoch ms).
    expect(result.occurredAt).toBe(demoNow());
  });

  it('writes a DEBIT TRANSFER transaction row readable via banking.transaction', async () => {
    const result = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00' });

    const rows = await transferRows();
    const written = rows.find((row) => row.id === result.transactionId);

    expect(written).toBeDefined();
    expect(written?.direction).toBe('DEBIT');
    expect(written?.amount).toBe('-200.00');
    expect(written?.channel).toBe('TRANSFER');
    expect(written?.merchant).toBe('转账给张伟');
    expect(written?.accountId).toBe('acct_checking');
  });
});

describe('banking-sdk/transfer · recipient resolution', () => {
  it('masks a raw contact phone in the immutable result and replays that original projection', async () => {
    const database = getTestPrisma();
    await database.contact.create({ data: { id: 'contact_raw_phone', userId: DEMO_USER_ID,
      name: 'Raw phone recipient', phone: '13900001122', bank: 'Demo bank' } });
    const input = { userId: DEMO_USER_ID, phone: '13900001122', amount: '200.00', idempotencyKey: 'masked-contact-receipt' };
    const first = await transfer(input);
    expect(first.recipient).toMatchObject({ contactId: 'contact_raw_phone', phone: '139****1122' });
    expect(JSON.stringify(first)).not.toContain('13900001122');
    await database.contact.update({ where: { id: 'contact_raw_phone' }, data: { phone: '13999992233' } });
    expect(await transfer(input)).toEqual(first);
    expect(await database.transaction.count({ where: { counterpartyId: 'contact_raw_phone' } })).toBe(1);
  });
  it('resolves the recipient by contactId (张伟)', async () => {
    const result = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00' });

    expect(result.recipient.contactId).toBe('contact_zhangwei');
    expect(result.recipient.name).toBe('张伟');
    expect(result.recipient.phone).toBe(ZHANGWEI.phone);
  });

  it('resolves the recipient by phone', async () => {
    const result = await transfer({ userId: DEMO_USER_ID, phone: ZHANGWEI.phone, amount: '200.00' });

    expect(result.recipient.contactId).toBe('contact_zhangwei');
    expect(result.recipient.name).toBe('张伟');
    expect(result.recipient.phone).toBe(ZHANGWEI.phone);
  });

  it('resolves the recipient by unique name (妈妈)', async () => {
    const result = await transfer({ userId: DEMO_USER_ID, name: '妈妈', amount: '100.00' });

    expect(result.recipient.contactId).toBe('contact_mama');
    expect(result.recipient.name).toBe('妈妈');
  });

  it("an ambiguous name (two contacts 王芳) → throws AppError('CONFLICT') with detail.candidates listing both", async () => {
    // The default seed ships ONE 王芳; re-seed with the duplicate for this case only.
    await truncateAll();
    await seedDemoData({ withAmbiguousContact: true });

    const error = await captureError(() => transfer({ userId: DEMO_USER_ID, name: '王芳', amount: '100.00' }));

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('CONFLICT');

    const candidates = (error.detail as { candidates: ContactView[] }).candidates;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.map((c) => c.id).sort()).toEqual(['contact_wangfang', 'contact_wangfang_2']);
    expect(candidates.every((c) => c.name === '王芳')).toBe(true);
  });

  it("an unknown recipient (no id/phone/name match) → throws AppError('NOT_FOUND')", async () => {
    const byName = await captureError(() => transfer({ userId: DEMO_USER_ID, name: '不存在的人', amount: '100.00' }));
    expect(byName).toBeInstanceOf(AppError);
    expect(byName.code).toBe('NOT_FOUND');

    const byPhone = await captureError(() => transfer({ userId: DEMO_USER_ID, phone: '100****0000', amount: '100.00' }));
    expect(byPhone.code).toBe('NOT_FOUND');

    const byId = await captureError(() => transfer({ userId: DEMO_USER_ID, contactId: 'contact_missing', amount: '100.00' }));
    expect(byId.code).toBe('NOT_FOUND');
  });
});

describe('banking-sdk/transfer · validation + funds', () => {
  it("insufficient funds (amount > balance) → throws AppError('INSUFFICIENT_FUNDS') and writes no transaction", async () => {
    const before = await transferRows();
    expect(before).toHaveLength(1); // only the seeded tx_sep_transfer_mama 转账 row

    const error = await captureError(() => transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '999999.00' }));

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('INSUFFICIENT_FUNDS');
    expect(error.detail).toMatchObject({ balance: CHECKING_START_BALANCE, amount: '999999.00' });

    // No ledger row written and the funding balance is untouched.
    const after = await transferRows();
    expect(after).toHaveLength(before.length);

    const balance = await banking.account.getBalance(DEMO_USER_ID);
    expect(balance.accounts.find((a) => a.id === 'acct_checking')?.balance).toBe(CHECKING_START_BALANCE);
  });

  it("amount 0 or negative → throws AppError('VALIDATION')", async () => {
    for (const amount of ['0.00', '-50.00']) {
      const error = await captureError(() => transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount }));
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('VALIDATION');
    }
  });

  it("a non-finite amount (NaN / Infinity) → throws AppError('VALIDATION')", async () => {
    for (const amount of ['NaN', 'Infinity', '-Infinity']) {
      const error = await captureError(() => transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount }));
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('VALIDATION');
    }
  });

  it("a missing recipient (no id/phone/name) → throws AppError('VALIDATION')", async () => {
    const missing = await captureError(() => transfer({ userId: DEMO_USER_ID, amount: '100.00' }));
    expect(missing).toBeInstanceOf(AppError);
    expect(missing.code).toBe('VALIDATION');

    // Supplying more than one recipient selector is also rejected ("exactly one of …").
    const both = await captureError(() =>
      transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', phone: ZHANGWEI.phone, amount: '100.00' }),
    );
    expect(both.code).toBe('VALIDATION');
  });
});

describe('banking-sdk/transfer · result fidelity', () => {
  it('spends an exact 0.30 balance in two cent-valid transfers without false insufficient funds', async () => {
    const database = getTestPrisma();
    await database.account.update({ where: { id: 'acct_checking' }, data: { balanceMinor: 30n } });
    const first = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '0.10' });
    const second = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '0.20' });
    expect(first.newBalance).toBe('0.20');
    expect(second.newBalance).toBe('0.00');
    expect((await database.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(0n);
    const rows = await database.transaction.findMany({ where: { id: { in: [first.transactionId!, second.transactionId!] } } });
    expect(rows.reduce((total, row) => total - row.amountMinor, 0n)).toBe(30n);
  });

  it('persists and executes string amounts above the JavaScript safe integer boundary', async () => {
    const database = getTestPrisma();
    await database.account.update({ where: { id: 'acct_checking' }, data: { balanceMinor: 9_007_199_254_740_994n } });
    const result = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '90071992547409.93' });
    expect(result.amount).toBe('90071992547409.93');
    expect(result.newBalance).toBe('0.01');
    expect((await database.transaction.findUniqueOrThrow({ where: { id: result.transactionId } })).amountMinor).toBe(-9_007_199_254_740_993n);
  });

  it('a supplied remark is preserved on the result and the written transaction', async () => {
    const result = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: '房租AA' });

    expect(result.remark).toBe('房租AA');

    const rows = await transferRows();
    const written = rows.find((row) => row.id === result.transactionId);
    expect(written?.remark).toBe('房租AA');
  });

  it('amount is CNY 2-decimal and echoed exactly', async () => {
    const whole = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00' });
    expect(whole.amount).toBe('200.00');
    expect(whole.newBalance).toBe('23380.00');

    // The authorized cent amount is echoed exactly; sub-cent input must not be silently rounded.
    const fractional = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '123.46' });
    expect(fractional.amount).toBe('123.46');

    const rows = await transferRows();
    const written = rows.find((row) => row.id === fractional.transactionId);
    expect(written?.amount).toBe('-123.46');
    const beforeBalance = await banking.account.getBalance(DEMO_USER_ID);
    await expect(transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '123.456' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await transferRows()).toEqual(rows);
    expect(await banking.account.getBalance(DEMO_USER_ID)).toEqual(beforeBalance);
  });

  it('sourceAccountId defaults to the primary CHECKING account when omitted', async () => {
    const result = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00' });

    const rows = await transferRows();
    const written = rows.find((row) => row.id === result.transactionId);
    expect(written?.accountId).toBe('acct_checking');

    // An explicit primary CHECKING id resolves to the same account.
    const explicit = await transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', sourceAccountId: 'acct_checking' });
    const explicitRows = await transferRows();
    expect(explicitRows.find((row) => row.id === explicit.transactionId)?.accountId).toBe('acct_checking');
  });
});

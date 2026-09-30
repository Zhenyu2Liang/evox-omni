/**
 * Unit: banking-sdk/transfer — money-movement execution (execute only; tier policy lives in security/).
 *
 * Targets `@/banking-sdk` → banking.transfer.createTransfer(input)
 * (+ types TransferInput, TransferResult from '@/banking-sdk').
 *
 * Reads accounts & contacts and writes DEBIT transactions via Prisma → requires test SQLite
 * via ../helpers/db. Seed: 李明 checking balance 23580; contacts 张伟/王芳/妈妈/李华.
 */
import { describe, it } from 'vitest';

// import { banking } from '@/banking-sdk';                        // <- uncomment in Phase 2
// import type { TransferInput, TransferResult } from '@/banking-sdk';
// import { AppError } from '@/lib/errors';

describe('banking-sdk/transfer · happy path', () => {
  it.todo('transfers ¥200 from the checking account (balance 23580 → 23380), success true, recipient + transactionId returned');
  it.todo('TransferResult.newBalance = 23380 and occurredAt is set');
  it.todo('writes a DEBIT TRANSFER transaction row readable via banking.transaction');
});

describe('banking-sdk/transfer · recipient resolution', () => {
  it.todo('resolves the recipient by contactId (张伟)');
  it.todo('resolves the recipient by phone');
  it.todo('resolves the recipient by unique name (妈妈)');
  it.todo("an ambiguous name (two contacts 王芳) → throws AppError('CONFLICT') with detail.candidates listing both");
  it.todo("an unknown recipient (no id/phone/name match) → throws AppError('NOT_FOUND')");
});

describe('banking-sdk/transfer · validation + funds', () => {
  it.todo("insufficient funds (amount > balance) → throws AppError('INSUFFICIENT_FUNDS') and writes no transaction");
  it.todo("amount 0 or negative → throws AppError('VALIDATION')");
  it.todo("a non-finite amount (NaN / Infinity) → throws AppError('VALIDATION')");
  it.todo("a missing recipient (no id/phone/name) → throws AppError('VALIDATION')");
});

describe('banking-sdk/transfer · result fidelity', () => {
  it.todo('a supplied remark is preserved on the result and the written transaction');
  it.todo('amount is CNY 2-decimal and echoed exactly');
  it.todo('sourceAccountId defaults to the primary CHECKING account when omitted');
});

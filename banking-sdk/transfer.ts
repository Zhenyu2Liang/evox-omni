/**
 * Banking SDK — money movement (EXECUTE ONLY).
 *
 * The SDK here only validates & executes: it resolves the recipient, checks funds and writes the
 * DEBIT transaction. It does NOT decide permission, confirmation or daily-limit policy — that is
 * the Security Gateway's job (`security/`) and MUST NOT be implemented here.
 *
 * Throws `AppError`:
 *  - `VALIDATION`        — missing/invalid recipient or non-positive amount.
 *  - `NOT_FOUND`         — no contact matches the given id/phone/name.
 *  - `CONFLICT`          — a name matches multiple contacts (`detail.candidates` lists them).
 *  - `INSUFFICIENT_FUNDS`— funding account balance < amount.
 */
import type { Account, Contact } from '@prisma/client';
import { demoNow } from '../lib/clock';
import { accounts, contacts, transactions } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { parseAmount, round2 } from '../lib/money';
import { toContactView } from './contact';
import type { TransferInput, TransferRecipient, TransferResult } from './types';

/** Map a resolved contact row onto the public `TransferRecipient`. */
function toRecipient(contact: Contact): TransferRecipient {
  return {
    contactId: contact.id,
    name: contact.name,
    phone: contact.phone,
    bank: contact.bank ?? undefined,
  };
}

/** Exactly one of `contactId` | `phone` | `name` must be supplied. */
function suppliedRecipientFields(input: TransferInput): Array<'contactId' | 'phone' | 'name'> {
  const fields: Array<'contactId' | 'phone' | 'name'> = [];
  if (input.contactId !== undefined && input.contactId !== '') fields.push('contactId');
  if (input.phone !== undefined && input.phone !== '') fields.push('phone');
  if (input.name !== undefined && input.name !== '') fields.push('name');
  return fields;
}

/** Resolve the recipient row, or throw the matching `AppError`. */
async function resolveRecipient(userId: string, input: TransferInput): Promise<Contact> {
  const provided = suppliedRecipientFields(input);
  if (provided.length !== 1) {
    throw new AppError(
      'VALIDATION',
      `Exactly one of contactId, phone or name must be supplied (received: ${provided.length ? provided.join(', ') : 'none'})`,
    );
  }

  if (input.contactId !== undefined && input.contactId !== '') {
    const row = await contacts.getContact(input.contactId);
    if (!row || row.userId !== userId) {
      throw new AppError('NOT_FOUND', `Recipient contact ${input.contactId} not found`);
    }
    return row;
  }

  if (input.phone !== undefined && input.phone !== '') {
    const phone = input.phone;
    const matches = await contacts.searchContacts(userId, phone);
    const exact = matches.filter((c) => c.phone === phone);
    const pool = exact.length > 0 ? exact : matches.filter((c) => c.phone.includes(phone));
    if (pool.length === 0) throw new AppError('NOT_FOUND', `No contact matches phone ${phone}`);
    if (pool.length > 1) {
      throw new AppError('CONFLICT', `Multiple contacts match phone ${phone}`, {
        candidates: pool.map(toContactView),
      });
    }
    return pool[0];
  }

  const name = input.name as string;
  const matches = await contacts.searchContacts(userId, name);
  const exact = matches.filter((c) => c.name === name);
  if (exact.length === 0) throw new AppError('NOT_FOUND', `No contact matches name ${name}`);
  if (exact.length > 1) {
    throw new AppError('CONFLICT', `Multiple contacts match name ${name}`, {
      candidates: exact.map(toContactView),
    });
  }
  return exact[0];
}

/** Resolve the funding account (explicit `sourceAccountId`, else the primary CHECKING account). */
async function resolveFundingAccount(userId: string, input: TransferInput): Promise<Account> {
  if (input.sourceAccountId !== undefined && input.sourceAccountId !== '') {
    const account = await accounts.getAccount(input.sourceAccountId);
    if (!account || account.userId !== userId) {
      throw new AppError('NOT_FOUND', `Funding account ${input.sourceAccountId} not found`);
    }
    if (account.type !== 'CHECKING') {
      throw new AppError('VALIDATION', `Funding account ${account.id} must be a CHECKING account`);
    }
    return account;
  }
  const account = await accounts.getCheckingAccount(userId);
  if (!account) throw new AppError('NOT_FOUND', `No CHECKING account for user ${userId}`);
  return account;
}

/** Execute a transfer: resolve recipient, verify funds, write the DEBIT transaction. */
export async function createTransfer(input: TransferInput): Promise<TransferResult> {
  const amount = round2(parseAmount(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('VALIDATION', `Transfer amount must be a positive number (received: ${input.amount})`);
  }

  const recipient = await resolveRecipient(input.userId, input);
  const account = await resolveFundingAccount(input.userId, input);

  // Sufficient-funds check BEFORE any write: on failure nothing is persisted.
  if (account.balance < amount) {
    throw new AppError(
      'INSUFFICIENT_FUNDS',
      `Insufficient funds: balance ${account.balance} < amount ${amount}`,
      { balance: account.balance, amount },
    );
  }

  const occurredAt = demoNow();

  // Debit the funding account first, then record the ledger row (demo-adequate atomicity).
  const updated = await accounts.incrementBalance(account.id, -amount);
  const transaction = await transactions.createTransaction({
    accountId: account.id,
    userId: input.userId,
    amount: -amount,
    direction: 'DEBIT',
    category: '转账',
    merchant: '转账给' + recipient.name,
    channel: 'TRANSFER',
    remark: input.remark,
    counterpartyId: recipient.id,
    occurredAt: new Date(occurredAt),
    currency: 'CNY',
  });

  return {
    success: true,
    transactionId: transaction.id,
    newBalance: updated.balance,
    recipient: toRecipient(recipient),
    amount,
    remark: input.remark,
    occurredAt,
  };
}
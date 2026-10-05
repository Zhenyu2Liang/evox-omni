/**
 * Banking SDK — money movement (EXECUTE ONLY).
 *
 * The SDK here only validates & executes: it resolves the recipient, checks funds and writes the
 * DEBIT transaction. It does NOT decide permission, confirmation or daily-limit policy — that is
 * the Security Gateway's job (`security/`) and MUST NOT be implemented here.
 *
 * The debit and the ledger row are written in a SINGLE interactive transaction
 * (`runInTransaction`), so the two either commit together or roll back together: a partial debit
 * can never survive and a concurrent call can never drive the balance negative.
 *
 * Optional at-most-once semantics: when a caller supplies `idempotencyKey`, the ledger row id is
 * derived deterministically from `(userId, key)` and reused as the primary key, so a repeat is
 * rejected by the PK uniqueness and the original row is replayed instead of double-debiting.
 *
 * Throws `AppError`:
 *  - `VALIDATION`        — missing/invalid recipient or non-positive amount.
 *  - `NOT_FOUND`         — no contact matches the given id/phone/name.
 *  - `CONFLICT`          — a name matches multiple contacts (`detail.candidates` lists them).
 *  - `INSUFFICIENT_FUNDS`— funding account balance < amount.
 */
import { createHash } from 'node:crypto';
import type { Account, Contact, Transaction } from '@prisma/client';
import { demoNow } from '../lib/clock';
import { accounts, contacts, transactions } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { parseAmount, round2 } from '../lib/money';
import { toContactView } from './contact';
import { runInTransaction } from './tx';
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

/** Deterministic ledger-row id derived from (userId, idempotencyKey) — the idempotency dedup key. */
function idempotentTransferId(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${userId}\u0000${idempotencyKey}`).digest('hex');
  return `txidem_${digest.slice(0, 32)}`;
}

/** Structural Prisma unique-constraint (P2002) check — avoids importing the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** Build the TransferResult for an idempotent replay from the already-persisted ledger row. */
function replayResult(existing: Transaction, recipient: Contact, newBalance: number): TransferResult {
  return {
    success: true,
    transactionId: existing.id,
    newBalance,
    recipient: toRecipient(recipient),
    amount: Math.abs(existing.amount),
    remark: existing.remark ?? undefined,
    occurredAt: existing.occurredAt.getTime(),
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

/**
 * Execute a transfer: resolve recipient, atomically debit the funds, write the DEBIT ledger row.
 *
 * The debit is a CONDITIONAL `updateMany` (`balance >= amount`). If it matches nothing the transfer
 * is rejected with `INSUFFICIENT_FUNDS` (carrying the current balance) and NOTHING is written — so
 * a negative balance is impossible even under concurrency.
 *
 * When `idempotencyKey` is supplied the call is at-most-once: the ledger row id is deterministic
 * from `(userId, key)`, so a repeat finds and replays the original row (same `transactionId`, no
 * second debit). Concurrent same-key calls are still safe — the loser's insert violates the PK and
 * its transaction rolls back (no debit), then the committed row is replayed.
 */
export async function createTransfer(input: TransferInput): Promise<TransferResult> {
  const amount = round2(parseAmount(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('VALIDATION', `Transfer amount must be a positive number (received: ${input.amount})`);
  }

  const recipient = await resolveRecipient(input.userId, input);
  const account = await resolveFundingAccount(input.userId, input);

  const occurredAt = demoNow();

  const key = input.idempotencyKey?.trim();
  const txId = key ? idempotentTransferId(input.userId, key) : undefined;

  type Outcome =
    | { kind: 'executed'; transactionId: string; newBalance: number }
    | { kind: 'replay'; existing: Transaction; newBalance: number };

  let outcome: Outcome;
  try {
    outcome = await runInTransaction(async (tx): Promise<Outcome> => {
      if (txId !== undefined) {
        const existing = await tx.transaction.findUnique({ where: { id: txId } });
        if (existing) {
          const current = await tx.account.findUnique({ where: { id: account.id } });
          return { kind: 'replay', existing, newBalance: current?.balance ?? 0 };
        }
      }

      // Atomic sufficient-funds check + debit (unchanged behavior).
      const debited = await tx.account.updateMany({
        where: { id: account.id, userId: input.userId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (debited.count === 0) {
        const current = await tx.account.findUnique({ where: { id: account.id } });
        throw new AppError(
          'INSUFFICIENT_FUNDS',
          `Insufficient funds: balance ${current?.balance ?? 0} < amount ${amount}`,
          { balance: current?.balance ?? 0, amount },
        );
      }

      const transaction = await tx.transaction.create({
        data: {
          ...(txId !== undefined ? { id: txId } : {}),
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
        },
      });

      const updated = await tx.account.findUnique({ where: { id: account.id } });
      if (!updated) throw new AppError('NOT_FOUND', `Funding account ${account.id} not found`);
      return { kind: 'executed', transactionId: transaction.id, newBalance: updated.balance };
    });
  } catch (error) {
    // Concurrent same-key race: another call committed the row first → our tx rolled back (no debit).
    if (txId !== undefined && isUniqueViolation(error)) {
      const existing = await transactions.getTransaction(txId);
      if (existing) {
        const account2 = await accounts.getAccount(account.id);
        return replayResult(existing, recipient, account2?.balance ?? 0);
      }
    }
    throw error;
  }

  if (outcome.kind === 'replay') {
    return replayResult(outcome.existing, recipient, outcome.newBalance);
  }

  return {
    success: true,
    transactionId: outcome.transactionId,
    newBalance: outcome.newBalance,
    recipient: toRecipient(recipient),
    amount,
    remark: input.remark,
    occurredAt,
  };
}

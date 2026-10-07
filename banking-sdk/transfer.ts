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
 * COMMITTED-FACT FIRST: the same execution identity also writes an `ExecutionReceipt` (the durable
 * proof that the side effect committed, holding a snapshot of the original result + a canonical
 * digest of the original request) in the SAME transaction as the debit. A replay therefore consults
 * the receipt/ledger BEFORE any MUTABLE lookup (recipient by name, funding account), so an
 * already-debited transfer is recognized from PERSISTED facts and never spuriously re-resolved —
 * while a replay under the same identity but a DIFFERENT request is rejected explicitly (CONFLICT).
 * The digest is ALSO verified INSIDE the write transaction (with the tx client), so even a
 * CONCURRENT interleaving cannot replay the winner's row under a different request: a committed
 * ledger row whose receipt is missing, or whose digest differs, is an explicit CONFLICT; a match
 * replays the receipt's ORIGINAL result VERBATIM (the current request is never spliced onto it).
 *
 * An optional EXECUTION FENCE may be carried on the input (see `./fence`); when present it is
 * awaited INSIDE the write transaction, immediately BEFORE the debit, so a fence that throws rolls
 * the transaction back with NO debit, ledger row or receipt written.
 *
 * Throws `AppError`:
 *  - `VALIDATION`        — missing/invalid recipient or non-positive amount.
 *  - `NOT_FOUND`         — no contact matches the given id/phone/name.
 *  - `CONFLICT`          — a name matches multiple contacts (`detail.candidates` lists them), or a
 *                          replay reuses an execution identity for a different request.
 *  - `INSUFFICIENT_FUNDS`— funding account balance < amount.
 */
import type { Account, Contact, Transaction } from '@prisma/client';
import { demoNow } from '../lib/clock';
import { executionReceiptId, idempotentTransferTxId, requestDigest } from '@/lib/ledger';
import { accounts, contacts, executionReceipts, transactions } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { safeParse, toJson } from '../lib/json';
import { parseAmount, round2 } from '../lib/money';
import { toContactView } from './contact';
import { readExecutionFence } from './fence';
import { isUniqueViolation } from './idempotent';
import { runInTransaction } from './tx';
import { bankingExecutionContext } from './execution-context';
import type { TransferInput, TransferRecipient, TransferResult } from './types';

/** The registered tool name this module records receipts / fingerprints requests against. */
const TRANSFER_TOOL = 'transfer_money';

/** Map a resolved contact row onto the public `TransferRecipient`. */
function toRecipient(contact: Contact): TransferRecipient {
  return {
    contactId: contact.id,
    name: contact.name,
    phone: contact.phone,
    bank: contact.bank ?? undefined,
  };
}

/** Normalize a selector/remark: an absent OR blank string hashes the same as `null`. */
function selector(value: string | undefined): string | null {
  return value !== undefined && value !== '' ? value : null;
}

/** Build the TransferResult for an idempotent replay from the already-persisted ledger row. */
function replayResult(existing: Transaction, recipient: TransferRecipient): TransferResult {
  return {
    success: true,
    transactionId: existing.id,
    recipient,
    amount: Math.abs(existing.amount),
    remark: existing.remark ?? undefined,
    occurredAt: existing.occurredAt.getTime(),
  };
}

/**
 * A MINIMAL recipient reconstructed from PERSISTED ledger fields ONLY — used when the counterparty
 * no longer resolves (renamed/deleted contact). It NEVER invents a contact id/phone: the name is the
 * one the ledger row itself recorded (`merchant` = `转账给<name>`), and an empty phone stays empty.
 */
function ledgerRecipient(existing: Transaction): TransferRecipient {
  const prefix = '转账给';
  const recorded = existing.merchant.startsWith(prefix) ? existing.merchant.slice(prefix.length) : '';
  return { contactId: existing.counterpartyId ?? undefined, name: recorded || '收款人', phone: '' };
}

/**
 * Recognize an ALREADY-COMMITTED transfer for `(userId, key)` from PERSISTED facts, BEFORE any
 * MUTABLE lookup (recipient / funding-account resolution). Returns the replayed `TransferResult`,
 * or `null` when nothing has committed yet.
 *
 *  - an `ExecutionReceipt` for the identity: the request digest MUST match, in which case the
 *    ORIGINAL result snapshot is replayed verbatim; a differing digest is an explicit CONFLICT.
 *  - else a LEGACY deterministic ledger row (debit present, no receipt): recognized as
 *    already-credited and replayed from persisted fields — never re-resolved by name, never a
 *    spurious NOT_FOUND.
 */
async function replayCommitted(userId: string, key: string, digest: string, input: TransferInput): Promise<TransferResult | null> {
  const receipt = await executionReceipts.getExecutionReceipt(userId, key);
  const ledger = await transactions.getTransaction(idempotentTransferTxId(userId, key));
  if (receipt) {
    if (receipt.toolName !== TRANSFER_TOOL || receipt.requestDigest !== digest || !ledger ||
        receipt.txId !== ledger.id || ledger.userId !== userId || ledger.direction !== 'DEBIT' || ledger.channel !== 'TRANSFER') {
      throw new AppError('CONFLICT', 'same execution identity, different request', {
        key,
        expectedDigest: receipt.requestDigest,
        actualDigest: digest,
      });
    }
    const stored = safeParse<TransferResult | null>(receipt.resultJson, null);
    if (stored === null || stored.success !== true || stored.transactionId !== ledger.id ||
        stored.amount !== -ledger.amount || stored.recipient?.contactId !== ledger.counterpartyId) {
      throw new AppError('CONFLICT', `Execution receipt ${receipt.id} cannot be verified; manual reconciliation required`, {
        key,
      });
    }
    return stored;
  }

  const legacy = ledger;
  if (!legacy) return null;
  // Old ledgers have no request digest. Verify every persisted field; never silently replay a
  // different request under the same key, and never resolve the original name through mutable data.
  const selectors = suppliedRecipientFields(input);
  let sameRecipient = selectors.length === 1 && (
    (input.contactId !== undefined && input.contactId === legacy.counterpartyId) ||
    (input.name !== undefined && legacy.merchant === `转账给${input.name}`)
  );
  if (selectors.length === 1 && input.phone !== undefined && legacy.counterpartyId) {
    const contact = await contacts.getContact(legacy.counterpartyId);
    sameRecipient = contact?.userId === userId && contact.phone === input.phone;
  }
  if (legacy.userId !== userId || legacy.direction !== 'DEBIT' || legacy.channel !== 'TRANSFER' ||
      legacy.currency !== 'CNY' || -legacy.amount !== round2(parseAmount(input.amount)) || !sameRecipient ||
      (input.sourceAccountId !== undefined && legacy.accountId !== input.sourceAccountId) ||
      (selector(legacy.remark ?? undefined) !== selector(input.remark))) {
    throw new AppError('CONFLICT', '历史流水无法核验为同一请求，需人工核对', { key, txId: legacy.id });
  }
  const account = await accounts.getAccount(legacy.accountId);
  if (!account || account.userId !== userId) throw new AppError('CONFLICT', '历史流水账户无法核验，需人工核对');
  // A historical post-debit balance is unavailable. Omit it rather than report today's balance.
  return replayResult(legacy, ledgerRecipient(legacy));
}

/** Read committed evidence only. This function never executes or retries a transfer. */
export async function getCommittedTransfer(input: TransferInput): Promise<TransferResult | null> {
  const key = input.idempotencyKey?.trim();
  if (!key) return null;
  const digest = requestDigest({
    userId: input.userId, toolName: TRANSFER_TOOL,
    name: selector(input.name), contactId: selector(input.contactId), phone: selector(input.phone),
    amount: round2(parseAmount(input.amount)), sourceAccountId: selector(input.sourceAccountId), remark: selector(input.remark),
  });
  return replayCommitted(input.userId, key, digest, input);
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
 * Execute a transfer: consult the committed receipt/ledger, then (on a miss) resolve the recipient,
 * atomically debit the funds and write the DEBIT ledger row + the execution receipt.
 *
 * The debit is a CONDITIONAL `updateMany` (`balance >= amount`). If it matches nothing the transfer
 * is rejected with `INSUFFICIENT_FUNDS` (carrying the current balance) and NOTHING is written — so
 * a negative balance is impossible even under concurrency.
 *
 * When `idempotencyKey` is supplied the call is at-most-once: an already-committed identity replays
 * its persisted result (same `transactionId`, no second debit, no mutable re-resolution), while a
 * DIFFERENT request under the same identity is rejected with `CONFLICT`. Concurrent same-key calls
 * are still safe — the loser's insert violates the unique/PK constraint, its transaction rolls back
 * (no debit), and the committed fact is replayed ONLY after its request digest is verified.
 */
export async function createTransfer(input: TransferInput): Promise<TransferResult> {
  const amount = round2(parseAmount(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('VALIDATION', `Transfer amount must be a positive number (received: ${input.amount})`);
  }

  const key = input.idempotencyKey?.trim();
  const fence = readExecutionFence(input);
  const txId = key ? idempotentTransferTxId(input.userId, key) : undefined;
  const digest = requestDigest({
    userId: input.userId,
    toolName: TRANSFER_TOOL,
    name: selector(input.name),
    contactId: selector(input.contactId),
    phone: selector(input.phone),
    amount,
    sourceAccountId: selector(input.sourceAccountId),
    remark: selector(input.remark),
  });

  // COMMITTED-FACT FAST PATH — consulted BEFORE any MUTABLE lookup, so an already-debited transfer is
  // recognized from persisted facts and never re-resolved through data (the recipient by name) that
  // may have changed since the side effect committed.
  if (key !== undefined) {
    const committed = await replayCommitted(input.userId, key, digest, input);
    if (committed) return committed;
  }

  const recipient = await resolveRecipient(input.userId, input);
  const account = await resolveFundingAccount(input.userId, input);

  const occurredAt = demoNow();

  type Outcome =
    | { kind: 'executed'; transactionId: string; newBalance: number }
    | { kind: 'replayed'; result: TransferResult };

  let outcome: Outcome;
  try {
    outcome = await runInTransaction(async (tx): Promise<Outcome> => {
      if (txId !== undefined && key !== undefined) {
        const existing = await tx.transaction.findUnique({ where: { id: txId } });
        if (existing) {
          // A committed ledger row under this identity is a replay ONLY when the persisted receipt
          // proves it is the SAME request — the receipt is read with the SAME tx client and its
          // ORIGINAL result is returned VERBATIM. A missing receipt (or a differing digest) is an
          // explicit CONFLICT: the current request's recipient/amount is never spliced onto the
          // winner's row.
          const receipt = await executionReceipts.getExecutionReceipt(input.userId, key, tx);
          if (!receipt) {
            throw new AppError('CONFLICT', 'same execution identity, different request', { key, txId });
          }
          if (receipt.requestDigest !== digest) {
            throw new AppError('CONFLICT', 'same execution identity, different request', {
              key,
              expectedDigest: receipt.requestDigest,
              actualDigest: digest,
            });
          }
          const stored = safeParse<TransferResult | null>(receipt.resultJson, null);
          if (stored === null) {
            throw new AppError('INTERNAL', `Execution receipt ${receipt.id} has an unreadable result`, {
              key,
            });
          }
          return { kind: 'replayed', result: stored };
        }
      }

      // SERVER-GENERATED execution fence: awaited INSIDE this write transaction, immediately BEFORE
      // the business write, so a fence that throws rolls the transaction back with NO side effect.
      await fence?.(tx);

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

      // Persist the EXECUTION RECEIPT in the SAME transaction as the debit + ledger row, so the
      // committed fact (original result snapshot + request fingerprint) is durable the instant the
      // side effect exists — a later replay returns it verbatim instead of re-resolving mutable data.
      const snapshot: TransferResult = {
        success: true,
        transactionId: transaction.id,
        newBalance: updated.balance,
        recipient: toRecipient(recipient),
        amount,
        remark: input.remark,
        occurredAt,
      };
      if (key !== undefined) {
        await executionReceipts.putExecutionReceipt(
          {
            id: executionReceiptId(input.userId, key),
            userId: input.userId,
            key,
            toolName: TRANSFER_TOOL,
            requestDigest: digest,
            resultJson: toJson(snapshot),
            txId: transaction.id,
          },
          tx,
        );
      }

      // A required audit failure aborts this very transaction: no debit, ledger or receipt survives.
      await bankingExecutionContext()?.onTransferCommit?.(tx, snapshot);

      return { kind: 'executed', transactionId: transaction.id, newBalance: updated.balance };
    });
  } catch (error) {
    // Concurrent same-key race: another call committed the row/receipt first → our tx rolled back
    // (no debit). The committed fact is replayed ONLY through `replayCommitted`, which verifies the
    // request digest and throws CONFLICT on a mismatch — the catch NEVER guesses a replay for an
    // unverified ledger row.
    if (txId !== undefined && key !== undefined && isUniqueViolation(error)) {
      const committed = await replayCommitted(input.userId, key, digest, input);
      if (committed) return committed;
    }
    throw error;
  }

  if (outcome.kind === 'replayed') {
    return outcome.result;
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

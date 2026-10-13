/**
 * Banking SDK — account reads. GREEN tier (auto-execute, no confirmation).
 * Persists nothing; reads via `lib/db/repositories`.
 */
import type { Account } from '@prisma/client';
import { demoNow } from '../lib/clock';
import { accounts } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { centsToMoney } from '../lib/money';
import { runInTransaction } from './tx';
import type { AccountType, AccountView, BalanceView } from './types';

/** Map a persisted `Account` row onto the public `AccountView` view model. */
function toAccountView(row: Account): AccountView {
  return {
    id: row.id,
    type: row.type as AccountType,
    name: row.name,
    // The seed already stores a masked value (e.g. `****8821`).
    numberMasked: row.number,
    balance: centsToMoney(row.balanceMinor),
    currency: row.currency,
  };
}

/** Total available balance plus per-account breakdown for the user. */
export async function getBalance(userId: string): Promise<BalanceView> {
  return runInTransaction(async () => {
    const rows = await accounts.listAccounts(userId);
    return {
      totalAvailable: centsToMoney(rows.reduce((total, row) => total + row.balanceMinor, 0n)),
      currency: 'CNY',
      accounts: rows.map(toAccountView),
      asOf: demoNow(),
    };
  });
}

/** All accounts owned by the user. */
export async function getAccounts(userId: string): Promise<AccountView[]> {
  const rows = await accounts.listAccounts(userId);
  return rows.map(toAccountView);
}

/** A single account by id. Throws `AppError('NOT_FOUND')` when missing. */
export async function getAccountById(id: string): Promise<AccountView> {
  const row = await accounts.getAccount(id);
  if (!row) throw new AppError('NOT_FOUND', `Account ${id} not found`);
  return toAccountView(row);
}

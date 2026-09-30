/**
 * Banking SDK — account reads. GREEN tier (auto-execute, no confirmation).
 * Persists nothing; reads via `lib/db/repositories`.
 */
import type { AccountView, BalanceView } from './types';

/** Total available balance plus per-account breakdown for the user. */
export async function getBalance(userId: string): Promise<BalanceView> {
  throw new Error('not implemented');
}

/** All accounts owned by the user. */
export async function getAccounts(userId: string): Promise<AccountView[]> {
  throw new Error('not implemented');
}

/** A single account by id. Throws `AppError('NOT_FOUND')` when missing. */
export async function getAccountById(id: string): Promise<AccountView> {
  throw new Error('not implemented');
}

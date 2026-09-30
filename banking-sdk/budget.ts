/**
 * Banking SDK — budget reservations. `listBudgets` is a GREEN read; `reserveBudget` / `releaseBudget`
 * execute only (tier policy lives in `security/`).
 */
import type { BudgetView, ReserveBudgetInput } from './types';

/** Reserve a budget envelope; returns the created budget. */
export async function reserveBudget(input: ReserveBudgetInput): Promise<BudgetView> {
  throw new Error('not implemented');
}

/** All budgets owned by the user. */
export async function listBudgets(userId: string): Promise<BudgetView[]> {
  throw new Error('not implemented');
}

/** Release a reserved budget (status → RELEASED); returns the updated budget. */
export async function releaseBudget(id: string): Promise<BudgetView> {
  throw new Error('not implemented');
}

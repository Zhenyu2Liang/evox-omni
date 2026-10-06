/**
 * Banking SDK — budget reservations. `listBudgets` is a GREEN read; `reserveBudget` / `releaseBudget`
 * execute only (tier policy lives in `security/`).
 *
 * `reserveBudget` accepts an OPTIONAL `idempotencyKey`: a repeat with the SAME key replays the
 * already-persisted reservation instead of creating a second row (see `./idempotent.ts`).
 */
import type { Budget } from '@prisma/client';
import { budgets } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { createIdempotent, normalizeIdempotencyKey } from './idempotent';
import type { BudgetStatus, BudgetView, ReserveBudgetInput } from './types';

/** Maps a `Budget` row to its public view model. */
function toBudgetView(row: Budget): BudgetView {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    purpose: row.purpose ?? undefined,
    status: row.status as BudgetStatus,
    dueDate: row.dueDate?.getTime() ?? undefined,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Reserve a budget envelope; returns the created budget.
 *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, a repeated call with the
 * SAME key replays the persisted reservation (same `id`, no second row). Absent → unchanged behavior.
 */
export async function reserveBudget(input: ReserveBudgetInput): Promise<BudgetView> {
  if (!(input.amount > 0)) {
    throw new AppError('VALIDATION', '预算金额必须大于 0', { amount: input.amount });
  }

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (key !== undefined) {
    const replayed = await createIdempotent<Budget>({
      key,
      find: (tx) => tx.budget.findUnique({ where: { idempotencyKey: key } }),
      create: (tx, replayKey) =>
        tx.budget.create({
          data: {
            userId: input.userId,
            name: input.name,
            amount: input.amount,
            purpose: input.purpose,
            status: 'RESERVED',
            dueDate: input.dueDate !== undefined ? new Date(input.dueDate) : undefined,
            idempotencyKey: replayKey,
          },
        }),
    });
    return toBudgetView(replayed);
  }

  const row = await budgets.createBudget({
    userId: input.userId,
    name: input.name,
    amount: input.amount,
    purpose: input.purpose,
    status: 'RESERVED',
    dueDate: input.dueDate !== undefined ? new Date(input.dueDate) : undefined,
  });
  return toBudgetView(row);
}

/** All budgets owned by the user. */
export async function listBudgets(userId: string): Promise<BudgetView[]> {
  const rows = await budgets.listBudgets(userId);
  return rows.map(toBudgetView);
}

/** Release a reserved budget (status → RELEASED); returns the updated budget. */
export async function releaseBudget(id: string): Promise<BudgetView> {
  const existing = await budgets.getBudget(id);
  if (existing === null) {
    throw new AppError('NOT_FOUND', `预算不存在：${id}`, { id });
  }

  const row = await budgets.updateBudgetStatus(id, 'RELEASED');
  return toBudgetView(row);
}

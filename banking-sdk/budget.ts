/**
 * Banking SDK — budget reservations. `listBudgets` is a GREEN read; `reserveBudget` / `releaseBudget`
 * execute only (tier policy lives in `security/`).
 *
 * `reserveBudget` accepts an OPTIONAL `idempotencyKey`: a repeat by the SAME user/key replays the
 * already-persisted reservation instead of creating a second row (see `./idempotent.ts`).
 */
import type { Budget } from '@prisma/client';
import { budgets } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { readExecutionFence } from './fence';
import { createIdempotent, normalizeIdempotencyKey } from './idempotent';
import { runInTransaction } from './tx';
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
 * The persisted columns shared by the plain repository insert and the in-transaction insert, so the
 * unfenced and fenced paths always write the identical row.
 */
function reservationData(input: ReserveBudgetInput): {
  userId: string;
  name: string;
  amount: number;
  purpose?: string;
  status: string;
  dueDate?: Date;
} {
  return {
    userId: input.userId,
    name: input.name,
    amount: input.amount,
    purpose: input.purpose,
    status: 'RESERVED',
    dueDate: input.dueDate !== undefined ? new Date(input.dueDate) : undefined,
  };
}

/**
 * Reserve a budget envelope; returns the created budget.
 *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, a repeated call with the
 * SAME user/key replays the persisted reservation (same `id`, no second row). Another user's local
 * key is independent. Absent → unchanged behavior.
 *
 * An optional execution fence MAY be carried on `input` (see `./fence`); when present it is awaited
 * INSIDE the write transaction, immediately BEFORE the insert — a fence that throws rolls the
 * transaction back with NO budget row written.
 */
export async function reserveBudget(input: ReserveBudgetInput): Promise<BudgetView> {
  if (!(input.amount > 0)) {
    throw new AppError('VALIDATION', '预算金额必须大于 0', { amount: input.amount });
  }

  const fence = readExecutionFence(input);
  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (key !== undefined) {
    const replayed = await createIdempotent<Budget>({
      key,
      fence,
      // This callback is also used by createIdempotent's unique-conflict fallback. Both reads
      // resolve only this owner's execution identity; a foreign row can never be replayed.
      find: (tx) => tx.budget.findUnique({ where: {
        userId_idempotencyKey: { userId: input.userId, idempotencyKey: key },
      } }),
      create: (tx, replayKey) =>
        tx.budget.create({ data: { ...reservationData(input), idempotencyKey: replayKey } }),
    });
    return toBudgetView(replayed);
  }

  // Fenced insert (no key): the fence and the insert share ONE transaction, so a throwing fence
  // commits nothing. Without a fence, keep the plain repository write unchanged.
  if (fence !== undefined) {
    const row = await runInTransaction(async (tx) => {
      await fence(tx);
      return tx.budget.create({ data: reservationData(input) });
    });
    return toBudgetView(row);
  }

  const row = await runInTransaction((tx) => tx.budget.create({ data: reservationData(input) }));
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

  const row = await runInTransaction((tx) => tx.budget.update({ where: { id }, data: { status: 'RELEASED' } }));
  return toBudgetView(row);
}

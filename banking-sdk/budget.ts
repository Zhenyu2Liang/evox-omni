/**
 * Banking SDK — budget reservations. `listBudgets` is a GREEN read; `reserveBudget` / `releaseBudget`
 * execute only (tier policy lives in `security/`).
 *
 * `reserveBudget` accepts an OPTIONAL `idempotencyKey`: a repeat by the SAME user/key replays the
 * already-persisted reservation instead of creating a second row (see `./idempotent.ts`).
 *
 * AUDIT (by SIDE EFFECT, not by permission colour): `reserveBudget` is a GREEN tool that writes, so
 * its insert is audited through the execution context's `onWriteCommit` hook — awaited INSIDE the very
 * same transaction, so a failing audit rolls the reservation back and the write can never be committed
 * un-audited. A REPLAY (the keyed row already exists, or the unique-conflict fallback re-read) writes
 * nothing and therefore audits nothing: no duplicate side effect, no duplicate audit.
 */
import type { Budget } from '@/lib/db/prisma';
import { budgets } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { centsToMoney, moneyToCents } from '../lib/money';
import { bankingExecutionContext } from './execution-context';
import { createIdempotent, normalizeIdempotencyKey } from './idempotent';
import { runInTransaction, type Tx } from './tx';
import type { BudgetStatus, BudgetView, ReserveBudgetInput } from './types';

/** Maps a `Budget` row to its public view model. */
function toBudgetView(row: Budget): BudgetView {
  return {
    id: row.id,
    name: row.name,
    amount: centsToMoney(row.amountMinor),
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
  amountMinor: bigint;
  purpose?: string;
  status: string;
  dueDate?: Date;
} {
  return {
    userId: input.userId,
    name: input.name,
    amountMinor: moneyToCents(input.amount),
    purpose: input.purpose,
    status: 'RESERVED',
    dueDate: input.dueDate !== undefined ? new Date(input.dueDate) : undefined,
  };
}

/**
 * Record the reservation's SIDE EFFECT in the enclosing transaction (no-op when no trusted audit
 * context is installed — a bare SDK call is not an agent write).
 */
async function auditReservation(
  tx: Tx,
  identity: string,
  input: ReserveBudgetInput,
  data: BudgetView,
): Promise<void> {
  const onWriteCommit = bankingExecutionContext()?.onWriteCommit;
  if (onWriteCommit === undefined) return;
  await onWriteCommit(tx, {
    toolName: 'reserve_budget',
    identity,
    args: {
      userId: input.userId,
      name: input.name,
      amount: data.amount,
      purpose: input.purpose,
      dueDate: input.dueDate,
      idempotencyKey: input.idempotencyKey,
    },
    data,
  });
}

/**
 * Reserve a budget envelope; returns the created budget.
 *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, a repeated call with the
 * SAME user/key replays the persisted reservation (same `id`, no second row). Another user's local
 * key is independent. Absent → unchanged behavior.
 *
 * The trusted invocation context provides the write fence inside the transaction.
 */
export async function reserveBudget(input: ReserveBudgetInput): Promise<BudgetView> {
  if (typeof input.userId !== 'string' || !input.userId.trim()) {
    throw new AppError('SECURITY_DENIED', 'A budget requires a trusted owner identity.');
  }
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new AppError('VALIDATION', 'A budget name must be non-empty.');
  }
  if (input.purpose !== undefined && typeof input.purpose !== 'string') {
    throw new AppError('VALIDATION', 'Budget purpose must be text.');
  }
  if (input.dueDate !== undefined && (!Number.isSafeInteger(input.dueDate) ||
      !Number.isFinite(new Date(input.dueDate).getTime()))) {
    throw new AppError('VALIDATION', 'Budget due date must be a valid integer epoch.');
  }
  if (moneyToCents(input.amount) <= 0n) {
    throw new AppError('VALIDATION', '预算金额必须大于 0', { amount: input.amount });
  }

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (key !== undefined) {
    const replayed = await createIdempotent<Budget>({
      key,
      // This callback is also used by createIdempotent's unique-conflict fallback. Both reads
      // resolve only this owner's execution identity; a foreign row can never be replayed.
      find: async (tx) => {
        const existing = await tx.budget.findUnique({ where: {
          userId_idempotencyKey: { userId: input.userId, idempotencyKey: key },
        } });
        if (existing && (existing.amountMinor !== moneyToCents(input.amount) || existing.name !== input.name ||
          existing.purpose !== (input.purpose ?? null) || (existing.dueDate?.getTime() ?? null) !== (input.dueDate ?? null))) {
          throw new AppError('CONFLICT', 'The execution identity belongs to a different budget envelope.');
        }
        return existing;
      },
      create: async (tx, replayKey) => {
        const created = await tx.budget.create({
          data: { ...reservationData(input), idempotencyKey: replayKey },
        });
        // Reached ONLY on a real insert: a replay returns from `find` (or the P2002 fallback re-read)
        // and never lands here, so the audit is written at most once per execution identity.
        await auditReservation(tx, `key:${replayKey}`, input, toBudgetView(created));
        return created;
      },
    });
    return toBudgetView(replayed);
  }

  const row = await runInTransaction(async (tx) => {
    const created = await tx.budget.create({ data: reservationData(input) });
    await auditReservation(tx, `row:${created.id}`, input, toBudgetView(created));
    return created;
  });
  return toBudgetView(row);
}

/** All budgets owned by the user. */
export async function listBudgets(userId: string): Promise<BudgetView[]> {
  const rows = await budgets.listBudgets(userId);
  return rows.map(toBudgetView);
}

/** Release a reserved budget (status → RELEASED); returns the updated budget. */
export async function releaseBudget(id: string, userId: string): Promise<BudgetView> {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new AppError('SECURITY_DENIED', 'Budget release requires a trusted owner identity.');
  }
  const row = await runInTransaction(async tx => {
    const existing = await tx.budget.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) throw new AppError('NOT_FOUND', 'Budget does not exist.', { id });
    if (existing.status === 'RELEASED') return existing;
    if (existing.status !== 'RESERVED') throw new AppError('CONFLICT', 'Only a reserved budget can be released.');
    return tx.budget.update({ where: { id, userId, status: 'RESERVED' }, data: { status: 'RELEASED' } });
  });
  return toBudgetView(row);
}

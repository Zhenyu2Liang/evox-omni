import type { Budget } from '@prisma/client';
import { dbClient } from '../client';
import { moneyToCents, type MoneyInput } from '../../money';

export function listBudgets(userId: string, status?: string): Promise<Budget[]> {
  return dbClient().budget.findMany({
    where: { userId, ...(status !== undefined ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export function getBudget(id: string): Promise<Budget | null> {
  return dbClient().budget.findUnique({ where: { id } });
}

export function createBudget(input: { userId: string; name: string; amount: MoneyInput; purpose?: string | null; status?: string; dueDate?: Date | null }): Promise<Budget> {
  return dbClient().budget.create({
    data: {
      userId: input.userId,
      name: input.name,
      amountMinor: moneyToCents(input.amount),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    },
  });
}

export function updateBudgetStatus(id: string, status: string): Promise<Budget> {
  return dbClient().budget.update({
    where: { id },
    data: { status },
  });
}

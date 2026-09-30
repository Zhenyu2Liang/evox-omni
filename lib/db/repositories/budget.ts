import type { Budget } from '@prisma/client';

export function listBudgets(userId: string, status?: string): Promise<Budget[]> {
  throw new Error('not implemented');
}

export function getBudget(id: string): Promise<Budget | null> {
  throw new Error('not implemented');
}

export function createBudget(input: { userId: string; name: string; amount: number; purpose?: string | null; status?: string; dueDate?: Date | null }): Promise<Budget> {
  throw new Error('not implemented');
}

export function updateBudgetStatus(id: string, status: string): Promise<Budget> {
  throw new Error('not implemented');
}

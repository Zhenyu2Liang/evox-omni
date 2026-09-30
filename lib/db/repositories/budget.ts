import type { Budget } from '@prisma/client';
import { prisma } from '../client';

export function listBudgets(userId: string, status?: string): Promise<Budget[]> {
  return prisma.budget.findMany({
    where: { userId, ...(status !== undefined ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export function getBudget(id: string): Promise<Budget | null> {
  return prisma.budget.findUnique({ where: { id } });
}

export function createBudget(input: { userId: string; name: string; amount: number; purpose?: string | null; status?: string; dueDate?: Date | null }): Promise<Budget> {
  return prisma.budget.create({
    data: {
      userId: input.userId,
      name: input.name,
      amount: input.amount,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    },
  });
}

export function updateBudgetStatus(id: string, status: string): Promise<Budget> {
  return prisma.budget.update({
    where: { id },
    data: { status },
  });
}

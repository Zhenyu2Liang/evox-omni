import type { Card, CardLimit } from '@prisma/client';
import { prisma } from '../client';

export function listCards(userId: string): Promise<Card[]> {
  return prisma.card.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });
}

export function getCard(id: string): Promise<Card | null> {
  return prisma.card.findUnique({ where: { id } });
}

export function getCardByIdForUser(userId: string, id: string): Promise<Card | null> {
  return prisma.card.findFirst({ where: { id, userId } });
}

export function createCard(input: { userId: string; type: string; network?: string; numberMasked: string; status?: string; creditLimit?: number | null; availableLimit?: number | null; monthlyLimit?: number | null }): Promise<Card> {
  return prisma.card.create({
    data: {
      userId: input.userId,
      type: input.type,
      ...(input.network !== undefined ? { network: input.network } : {}),
      numberMasked: input.numberMasked,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit } : {}),
      ...(input.availableLimit !== undefined ? { availableLimit: input.availableLimit } : {}),
      ...(input.monthlyLimit !== undefined ? { monthlyLimit: input.monthlyLimit } : {}),
    },
  });
}

export function updateCardStatus(id: string, status: string): Promise<Card> {
  return prisma.card.update({
    where: { id },
    data: { status },
  });
}

export function updateCardLimits(id: string, input: { creditLimit?: number | null; availableLimit?: number | null; monthlyLimit?: number | null }): Promise<Card> {
  return prisma.card.update({
    where: { id },
    data: {
      ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit } : {}),
      ...(input.availableLimit !== undefined ? { availableLimit: input.availableLimit } : {}),
      ...(input.monthlyLimit !== undefined ? { monthlyLimit: input.monthlyLimit } : {}),
    },
  });
}

export function listCardLimits(cardId: string): Promise<CardLimit[]> {
  return prisma.cardLimit.findMany({
    where: { cardId },
    orderBy: { id: 'asc' },
  });
}

export function setCardCategoryLimit(input: { cardId: string; category: string; amount: number }): Promise<CardLimit> {
  return prisma.cardLimit.create({
    data: {
      cardId: input.cardId,
      category: input.category,
      amount: input.amount,
    },
  });
}

/** Deletes all per-category limits for a card+category; returns the deleted count. */
export async function deleteCardCategoryLimits(cardId: string, category: string): Promise<number> {
  const result = await prisma.cardLimit.deleteMany({ where: { cardId, category } });
  return result.count;
}

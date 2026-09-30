import type { Card, CardLimit } from '@prisma/client';

export function listCards(userId: string): Promise<Card[]> {
  throw new Error('not implemented');
}

export function getCard(id: string): Promise<Card | null> {
  throw new Error('not implemented');
}

export function getCardByIdForUser(userId: string, id: string): Promise<Card | null> {
  throw new Error('not implemented');
}

export function createCard(input: { userId: string; type: string; network?: string; numberMasked: string; status?: string; creditLimit?: number | null; availableLimit?: number | null; monthlyLimit?: number | null }): Promise<Card> {
  throw new Error('not implemented');
}

export function updateCardStatus(id: string, status: string): Promise<Card> {
  throw new Error('not implemented');
}

export function updateCardLimits(id: string, input: { creditLimit?: number | null; availableLimit?: number | null; monthlyLimit?: number | null }): Promise<Card> {
  throw new Error('not implemented');
}

export function listCardLimits(cardId: string): Promise<CardLimit[]> {
  throw new Error('not implemented');
}

export function setCardCategoryLimit(input: { cardId: string; category: string; amount: number }): Promise<CardLimit> {
  throw new Error('not implemented');
}

/** Deletes all per-category limits for a card+category; returns the deleted count. */
export function deleteCardCategoryLimits(cardId: string, category: string): Promise<number> {
  throw new Error('not implemented');
}

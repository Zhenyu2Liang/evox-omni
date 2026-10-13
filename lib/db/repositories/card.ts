import type { Card, CardLimit } from '@prisma/client';
import { dbClient } from '../client';
import { moneyToCents, type MoneyInput } from '../../money';

type CardMoneyInput = { creditLimit?: MoneyInput | null; availableLimit?: MoneyInput | null; monthlyLimit?: MoneyInput | null };

function limitColumns(input: CardMoneyInput) {
  return {
    ...(input.creditLimit !== undefined ? { creditLimitMinor: input.creditLimit === null ? null : moneyToCents(input.creditLimit) } : {}),
    ...(input.availableLimit !== undefined ? { availableLimitMinor: input.availableLimit === null ? null : moneyToCents(input.availableLimit) } : {}),
    ...(input.monthlyLimit !== undefined ? { monthlyLimitMinor: input.monthlyLimit === null ? null : moneyToCents(input.monthlyLimit) } : {}),
  };
}

export function listCards(userId: string): Promise<Card[]> {
  return dbClient().card.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });
}

export function getCard(id: string): Promise<Card | null> {
  return dbClient().card.findUnique({ where: { id } });
}

export function getCardByIdForUser(userId: string, id: string): Promise<Card | null> {
  return dbClient().card.findFirst({ where: { id, userId } });
}

export function createCard(input: { userId: string; type: string; network?: string; numberMasked: string; status?: string } & CardMoneyInput): Promise<Card> {
  return dbClient().card.create({
    data: {
      userId: input.userId,
      type: input.type,
      ...(input.network !== undefined ? { network: input.network } : {}),
      numberMasked: input.numberMasked,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...limitColumns(input),
    },
  });
}

export function updateCardStatus(id: string, status: string): Promise<Card> {
  return dbClient().card.update({
    where: { id },
    data: { status },
  });
}

export function updateCardLimits(id: string, input: CardMoneyInput): Promise<Card> {
  return dbClient().card.update({
    where: { id },
    data: limitColumns(input),
  });
}

export function listCardLimits(cardId: string): Promise<CardLimit[]> {
  return dbClient().cardLimit.findMany({
    where: { cardId },
    orderBy: { id: 'asc' },
  });
}

export function setCardCategoryLimit(input: { cardId: string; category: string; amount: MoneyInput }): Promise<CardLimit> {
  return dbClient().cardLimit.create({
    data: {
      cardId: input.cardId,
      category: input.category,
      amountMinor: moneyToCents(input.amount),
    },
  });
}

/** Deletes all per-category limits for a card+category; returns the deleted count. */
export async function deleteCardCategoryLimits(cardId: string, category: string): Promise<number> {
  const result = await dbClient().cardLimit.deleteMany({ where: { cardId, category } });
  return result.count;
}

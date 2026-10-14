import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {
  card: { findMany: vi.fn(async () => [{ id: 'card-credit', numberMasked: '****6688', type: 'CREDIT' }]) },
  investmentProduct: { findMany: vi.fn(async () => [{ id: 'product-one', name: 'Stable Savings', code: 'ABC001' }]) },
} }));

import { resolveBankingArgs } from '@/lib/banking-selectors';

describe('banking identity fields', () => {
  it('binds the exact card ID', async () => {
    expect(await resolveBankingArgs('owner', 'freeze_card', { cardId: 'card-credit' })).toEqual({ cardId: 'card-credit' });
  });

  it.each(['6688', '****6688', 'CREDIT', 'CARD-CREDIT'])('does not interpret the card ID as an alias %s', async cardId => {
    await expect(resolveBankingArgs('owner', 'freeze_card', { cardId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['Stable Savings', 'ABC001'])('does not interpret a product ID as a label %s', async productId => {
    await expect(resolveBankingArgs('owner', 'subscribe_investment', { productId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

import { banking } from '@/banking-sdk';
import { prisma } from '@/lib/db/client';

process.send?.({ ready: true });
process.once('message', async (input: { mode: string; index: number }) => {
  try {
    const result = input.mode === 'category'
      ? await banking.card.consumeCard({ userId: 'user_liming', cardId: 'card_debit', category: '餐饮', amount: '60.00', executionKey: `multi-${input.index}` })
      : await banking.transfer.createTransfer({ userId: 'user_liming', contactId: 'contact_zhangwei', amount: '60.00',
        idempotencyKey: input.mode === 'same' ? 'multi-shared' : `multi-${input.index}` });
    process.send?.({ done: true, ok: true, result });
  } catch (error) {
    process.send?.({ done: true, ok: false, code: (error as { code?: string }).code });
  } finally { await prisma.$disconnect(); process.disconnect?.(); }
});

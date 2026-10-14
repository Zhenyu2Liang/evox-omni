import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '@/lib/db/database';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

describe('Prisma 7 native SQLite adapter guarantees', () => {
  it('round-trips booked integers beyond JavaScript safe range and preserves decimal text and timestamps', async () => {
    const prisma = getTestPrisma();
    const amount = 9007199254740993n;
    await prisma.account.update({ where: { id: 'acct_checking' }, data: { balanceMinor: amount } });
    await prisma.investmentProduct.update({ where: { id: 'prod_wenjiana' }, data: { annualYieldRate: '0.12345678901234567890123456789' } });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    expect(account.balanceMinor).toBe(amount);
    const negative = await prisma.transaction.create({ data: { id: 'native_exact', userId: account.userId,
      accountId: account.id, amountMinor: -amount, currency: 'CNY', direction: 'DEBIT', category: 'Transfer',
      merchant: 'Exact integer fixture', occurredAt: new Date('2026-10-14T01:02:03.456Z') } });
    const client = createDatabaseClient(process.env.DATABASE_URL);
    try {
      const restored = await client.transaction.findUniqueOrThrow({ where: { id: negative.id } });
      expect(restored.amountMinor).toBe(-amount);
      expect(restored.occurredAt.toISOString()).toBe('2026-10-14T01:02:03.456Z');
      const product = await client.investmentProduct.findUniqueOrThrow({ where: { id: 'prod_wenjiana' } });
      expect(product.annualYieldRate).toBe('0.12345678901234567890123456789');
    } finally { await client.$disconnect(); }
  });

  it('rolls back a booked debit and receipt together when a transaction fails', async () => {
    const prisma = getTestPrisma();
    const before = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    await expect(prisma.$transaction(async tx => {
      await tx.account.update({ where: { id: before.id }, data: { balanceMinor: { decrement: 12345n } } });
      await tx.executionReceipt.create({ data: { id: 'native_rollback', key: 'native:rollback',
        toolName: 'transfer_money', userId: before.userId, requestDigest: 'native-fixture', resultJson: '{}' } });
      throw new Error('Simulated commit failure');
    })).rejects.toThrow('Simulated commit failure');
    expect((await prisma.account.findUniqueOrThrow({ where: { id: before.id } })).balanceMinor).toBe(before.balanceMinor);
    expect(await prisma.executionReceipt.findUnique({ where: { id: 'native_rollback' } })).toBeNull();
  });

  it('serializes concurrent interactive mutations without losing exact integer increments', async () => {
    const prisma = getTestPrisma();
    const initial = 9007199254740993n;
    await prisma.account.update({ where: { id: 'acct_checking' }, data: { balanceMinor: initial } });
    await Promise.all([1n, 2n, 3n].map(increment => prisma.$transaction(async tx => {
      const account = await tx.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
      await tx.account.update({ where: { id: account.id }, data: { balanceMinor: account.balanceMinor + increment } });
    })));
    expect((await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(initial + 6n);
  });

  it('enforces foreign keys on the adapter connection', async () => {
    await expect(getTestPrisma().contact.create({ data: { id: 'native_orphan', userId: 'missing_owner', name: 'Orphan', phone: '00000000000' } }))
      .rejects.toMatchObject({ code: 'P2003' });
  });
});

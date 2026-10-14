import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { createDatabaseClient } from '@/lib/db/database';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function withinDeadline<T>(promise: Promise<T>, timeout = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Connection queue did not drain')), timeout); })]); }
  finally { clearTimeout(timer); }
}

describe('native SQLite connection isolation across independent requests', () => {
  it('does not roll back an independent ordinary write with another request transaction', async () => {
    const prisma = getTestPrisma();
    // Compile this exact ordinary query shape before opening the transaction.
    await prisma.contact.create({ data: { id: 'isolation_warmup', userId: 'user_liming', name: 'Warmup', phone: '00000000000' } });
    await prisma.contact.delete({ where: { id: 'isolation_warmup' } });
    const reached = deferred(), release = deferred();
    const transaction = prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: 'user_liming' }, data: { name: 'Uncommitted owner label' } });
      reached.resolve();
      await release.promise;
      throw new Error('Intentional rollback');
    });
    const rolledBack = expect(transaction).rejects.toThrow('Intentional rollback');
    await reached.promise;
    const outside = prisma.contact.create({ data: { id: 'independent_request', userId: 'user_liming', name: 'Independent', phone: '00000000001' } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A correct queue may wait for the transaction; an unsafe shared connection returns early.
      await Promise.race([outside, new Promise<void>(done => { timer = setTimeout(done, 100); })]);
    } finally { clearTimeout(timer); release.resolve(); }
    await rolledBack;
    await outside;
    expect(await prisma.contact.findUnique({ where: { id: 'independent_request' } })).toMatchObject({ name: 'Independent' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: 'user_liming' } })).name).not.toBe('Uncommitted owner label');
  });

  it('does not expose another request uncommitted row through an ordinary read', async () => {
    const prisma = getTestPrisma();
    await prisma.contact.findUnique({ where: { id: 'uncommitted_contact' } });
    const reached = deferred(), release = deferred();
    const transaction = prisma.$transaction(async tx => {
      await tx.contact.create({ data: { id: 'uncommitted_contact', userId: 'user_liming', name: 'Uncommitted', phone: '00000000002' } });
      reached.resolve();
      await release.promise;
      throw new Error('Intentional rollback');
    });
    const rolledBack = expect(transaction).rejects.toThrow('Intentional rollback');
    await reached.promise;
    const outside = prisma.contact.findUnique({ where: { id: 'uncommitted_contact' } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([outside, new Promise<void>(done => { timer = setTimeout(done, 100); })]); }
    finally { clearTimeout(timer); release.resolve(); }
    await rolledBack;
    expect(await outside).toBeNull();
  });

  it('does not leave a late transaction holding the connection after its queued maxWait expires', async () => {
    const client = createDatabaseClient('file::memory:');
    const reached = deferred(), release = deferred();
    const first = client.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT 1');
      reached.resolve();
      await release.promise;
    });
    let callbackEntered = false;
    try {
      await reached.promise;
      const second = client.$transaction(async () => { callbackEntered = true; }, { maxWait: 25, timeout: 500 })
        .then(() => ({ code: 'UNEXPECTED_SUCCESS' }), error => error);
      try { expect(await withinDeadline(second)).toMatchObject({ code: 'P2028' }); }
      finally { release.resolve(); await first; }
      expect(callbackEntered).toBe(false);
      await expect(withinDeadline(client.$queryRawUnsafe('SELECT 1'))).resolves.toHaveLength(1);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
      await withinDeadline(client.$disconnect());
    }
  });

  it('releases the connection when an interactive callback exceeds its timeout', async () => {
    const client = createDatabaseClient('file::memory:');
    const reached = deferred(), release = deferred();
    const transaction = client.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT 1');
      reached.resolve();
      await release.promise;
    }, { timeout: 25 });
    const stopped = transaction.then(() => ({ code: 'UNEXPECTED_SUCCESS' }), error => error);
    try {
      await reached.promise;
      // Prisma settles the caller after its callback returns, but the timeout rolls back sooner.
      await expect(withinDeadline(client.$queryRawUnsafe('SELECT 1'))).resolves.toHaveLength(1);
      release.resolve();
      expect(await withinDeadline(stopped)).toMatchObject({ code: 'P2028' });
    } finally {
      release.resolve();
      await stopped;
      await withinDeadline(client.$disconnect());
    }
  });
});

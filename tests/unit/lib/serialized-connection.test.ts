import { describe, expect, it, vi } from 'vitest';
import type { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { serializeSqliteConnection } from '@/lib/db/serialized-connection';

type Connection = Awaited<ReturnType<PrismaBetterSqlite3['connect']>>;
const query = { sql: 'SELECT value', args: [], argTypes: [] };
const result = { columnTypes: [], columnNames: [], rows: [] };

function fixture() {
  const transaction = { provider: 'sqlite' as const, adapterName: 'test-adapter', options: { usePhantomQuery: false },
    queryRaw: vi.fn().mockResolvedValue(result), executeRaw: vi.fn().mockResolvedValue(1),
    commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined),
    createSavepoint: vi.fn().mockResolvedValue(undefined), rollbackToSavepoint: vi.fn().mockResolvedValue(undefined),
    releaseSavepoint: vi.fn().mockResolvedValue(undefined) };
  const native = { provider: 'sqlite' as const, adapterName: 'test-adapter', queryRaw: vi.fn().mockResolvedValue(result),
    executeRaw: vi.fn().mockResolvedValue(1), executeScript: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
    startTransaction: vi.fn().mockResolvedValue(transaction) };
  return { native, transaction, connection: serializeSqliteConnection(native as Connection) };
}

describe('single-connection transaction serialization', () => {
  it.each(['commit', 'rollback'] as const)('queues ordinary reads/writes until %s while transaction queries and savepoints remain usable', async close => {
    const { native, transaction, connection } = fixture();
    const tx = await connection.startTransaction();
    const outside = connection.queryRaw(query);
    const write = connection.executeRaw(query);
    await tx.queryRaw(query);
    await tx.executeRaw(query);
    await tx.createSavepoint!('savepoint');
    await tx.rollbackToSavepoint!('savepoint');
    await tx.releaseSavepoint!('savepoint');
    expect(transaction.queryRaw).toHaveBeenCalledOnce();
    expect(transaction.createSavepoint).toHaveBeenCalledWith('savepoint');
    expect(native.queryRaw).not.toHaveBeenCalled();
    expect(native.executeRaw).not.toHaveBeenCalled();
    await tx[close]();
    await Promise.all([outside, write]);
    expect(native.queryRaw).toHaveBeenCalledOnce();
    expect(native.executeRaw).toHaveBeenCalledOnce();
  });

  it('releases the outer queue when a statement or transaction admission throws', async () => {
    const { native, connection } = fixture();
    native.queryRaw.mockRejectedValueOnce(new Error('Statement rejected'));
    await expect(connection.queryRaw(query)).rejects.toThrow('Statement rejected');
    native.startTransaction.mockRejectedValueOnce(new Error('Admission rejected'));
    await expect(connection.startTransaction()).rejects.toThrow('Admission rejected');
    await expect(connection.executeRaw(query)).resolves.toBe(1);
  });

  it('keeps another transaction locked when a previously closed transaction releases twice', async () => {
    const { native, connection } = fixture();
    const first = await connection.startTransaction();
    await first.commit();
    const second = await connection.startTransaction();
    const outside = connection.queryRaw(query);
    await first.rollback();
    await second.queryRaw(query);
    expect(native.queryRaw).not.toHaveBeenCalled();
    await second.commit();
    await outside;
    expect(native.queryRaw).toHaveBeenCalledOnce();
  });
});

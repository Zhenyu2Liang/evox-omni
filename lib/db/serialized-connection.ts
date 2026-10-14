import type { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

type Connection = Awaited<ReturnType<PrismaBetterSqlite3['connect']>>;

/** One FIFO lock covers ordinary statements and the full lifetime of an interactive transaction. */
class ConnectionMutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let resolve!: () => void;
    this.tail = new Promise<void>(done => { resolve = done; });
    await previous;
    let released = false;
    return () => { if (!released) { released = true; resolve(); } };
  }

  async use<T>(run: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await run(); } finally { release(); }
  }
}

/** A global statement must never join another request's transaction on the shared native connection. */
export function serializeSqliteConnection(connection: Connection): Connection {
  const mutex = new ConnectionMutex();
  return {
    provider: connection.provider,
    adapterName: connection.adapterName,
    queryRaw: query => mutex.use(() => connection.queryRaw(query)),
    executeRaw: query => mutex.use(() => connection.executeRaw(query)),
    executeScript: script => mutex.use(() => connection.executeScript(script)),
    dispose: () => mutex.use(() => connection.dispose()),
    ...(connection.getConnectionInfo ? { getConnectionInfo: () => connection.getConnectionInfo!() } : {}),
    startTransaction: async level => {
      const release = await mutex.acquire();
      try {
        const transaction = await connection.startTransaction(level);
        // Transaction statements already own the connection lock and must not acquire it again.
        return {
          provider: transaction.provider,
          adapterName: transaction.adapterName,
          options: transaction.options,
          queryRaw: query => transaction.queryRaw(query),
          executeRaw: query => transaction.executeRaw(query),
          ...(transaction.createSavepoint ? { createSavepoint: (name: string) => transaction.createSavepoint!(name) } : {}),
          ...(transaction.rollbackToSavepoint ? { rollbackToSavepoint: (name: string) => transaction.rollbackToSavepoint!(name) } : {}),
          ...(transaction.releaseSavepoint ? { releaseSavepoint: (name: string) => transaction.releaseSavepoint!(name) } : {}),
          commit: async () => { try { await transaction.commit(); } finally { release(); } },
          rollback: async () => { try { await transaction.rollback(); } finally { release(); } },
        };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}

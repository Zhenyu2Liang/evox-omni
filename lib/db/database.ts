import { PrismaClient } from './prisma.ts';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { resolveDatabaseUrl } from './url.ts';
import { serializeSqliteConnection } from './serialized-connection.ts';
export { resolveDatabaseUrl } from './url.ts';

/** Configure the single native connection before any Prisma statement can run. */
class BankingSqliteAdapter extends PrismaBetterSqlite3 {
  override async connect() {
    const connection = await super.connect();
    try {
      await connection.executeScript('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      return serializeSqliteConnection(connection);
    } catch (error) {
      await connection.dispose();
      throw error;
    }
  }
}

/** Each independent client owns one exact-integer SQLite connection and its transaction mutex. */
export function createDatabaseClient(url?: string): PrismaClient {
  const adapter = new BankingSqliteAdapter({ url: resolveDatabaseUrl(url), timeout: 10000 },
    { timestampFormat: 'unixepoch-ms' });
  return new PrismaClient({ adapter, transactionOptions: { maxWait: 10000, timeout: 10000 } });
}

import { AppError } from '@/lib/errors';
import type { DbClient } from '@/lib/db/client';
import { isLocked } from './circuit-breaker';

/**
 * Recheck immediately before a new SDK mutation, using the persisted action's session.
 *
 * `client` binds the breaker read to an OPEN interactive transaction's client when this runs at the
 * SDK write boundary (inside `banking-sdk/tx.ts#runInTransaction`). Omitting it reads through the
 * global Prisma client, which is correct OUTSIDE a transaction but deadlocks INSIDE one on a
 * single-connection datasource — the open transaction holds the only connection.
 */
export async function assertSessionMayWrite(sessionId: string, client?: DbClient): Promise<void> {
  if (await isLocked(sessionId, client)) {
    throw new AppError('CIRCUIT_OPEN', '当前会话已触发安全熔断，不能产生新的业务变更。');
  }
}

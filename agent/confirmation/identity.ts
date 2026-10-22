import { getPendingActionOwnership } from '@/lib/db/repositories/pendingAction';
import { getSession } from '@/lib/db/repositories/session';
import { AppError } from '@/lib/errors';
import type { ConfirmOptions, TrustedIdentity } from './contracts';

/**
 * Ownership refusals are business sentences: they name NO action id, session id or internal token,
 * because the HTTP error envelope renders `message` to the caller. The typed `code` carries the
 * machine-readable reason; the identifiers stay in the logs and the persisted rows.
 */

/** Resolve ownership before authorizing or changing execution-liveness metadata. */
export async function resolveTrustedIdentity(
  actionId: string,
  opts?: ConfirmOptions,
): Promise<TrustedIdentity> {
  const row = await getPendingActionOwnership(actionId);
  if (row === null) throw new AppError('NOT_FOUND', '未找到待处理的操作。');
  if (opts?.sessionId !== undefined && opts.sessionId !== row.sessionId) {
    throw new AppError('SECURITY_DENIED', '无权操作该待处理操作。');
  }
  const session = await getSession(row.sessionId);
  const userId = session?.userId;
  if (userId === undefined || userId === '') {
    throw new AppError('SECURITY_DENIED', '无法解析待处理操作的所有者会话。');
  }
  if (opts?.userId !== undefined && opts.userId !== userId) {
    throw new AppError('SECURITY_DENIED', '无权操作该待处理操作。');
  }
  return { userId, sessionId: row.sessionId };
}

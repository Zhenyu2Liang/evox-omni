import { AppError } from '@/lib/errors';
import { isLocked } from './circuit-breaker';

/** Recheck immediately before a new SDK mutation, using the persisted action's session. */
export async function assertSessionMayWrite(sessionId: string): Promise<void> {
  if (await isLocked(sessionId)) {
    throw new AppError('CIRCUIT_OPEN', '当前会话已触发安全熔断，不能产生新的业务变更。');
  }
}

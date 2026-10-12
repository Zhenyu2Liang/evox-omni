import { getTaskPlan, readPendingActionId } from './task-control';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { getSession } from '@/lib/db/repositories/session';
import { safeParse } from '@/lib/json';
import { withActionPolicy } from '@/lib/action-summary';
import { AppError } from '@/lib/errors';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { RiskLevel } from '@/lib/contracts/risk';

/** Restore the next real plan decision after a human continuation, never from model narration. */
export async function nextPlanDecision(sessionId: string, taskId: string): Promise<AgentStreamEvent | undefined> {
  const plan = await getTaskPlan(sessionId, taskId);
  if (plan.status === 'cancelled' || plan.status === 'success' || plan.status === 'paused') return;
  const session = await getSession(sessionId);
  if (!session) throw new AppError('SECURITY_DENIED', '会话不存在');
  for (const node of plan.results) {
    if (node.status !== 'waiting_confirmation' && node.status !== 'waiting_verification') continue;
    const id = readPendingActionId(node.output);
    if (!id) continue;
    const row = await getPendingAction(id);
    if (!row || row.taskId !== taskId || row.nodeId !== node.id || row.sessionId !== sessionId ||
        row.userId !== session.userId || !['pending', 'awaiting_mfa'].includes(row.status)) continue;
    const stored = safeParse<PendingActionSummary | undefined>(row.summaryJson, undefined);
    if (!stored || !Array.isArray(stored.fields) || stored.toolName !== row.toolName) {
      throw new AppError('INTERNAL', '无法恢复下一步操作详情，请刷新后核对。');
    }
    const action = withActionPolicy({ ...stored, actionId: row.id }, {
      tier: row.requiresMfa ? 'RED' : row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa, actionId: row.id,
    });
    return action.requiresMfa || action.tier === 'RED'
      ? { type: 'mfa_required', actionId: row.id, action, hint: '请输入 6 位短信验证码。' }
      : { type: 'confirmation_required', actionId: row.id, action };
  }
}

import { prisma } from '@/lib/db/client';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { getSession } from '@/lib/db/repositories/session';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { normalizeTransferAmount } from '@/lib/money';
import { demoNow } from '@/lib/clock';
import { ledgerTxIdForAction } from '@/lib/ledger';
import { recordSecurityEvent } from '@/audit';
import { assertSessionMayWrite } from './execution-policy';
import { computeEffectiveTransferTotalWith, evaluateTransferRisk } from './risk-engine';
import { issueChallenge } from './mfa';
import type { ActionOwnership, AuthorizationResult } from './security-gateway';

/** Applies only to recovery that may create a NEW debit, never to read-only receipt recovery. */
export async function assertRecoverySessionUnlocked(sessionId: string): Promise<void> {
  await assertSessionMayWrite(sessionId);
}

/** Revalidate persisted authorization and current policy before an idempotent recovery attempt. */
export async function authorizeRecoveryAction(actionId: string, actor: ActionOwnership): Promise<AuthorizationResult> {
  const row = await getPendingAction(actionId);
  if (!row) throw new AppError('NOT_FOUND', '待恢复操作不存在。');
  if (!actor.userId || !actor.sessionId || row.userId !== actor.userId || row.sessionId !== actor.sessionId ||
      (await getSession(actor.sessionId))?.userId !== actor.userId) {
    throw new AppError('SECURITY_DENIED', '无权恢复该操作。');
  }
  await assertRecoverySessionUnlocked(actor.sessionId);
  if (row.toolName !== 'transfer_money') throw new AppError('SECURITY_DENIED', '该工具不允许重新执行业务恢复。');
  const args = safeParse<Record<string, unknown>>(row.argsJson, {});
  const amount = normalizeTransferAmount(args.amount);

  const outcome = await prisma.$transaction(async tx => {
    // First write serializes this authorization against other transfers and cancellations.
    const claimed = await tx.pendingAction.updateMany({
      where: { id: actionId, userId: actor.userId, sessionId: actor.sessionId, status: 'confirmed' },
      data: { status: 'confirmed' },
    });
    if (claimed.count !== 1) throw new AppError('CONFLICT', '操作状态已变化，请刷新后核对。');
    // Re-read AFTER the writer claim: another recovery may have upgraded MFA and committed while
    // the ownership read above was in flight. Its persisted decision is the current authority.
    const current = await tx.pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    // A competing recovery can commit after our caller's receipt miss. Its debit is already in
    // the daily total: do not add this request again or downgrade it to awaiting_mfa. The SDK
    // still verifies the receipt/request before returning; this branch grants no new debit.
    if (await tx.transaction.findUnique({ where: { id: ledgerTxIdForAction(actor.userId, current) } })) {
      return { requiresMfa: current.requiresMfa || current.riskLevel === 'RED', allowed: true };
    }
    await assertRecoverySessionUnlocked(actor.sessionId);
    if (current.taskId && (await tx.agentTask.findUnique({ where: { id: current.taskId } }))?.status === 'cancelled') {
      throw new AppError('SECURITY_DENIED', '操作所属计划已取消，不能恢复新的资金变更。');
    }
    const total = await computeEffectiveTransferTotalWith(tx, actor.userId, undefined, actionId);
    const risk = evaluateTransferRisk({ amount, dailyTransferTotal: total });
    const needsMfa = current.requiresMfa || current.riskLevel === 'RED' || risk.requiresMfa;
    const challenge = needsMfa ? await tx.mfaChallenge.findUnique({ where: { actionId } }) : null;
    const verified = challenge?.status === 'verified' &&
      (challenge.expiresAt === null || challenge.expiresAt.getTime() > demoNow());
    if (needsMfa && !verified) {
      await tx.pendingAction.update({ where: { id: actionId }, data: {
        status: 'awaiting_mfa', riskLevel: 'RED', requiresMfa: true,
      } });
      return { requiresMfa: true, allowed: false };
    }
    return { requiresMfa: needsMfa, allowed: true };
  });

  if (!outcome.allowed) {
    await issueChallenge(actionId);
    await recordSecurityEvent({ sessionId: actor.sessionId, userId: actor.userId, kind: 'LIMIT_EXCEEDED', severity: 'high',
      message: '恢复转账需重新进行安全验证，尚未产生资金变更。',
      detail: { actionId, decision: 'recovery_requires_mfa', amount },
    });
  }
  return {
    ok: outcome.allowed, actionId, status: outcome.allowed ? 'confirmed' : 'awaiting_mfa',
    tier: outcome.requiresMfa ? 'RED' : 'YELLOW', requiresMfa: outcome.requiresMfa,
    mfaResult: outcome.allowed ? outcome.requiresMfa ? 'success' : 'not_required' : undefined,
    message: outcome.allowed ? '恢复授权已复核。' : '恢复转账需安全验证，请输入验证码后继续。',
  };
}

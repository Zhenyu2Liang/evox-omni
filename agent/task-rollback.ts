import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { safeParse, toJson } from '@/lib/json';
import { nodeExecutionKey } from '@/lib/ledger';
import type { TaskCompensation, TaskPlan } from '@/lib/contracts/task';
import { recordAudit } from '@/audit';
import { toTaskPlan } from './task-control';

/** User-only compensation. Original node outcomes and all financial facts remain unchanged. */
export async function rollbackTask(sessionId: string, taskId: string): Promise<TaskPlan> {
  return prisma.$transaction(async tx => {
    // The first conditional write serializes concurrent compensation requests (SQLite WAL).
    const owned = await tx.agentTask.updateMany({
      where: { id: taskId, sessionId, status: 'cancelled' }, data: { updatedAt: new Date() },
    });
    if (!owned.count) {
      const task = await tx.agentTask.findUnique({ where: { id: taskId } });
      if (!task) throw new AppError('NOT_FOUND', '任务不存在');
      if (task.sessionId !== sessionId) throw new AppError('SECURITY_DENIED', '无权回退此任务');
      throw new AppError('CONFLICT', '请先取消计划，再回退已完成的预算和定时任务记录。');
    }
    const task = await tx.agentTask.findUniqueOrThrow({ where: { id: taskId }, include: { nodes: { orderBy: { order: 'desc' } } } });
    const session = await tx.agentSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== task.userId) throw new AppError('SECURITY_DENIED', '会话归属不一致');
    for (const node of task.nodes) {
      if (node.status !== 'success' || node.compensation || node.kind !== 'tool') continue;
      // Pure reads have no compensation. Other writes are explicitly retained, never replayed.
      const reversible = node.tool === 'reserve_budget' || node.tool === 'create_scheduled_task';
      const writes = ['transfer_money', 'subscribe_investment', 'redeem_investment', 'set_card_limit', 'freeze_card',
        'unfreeze_card', 'report_lost_card', 'replace_card', 'apply_virtual_card', 'cancel_subscription', 'set_subscription_reminder'];
      if (!reversible && !writes.includes(node.tool ?? '')) continue;
      let receipt: TaskCompensation = { status: 'retained', message: '原操作已执行，保留原结果；本次回退不修改资金、理财或卡片变更。', completedAt: Date.now() };
      if (reversible) {
        const output = safeParse<Record<string, unknown>>(node.output, {});
        const resourceId = typeof output.id === 'string' ? output.id : undefined;
        const key = nodeExecutionKey(task.id, node.nodeId);
        if (node.tool === 'reserve_budget') {
          const budget = resourceId ? await tx.budget.findUnique({ where: { id: resourceId } }) : null;
          if (!budget || budget.userId !== task.userId || budget.idempotencyKey !== key) {
            receipt = { ...receipt, status: 'conflict', message: '无法核实预算属于本计划节点，未撤销其他预算。' };
          } else if (budget.status === 'RESERVED' || budget.status === 'RELEASED') {
            await tx.budget.updateMany({ where: { id: budget.id, status: 'RESERVED' }, data: { status: 'RELEASED' } });
            receipt = { ...receipt, status: 'reverted', resourceId: budget.id, message: '已释放本计划的预算记录；未移动资金。' };
          } else receipt = { ...receipt, status: 'conflict', resourceId: budget.id, message: '预算已使用，未自动撤销，请人工核对。' };
        } else {
          const record = resourceId ? await tx.scheduledTask.findUnique({ where: { id: resourceId } }) : null;
          if (!record || record.userId !== task.userId || record.idempotencyKey !== key) {
            receipt = { ...receipt, status: 'conflict', message: '无法核实定时任务属于本计划节点，未撤销其他任务。' };
          } else if (record.status === 'SCHEDULED' || record.status === 'CANCELLED') {
            await tx.scheduledTask.updateMany({ where: { id: record.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
            receipt = { ...receipt, status: 'reverted', resourceId: record.id, message: '已取消本计划的定时任务记录；未撤销任何已执行交易。' };
          } else receipt = { ...receipt, status: 'conflict', resourceId: record.id, message: '定时任务已完成，未自动撤销，请人工核对。' };
        }
      }
      await recordAudit({
        timestamp: receipt.completedAt, sessionId, userId: task.userId, userRequest: '回退本计划已完成的预算和定时任务记录',
        intent: '计划补偿回退', toolName: 'rollback_task', riskLevel: 'YELLOW', confirmationRequired: true,
        confirmed: true, mfaRequired: false, mfaResult: 'not_required', taskId, nodeId: node.nodeId,
        toolArgs: { originalTool: node.tool, resourceId: receipt.resourceId }, toolResult: receipt,
        status: receipt.status === 'conflict' ? 'failed' : 'success',
      }, { client: tx, strict: true, dedupeKey: `rollback:${taskId}:${node.nodeId}` });
      await tx.agentTaskNode.update({ where: { id: node.id }, data: { compensation: toJson(receipt) } });
    }
    const updated = await tx.agentTask.findUniqueOrThrow({ where: { id: taskId }, include: { nodes: { orderBy: { order: 'asc' } } } });
    return toTaskPlan(updated);
  });
}

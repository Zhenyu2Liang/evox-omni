import type { Prisma } from '@/lib/db/prisma';
import { AppError } from '@/lib/errors';
import { toJson } from '@/lib/json';
import { idempotentTransferTxId, nodeExecutionKey } from '@/lib/ledger';
import { withinTransaction } from '@/lib/db/unit-of-work';
import { committedExecutionResult } from './execution-evidence';

const TERMINAL_STATUSES = ['success', 'failed', 'skipped', 'cancelled'];

/** Cancellation must preserve a committed effect even when its executor has not landed node state. */
export async function restoreCommittedCancellationNodes(
  client: Prisma.TransactionClient,
  taskId: string,
  userId: string,
  now: number,
): Promise<void> {
  await withinTransaction(client, async () => {
    const nodes = await client.agentTaskNode.findMany({ where: {
      taskId, kind: 'tool', status: { notIn: TERMINAL_STATUSES },
    } });
    const actions = await client.pendingAction.findMany({ where: { taskId, userId }, orderBy: { createdAt: 'desc' } });
    for (const node of nodes) {
      if (!node.tool) continue;
      const key = nodeExecutionKey(taskId, node.nodeId);
      const receipt = await client.executionReceipt.findUnique({ where: { userId_key: { userId, key } } });
      const action = actions.find(candidate => candidate.nodeId === node.nodeId && candidate.toolName === node.tool);
      const hasLedger = node.tool === 'transfer_money' && await client.transaction.findUnique({
        where: { id: idempotentTransferTxId(userId, key) }, select: { id: true },
      });
      if (!receipt && !hasLedger) continue;
      try {
        // Gated commands use the originally authorized arguments, including canonical selectors
        // and expected settlement amounts. Model-proposed node arguments cannot replace them.
        const committed = await committedExecutionResult({
          id: action?.id ?? key, userId, taskId, nodeId: node.nodeId, toolName: node.tool,
          argsJson: action?.argsJson ?? node.args ?? '{}',
        });
        if (!committed) throw new AppError('CONFLICT', 'Committed execution evidence has no verified result.');
        await client.agentTaskNode.updateMany({ where: {
          taskId, nodeId: node.nodeId, status: { notIn: TERMINAL_STATUSES },
        }, data: { status: 'success', output: toJson(committed.data ?? { summary: committed.summary }),
          error: null, endedAt: new Date(now) } });
      } catch (error) {
        if (!(error instanceof AppError) || !['CONFLICT', 'VALIDATION'].includes(error.code)) throw error;
        const result = { ok: false, error: error.message, needsReconciliation: true };
        await client.agentTaskNode.updateMany({ where: {
          taskId, nodeId: node.nodeId, status: { notIn: TERMINAL_STATUSES },
        }, data: { status: 'failed', output: toJson(result), error: error.message, endedAt: new Date(now) } });
        if (action) await client.pendingAction.update({ where: { id: action.id }, data: {
          status: 'needs_reconciliation', resultJson: toJson(result),
        } });
      }
    }
  });
}

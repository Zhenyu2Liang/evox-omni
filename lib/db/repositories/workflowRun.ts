import type { AgentTask } from '@prisma/client';
import type { DbClient } from '../client';
import { AppError } from '@/lib/errors';

/** Graph and recovery source are persisted together before any standalone node can execute. */
export async function ensureStandaloneWorkflowRun(task: AgentTask, client: DbClient): Promise<string> {
  if (task.runId !== null) return task.runId;
  if (task.parentInvocationId !== null) throw new AppError('CONFLICT', 'A workflow parent requires its original run identity');
  const session = await client.agentSession.findUnique({ where: { id: task.sessionId } });
  if (!session || session.userId !== task.userId) throw new AppError('SECURITY_DENIED', 'Standalone workflow session ownership is invalid');
  const run = await client.agentRun.create({ data: {
    sessionId: task.sessionId,
    userId: task.userId,
    requestDigest: `workflow:${task.id}`,
    requestJson: JSON.stringify({ kind: 'workflow', workflowTaskId: task.id, input: task.goal }),
    status: 'interrupted',
    checkpointStage: 'workflow_only',
    baseRevision: session.revision,
  } });
  await client.agentTask.update({ where: { id: task.id }, data: { runId: run.id } });
  return run.id;
}

/** A foreground workflow settles its journal only after releasing its executor claim. */
export async function synchronizeStandaloneWorkflowRun(taskId: string, client: DbClient): Promise<void> {
  const synchronize = async (transaction: DbClient): Promise<void> => {
    const task = await transaction.agentTask.findUnique({ where: { id: taskId }, include: { nodes: true, manualReviews: { where: { status: 'open' } } } });
    if (!task?.runId || task.parentInvocationId || task.executionToken !== null) return;
    const run = await transaction.agentRun.findUnique({ where: { id: task.runId } });
    if (!run || run.checkpointStage !== 'workflow_only' || run.leaseToken !== null) return;
    const succeeded = task.nodes.length > 0 && task.nodes.every(node => node.status === 'success' || node.status === 'skipped');
    const status = task.status === 'success' && succeeded ? 'completed'
      : task.status === 'cancelled' || task.status === 'failed' ? 'failed'
        : task.nodes.some(node => node.status === 'waiting_verification') ? 'waiting_verification'
          : task.status === 'waiting_confirmation' ? 'waiting_confirmation' : 'interrupted';
    await transaction.agentRun.updateMany({ where: { id: run.id, checkpointStage: 'workflow_only', leaseToken: null }, data: {
      status,
      finishedAt: status === 'completed' || status === 'failed' ? new Date() : null,
      errorCode: task.status === 'cancelled' ? 'CANCELLED' : task.status === 'failed' ? 'WORKFLOW_FAILED' : null,
      recoveryErrorCode: task.status === 'paused' || task.manualReviews.length !== 0 ? 'WORKFLOW_REQUIRES_ATTENTION' : null,
    } });
  };
  return '$transaction' in client ? client.$transaction(synchronize) : synchronize(client);
}

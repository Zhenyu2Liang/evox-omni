import { dbClient } from '@/lib/db/client';

export interface WorkflowStatusEvidence {
  id: string;
  status: string;
  updatedAt: string;
  nodes: Array<{ id: string; status: string }>;
}

/** 网页或 IM 控制会改变数据库状态；历史工具消息只保留当时的事实。 */
export async function loadWorkflowContext(userId: string, sessionId: string): Promise<WorkflowStatusEvidence[]> {
  const plans = await dbClient().agentTask.findMany({
    where: { userId, sessionId }, orderBy: { updatedAt: 'desc' }, take: 10,
    select: { id: true, status: true, updatedAt: true, nodes: { orderBy: { order: 'asc' }, select: { nodeId: true, status: true } } },
  });
  return plans.map(plan => ({ id: plan.id, status: plan.status, updatedAt: plan.updatedAt.toISOString(),
    nodes: plan.nodes.map(node => ({ id: node.nodeId, status: node.status })) }));
}

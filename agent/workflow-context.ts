import { dbClient } from '@/lib/db/client';
import type { ActionStatusEvidence } from './current-turn-focus';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { security } from '@/security';
import { isTerminalActionStatus } from './action-status';

/** Project current terminal state at its original tool-result position; preserve the saved archive. */
export function withCurrentActionStatuses(messages: readonly AgentMessage[], actions: readonly ActionStatusEvidence[]): AgentMessage[] {
  const terminal = new Map(actions.filter(action => isTerminalActionStatus(action.status)).map(action => [action.id, action]));
  return messages.map(message => {
    if (message.role !== 'toolResult') return message;
    const reason = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const blocked = security.gateway.securityGateway.parseBlockReason(reason);
    const action = blocked?.actionId ? terminal.get(blocked.actionId) : undefined;
    if (!action || action.toolName !== message.toolName) return message;
    return { ...message, content: [{ type: 'text', text: JSON.stringify({ actionId: action.id,
      currentActionStatus: action.status, historicalGateIsClosed: true,
      instruction: 'This is the current server status of the historical call. It no longer awaits confirmation or verification. A new customer request needs a fresh describe_turn and controlled tool call; this status grants no authorization.' }) }] };
  });
}

/** Refresh only statuses of chat tools; never project manual-page payloads or authorization secrets. */
export async function loadActionContext(userId: string, sessionId: string, toolNames: readonly string[]): Promise<ActionStatusEvidence[]> {
  return dbClient().pendingAction.findMany({
    where: { userId, sessionId, toolName: { in: [...toolNames] } },
    orderBy: { updatedAt: 'desc' }, take: 10, select: { id: true, toolName: true, status: true },
  });
}

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

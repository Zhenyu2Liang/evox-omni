import type { ChatMessage } from '@/lib/contracts/agent';
import type { SessionSnapshot } from '@/agent/session';
import { prisma } from '@/lib/db/client';
import { safeParse } from '@/lib/json';
import { placePlanInHistory } from '@/lib/chat-plan-history';
import { toTaskPlan } from '@/app/api/_lib/task-plans';
import { toolPresentationId } from '@/agent/tool-presentation-identity';
import { projectPlanApprovals } from './plan-approvals';

/** Restore every visible plan from persisted node outcomes into its original conversation turn. */
export async function readConversationPlans(snapshot: SessionSnapshot, messages: ChatMessage[]): Promise<ChatMessage[]> {
  const scope = { sessionId: snapshot.sessionId, userId: snapshot.userId };
  const tasks = await prisma.agentTask.findMany({ where: { ...scope,
    ...(snapshot.historyStartedAt ? { createdAt: { gte: new Date(snapshot.historyStartedAt) } } : {}) },
    orderBy: { createdAt: 'asc' }, include: { nodes: { orderBy: { order: 'asc' } } } });
  if (tasks.length === 0) return messages;
  const invocationIds = tasks.flatMap(task => task.parentInvocationId ? [task.parentInvocationId] : []);
  const [events, invocations, actions] = await Promise.all([
    prisma.agentRunEvent.findMany({ where: { run: scope, channel: 'ui', eventType: { in: ['message_start', 'message_end'] } },
      orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }],
      select: { runId: true, payloadJson: true } }),
    prisma.toolInvocation.findMany({ where: { id: { in: invocationIds }, run: scope },
      select: { id: true, callId: true, runId: true, modelRequestId: true } }),
    prisma.pendingAction.findMany({ where: { ...scope, taskId: { in: tasks.map(task => task.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, taskId: true, nodeId: true, toolName: true, riskLevel: true,
        requiresMfa: true, summaryJson: true, status: true } }),
  ]);
  const messageRuns = new Map<string, string>();
  for (const event of events) {
    const id = safeParse<{ message?: { id?: string } }>(event.payloadJson, {}).message?.id;
    if (id && !messageRuns.has(id)) messageRuns.set(id, event.runId);
  }
  const invocationById = new Map(invocations.map(invocation => [invocation.id, invocation]));
  let projected = messages;
  for (const task of tasks) {
    const invocation = task.parentInvocationId ? invocationById.get(task.parentInvocationId) : undefined;
    const ownerId = invocation?.modelRequestId ? toolPresentationId(invocation.runId, invocation.modelRequestId, invocation.callId) : undefined;
    const owners = invocation ? projected.filter(message => message.role === 'tool' &&
      (ownerId ? message.id === ownerId : messageRuns.get(message.id) === invocation.runId) &&
      message.toolEvents?.some(event => event.toolCallId === invocation.callId && event.toolName === 'submit_plan')) : [];
    const owner = owners.length === 1 ? owners[0] : undefined;
    const plan = toTaskPlan(task);
    projected = projectPlanApprovals(placePlanInHistory(projected, plan, owner?.id), plan, actions);
  }
  return projected;
}

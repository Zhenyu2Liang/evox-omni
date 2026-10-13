import type { TaskCondition, TaskNodeKind, TaskNodeResult, TaskNodeStatus, TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import { prisma } from '@/lib/db/client';
import { claimTaskStatus, getTask, updateTaskStatus, type AgentTaskWithNodes } from '@/lib/db/repositories/task';
import { safeParse } from '@/lib/json';
import { jsonNodeOutput, toNodeUpdate } from '../task-fencing';
import { TERMINAL_NODE_STATUSES } from './claims';
import type { TaskPersistence, TaskPersistenceOptions } from './contracts';

const NON_CANCELLED_PLAN_STATUSES: TaskPlanStatus[] = ['pending', 'running', 'paused', 'waiting_confirmation', 'success', 'failed'];

/** Persisted task IDs are canonical plan IDs, including after a process restart. */
export function toTaskPlan(row: AgentTaskWithNodes): TaskPlan {
  return {
    id: row.id, sessionId: row.sessionId, goal: row.goal, status: row.status as TaskPlanStatus,
    nodes: row.nodes.map(node => ({
      id: node.nodeId, name: node.name, dependencies: safeParse<string[]>(node.dependencies, []),
      ...(node.after ? { after: safeParse<string[]>(node.after, []) } : {}),
      kind: node.kind as TaskNodeKind, tool: node.tool ?? undefined,
      args: safeParse<Record<string, unknown> | undefined>(node.args, undefined),
      condition: safeParse<TaskCondition | undefined>(node.condition, undefined),
    })),
    results: row.nodes.map(node => ({
      id: node.nodeId, name: node.name, status: node.status as TaskNodeStatus, tool: node.tool ?? undefined,
      output: safeParse(node.output, undefined), error: node.error ?? undefined,
      startedAt: node.startedAt?.getTime(), endedAt: node.endedAt?.getTime(),
      ...(node.compensation ? { compensation: safeParse(node.compensation, undefined) } : {}),
    })),
    createdAt: row.createdAt.getTime(), generation: row.generation, updatedAt: row.updatedAt.getTime(),
  };
}

/** Executor writes always prove ownership. Only explicit control intents write without a lease. */
export function createTaskPersistence(planId: string, options: TaskPersistenceOptions = {}): TaskPersistence {
  void planId;
  const { mode = 'executor', planToken, nodeToken } = options;
  const executorMode = mode === 'executor';
  return {
    async persistPlan(plan): Promise<void> {
      if (plan.status === 'cancelled') {
        await updateTaskStatus(plan.id, 'cancelled');
        return;
      }
      if (executorMode && planToken === undefined) return;
      const writableStatuses = plan.status === 'success' ? NON_CANCELLED_PLAN_STATUSES : NON_CANCELLED_PLAN_STATUSES.filter(status => status !== 'success');
      await claimTaskStatus(plan.id, writableStatuses, plan.status,
        planToken === undefined ? undefined : { fenceToken: planToken });
    },
    async persistNode(id: string, node: TaskNodeResult): Promise<void> {
      const token = nodeToken?.(node.id);
      const terminal = TERMINAL_NODE_STATUSES.includes(node.status);
      if (token !== undefined || planToken !== undefined) {
        await prisma.agentTaskNode.updateMany({
          where: {
            taskId: id, nodeId: node.id,
            ...(token === undefined ? {} : { executionToken: token }),
            ...(planToken === undefined ? {} : { task: { executionToken: planToken } }),
            ...(terminal ? { status: { notIn: TERMINAL_NODE_STATUSES } } : {}),
          },
          data: { ...toNodeUpdate(node), output: jsonNodeOutput(node) },
        });
        return;
      }
      if (executorMode) return;
      // Cancellation snapshots cannot overwrite results committed while revocation was in flight.
      await prisma.agentTaskNode.updateMany({
        where: { taskId: id, nodeId: node.id, status: { notIn: TERMINAL_NODE_STATUSES } },
        data: { ...toNodeUpdate(node), output: jsonNodeOutput(node) },
      });
    },
    async loadPlan(id): Promise<TaskPlan | undefined> {
      const row = await getTask(id);
      return row === null ? undefined : toTaskPlan(row);
    },
  };
}

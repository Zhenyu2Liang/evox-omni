import type { NodeExecutionContext, PlanToolOutcome } from '@/planner';
import type { TaskNodeResult, TaskPlan } from '@/lib/contracts/task';

export interface TaskNodeOutput { pendingActionId?: string }

export function readPendingActionId(output: unknown): string | undefined {
  if (output === null || typeof output !== 'object') return undefined;
  const candidate = (output as TaskNodeOutput).pendingActionId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export type TaskRunTool = (toolName: string, args: Record<string, unknown>, context: NodeExecutionContext) => Promise<PlanToolOutcome>;
export interface TaskControlOptions { now?: () => number }
export interface TaskControlDeps extends TaskControlOptions { runTool: TaskRunTool }
export interface TaskPersistence {
  persistPlan(plan: TaskPlan): Promise<void>;
  persistNode(planId: string, node: TaskNodeResult): Promise<void>;
  loadPlan(planId: string): Promise<TaskPlan | undefined>;
}
export type TaskPersistenceMode = 'executor' | 'control';
export interface TaskPersistenceOptions {
  mode?: TaskPersistenceMode;
  planToken?: string;
  nodeToken?: (nodeId: string) => string | undefined;
  explicitRetry?: boolean;
}

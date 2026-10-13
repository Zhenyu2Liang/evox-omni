import type { TaskNodeResult } from '@/lib/contracts/task';
import type { PlanControlCommand, PlanControlPort, PlanDeps } from '@/planner';
import { getTask } from '@/lib/db/repositories/task';
import { AppError } from '@/lib/errors';
import { buildNodeClaimPorts, planExecutionClaimHeld } from './claims';
import { createTaskPersistence } from './persistence';
import type { TaskControlDeps, TaskPersistenceOptions, TaskRunTool } from './contracts';
import { withWorkflowExecutionClaim } from './execution-context';

export const UNUSED_RUN_TOOL: TaskRunTool = async toolName => {
  throw new AppError('INTERNAL', `Control-only workflow cannot execute a tool: ${toolName}`);
};
export const PAUSE_NOW_CONTROLS: PlanControlPort = { pollControls: (): PlanControlCommand[] => [{ kind: 'pause' }] };

/** Status is the durable control source; reading it never consumes a user's pause or cancellation. */
export function defaultPollControls(planId: string): PlanControlPort {
  return {
    async pollControls(id): Promise<PlanControlCommand[]> {
      const row = await getTask(id || planId);
      if (row?.status === 'paused') return [{ kind: 'pause' }];
      if (row?.status === 'cancelled') return [{ kind: 'cancel' }];
      return [];
    },
  };
}

export function buildPlanDeps(planId: string, deps: TaskControlDeps,
  onNodeUpdate: (node: TaskNodeResult) => void = () => {}, options: TaskPersistenceOptions = {}): PlanDeps {
  const { mode = 'executor', planToken } = options;
  const { claimNode, releaseNode, nodeTokens } = buildNodeClaimPorts(planId, planToken);
  return {
    runTool: (toolName, args, context) => withWorkflowExecutionClaim({ taskId: context.taskId, nodeId: context.nodeId,
      planToken, nodeToken: nodeTokens.get(context.nodeId), explicitRetry: options.explicitRetry }, () => deps.runTool(toolName, args, context)),
    onNodeUpdate, claimNode, releaseNode,
    isRunOwner: planToken === undefined ? undefined : () => planExecutionClaimHeld(planId, planToken),
    controls: defaultPollControls(planId),
    ...createTaskPersistence(planId, { mode, planToken, nodeToken: nodeId => nodeTokens.get(nodeId) }),
  };
}

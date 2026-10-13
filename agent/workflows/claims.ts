import type { TaskNodeStatus } from '@/lib/contracts/task';
import { WORKFLOW_EXECUTION_LEASE_MS } from '@/lib/contracts/runtime';
import type { PlanDeps } from '@/planner';
import { prisma } from '@/lib/db/client';
import { claimNodeExecution, releaseNodeExecution } from '@/lib/db/repositories/task';

export const TERMINAL_NODE_STATUSES: TaskNodeStatus[] = ['success', 'failed', 'skipped', 'cancelled'];

/** Claims use the real clock; the pinned demo clock cannot measure owner liveness. */
export function staleExecutionClaimBefore(): Date {
  return new Date(Date.now() - WORKFLOW_EXECUTION_LEASE_MS);
}

async function renewTaskExecutionClaim(taskId: string, token: string): Promise<void> {
  await prisma.agentTask.updateMany({
    where: { id: taskId, executionToken: token },
    data: { executionClaimedAt: new Date() },
  });
}

/** A takeover clears only nonterminal child claims while still owning the parent. */
export async function clearStaleNodeClaims(planId: string, planToken: string): Promise<void> {
  await prisma.agentTaskNode.updateMany({
    where: { taskId: planId, status: { notIn: TERMINAL_NODE_STATUSES }, task: { executionToken: planToken } },
    data: { executionToken: null, executionClaimedAt: null },
  });
}

export async function planExecutionClaimHeld(planId: string, token: string): Promise<boolean> {
  const row = await prisma.agentTask.findUnique({ where: { id: planId }, select: { executionToken: true } });
  return row?.executionToken === token;
}

/** Parent ownership and child claim acquisition share one atomic database predicate. */
export function buildNodeClaimPorts(planId: string, planToken: string | undefined): {
  claimNode: NonNullable<PlanDeps['claimNode']>;
  releaseNode: NonNullable<PlanDeps['releaseNode']>;
  nodeTokens: Map<string, string>;
} {
  const nodeTokens = new Map<string, string>();
  return {
    nodeTokens,
    claimNode: async (taskId, nodeId, token) => {
      if (planToken !== undefined) await renewTaskExecutionClaim(planId, planToken);
      let won: boolean;
      if (planToken === undefined) {
        won = await claimNodeExecution(taskId, nodeId, token, { staleBefore: staleExecutionClaimBefore() });
      } else {
        const claimed = await prisma.agentTaskNode.updateMany({
          where: {
            taskId: planId, nodeId, status: { notIn: TERMINAL_NODE_STATUSES }, task: { executionToken: planToken },
            OR: [{ executionToken: null }, { executionClaimedAt: { lt: staleExecutionClaimBefore() } }],
          },
          data: { executionToken: token, executionClaimedAt: new Date() },
        });
        won = claimed.count === 1;
      }
      if (won) nodeTokens.set(nodeId, token);
      return won;
    },
    releaseNode: async (taskId, nodeId, token) => {
      nodeTokens.delete(nodeId);
      await releaseNodeExecution(taskId, nodeId, token);
      if (planToken !== undefined) await renewTaskExecutionClaim(planId, planToken);
    },
  };
}

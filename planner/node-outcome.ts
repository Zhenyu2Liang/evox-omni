import type { TaskNodeResult, TaskNodeSpec } from '@/lib/contracts/task';
import type { PlanToolOutcome } from './executor';

/** One outcome mapping shared by initial execution and confirmation continuation. */
export function settleToolNode(
  node: TaskNodeSpec,
  outcome: PlanToolOutcome,
  startedAt: number,
  endedAt: number,
): TaskNodeResult & { summary?: string; pendingActionId?: string } {
  const base = { id: node.id, name: node.name, tool: node.tool, startedAt, endedAt };
  if (outcome.ok) {
    return {
      ...base,
      status: 'success',
      output: outcome.data === undefined && outcome.summary !== undefined ? { summary: outcome.summary } : outcome.data,
      ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
    };
  }
  if (outcome.requiresConfirmation || outcome.pendingActionId !== undefined) {
    const isRed = (node as TaskNodeSpec & { riskLevel?: unknown }).riskLevel === 'RED';
    return {
      ...base,
      status: isRed ? 'waiting_verification' : 'waiting_confirmation',
      output: outcome.pendingActionId !== undefined ? { pendingActionId: outcome.pendingActionId } : undefined,
      error: outcome.error,
      ...(outcome.pendingActionId !== undefined ? { pendingActionId: outcome.pendingActionId } : {}),
    };
  }
  return { ...base, status: 'failed', error: outcome.error ?? `Tool execution failed: ${node.tool ?? node.id}` };
}

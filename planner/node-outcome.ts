import type { TaskNodeSpec } from '@/lib/contracts/task';
import type { PlanToolOutcome } from './executor';
import type { PlanNodeResult } from './failure';
import { publicFailureText } from './failure';

/**
 * One outcome mapping shared by initial execution and confirmation continuation.
 *
 * The structured refusal facts (`failure` / `actionStatus`) are carried through VERBATIM so a
 * renderer can use them (`lib/public-text#securityNotice`) instead of falling back to a generic
 * message; the renderable text fields (`summary` / `error`) are projected through
 * `publicFailureText`, so a raw gateway payload never lands on the node.
 */
export function settleToolNode(
  node: TaskNodeSpec,
  outcome: PlanToolOutcome,
  startedAt: number,
  endedAt: number,
): PlanNodeResult {
  const base = { id: node.id, name: node.name, tool: node.tool, startedAt, endedAt };
  const summary = publicFailureText(outcome.summary);
  const error = publicFailureText(outcome.error);
  const structured = {
    ...(outcome.failure !== undefined ? { failure: outcome.failure } : {}),
    ...(outcome.actionStatus !== undefined ? { actionStatus: outcome.actionStatus } : {}),
  };
  if (outcome.ok) {
    return {
      ...base,
      status: 'success',
      output: outcome.data === undefined && summary !== undefined ? { summary } : outcome.data,
      ...(summary !== undefined ? { summary } : {}),
      ...structured,
    };
  }
  if (outcome.requiresConfirmation || outcome.pendingActionId !== undefined) {
    const isRed = (node as TaskNodeSpec & { riskLevel?: unknown }).riskLevel === 'RED';
    return {
      ...base,
      status: isRed ? 'waiting_verification' : 'waiting_confirmation',
      output: outcome.pendingActionId !== undefined ? { pendingActionId: outcome.pendingActionId } : undefined,
      error,
      ...(outcome.pendingActionId !== undefined ? { pendingActionId: outcome.pendingActionId } : {}),
      ...structured,
    };
  }
  return {
    ...base,
    status: 'failed',
    error: error ?? `Tool execution failed: ${node.tool ?? node.id}`,
    ...structured,
  };
}

import type { AgentTaskNode, PendingAction } from '@prisma/client';
import type { ManualHandoffStatus } from '@/lib/contracts/manual-review';

export interface ReviewTaskState {
  status: string;
  executionToken: string | null;
  nodes: AgentTaskNode[];
}

export interface ReviewControlState {
  handoffStatus: ManualHandoffStatus;
  mayStop: boolean;
  mayResume: boolean;
  workflowStatus?: string;
}

/** A handoff request is durable immediately; operator control starts only at a safe checkpoint. */
export function reviewControlState(status: 'open' | 'closed', task: ReviewTaskState | null,
  actions: readonly PendingAction[]): ReviewControlState {
  const inFlight = task?.executionToken !== null && task?.executionToken !== undefined
    || task?.nodes.some(node => node.status === 'running') === true
    || actions.some(action => action.status === 'confirmed');
  const settled = !inFlight;
  const hasUnknown = actions.some(action => action.status === 'needs_reconciliation');
  const hasFailed = task?.nodes.some(node => node.status === 'failed') === true;
  return {
    handoffStatus: status === 'closed' ? 'resolved' : settled ? 'operator_controlled' : 'human_review_requested',
    mayStop: status === 'open' && settled,
    mayResume: settled && !hasUnknown && !hasFailed && task !== null
      && ['paused', 'waiting_confirmation'].includes(task.status),
    workflowStatus: task?.status,
  };
}

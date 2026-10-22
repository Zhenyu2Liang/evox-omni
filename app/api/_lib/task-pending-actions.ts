/**
 * app/api/_lib/task-pending-actions.ts — additive READ-ONLY projection of a parked
 * `PendingAction`'s CURRENT persisted status onto the task-plan read models.
 *
 * WHY: a DAG node parked on a human decision is persisted as
 * `waiting_confirmation` / `waiting_verification` with `{ pendingActionId }` in its `output`;
 * `_lib/task-plans.ts#toTaskPlan` lifts that id into the additive `node.pendingActionId`. On its
 * own that id makes the read model look like "the decision is still open", even when the security
 * gateway has since parked the action in the TERMINAL `locked` state (MFA attempt limit exhausted,
 * persisted as `PendingAction.status = 'locked'` from `pending`/`awaiting_mfa`). A client reading
 * `GET /api/tasks` or `GET /api/tasks/[id]` therefore needs the action's real status to stop
 * offering a verification entry that can never succeed.
 *
 * WHAT THIS ADDS (strictly additive, ONE new optional field):
 *  - `pendingActionStatus?: PendingActionStatus` on nodes that carry a `pendingActionId` whose row
 *    still exists. It is the action's CURRENT persisted status — nothing else.
 *  - `locked` is TERMINAL: the decision can never be completed and no retry/reopen path exists in
 *    this layer; the user must start a NEW request. `pending`/`awaiting_mfa` are the only statuses
 *    that still await a human decision.
 *
 * WHAT THIS MUST NEVER DO:
 *  - no write of any kind (no `PendingAction.status` mutation, no recovery, no execution, no retry);
 *  - no change to `node.status` and no stripping of `node.pendingActionId`;
 *  - no fabricated status: a missing row simply omits the field (missing evidence proves nothing);
 *  - no business logic / security decision — the mapping is pure and the status is reported verbatim.
 *
 * Batching: `loadPendingActionStatuses` resolves each DISTINCT id exactly once in a single
 * `Promise.all` round, so listing many plans costs one lookup per distinct action (never N+1).
 *
 * `_lib` is a Next.js private folder (leading underscore) — it never becomes a route.
 */
import type { PendingActionStatus } from '@/lib/contracts/security';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import type { AppTaskNodeResult, AppTaskPlan } from './task-plans';

/**
 * An `AppTaskNodeResult` ADDITIVELY carrying the parked action's CURRENT persisted status.
 *
 * Absent when the node has no `pendingActionId`, or when that id no longer resolves to a row.
 */
export type TaskNodeWithDecisionState = AppTaskNodeResult & {
  pendingActionStatus?: PendingActionStatus;
};

/** An `AppTaskPlan` whose `results` additively carry each node's `pendingActionStatus`. */
export type TaskPlanWithDecisionState = Omit<AppTaskPlan, 'results'> & {
  results: TaskNodeWithDecisionState[];
};

/**
 * Resolve the CURRENT persisted status of every referenced `PendingAction` in ONE batch.
 *
 * Dedupes the ids, skips empty ones, and leaves ids whose row does not exist OUT of the map (the
 * caller then omits the field rather than inventing a status). Read-only: the sanctioned repository
 * reader is used, nothing is claimed or written.
 */
export async function loadPendingActionStatuses(
  ids: Iterable<string>,
): Promise<Map<string, PendingActionStatus>> {
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    distinct.push(id);
  }
  if (distinct.length === 0) return new Map();

  // ONE round for every distinct id — no per-id sequential loop.
  const rows = await Promise.all(distinct.map(id => getPendingAction(id)));

  const statuses = new Map<string, PendingActionStatus>();
  distinct.forEach((id, index) => {
    const row = rows[index];
    if (row) statuses.set(id, row.status as PendingActionStatus);
  });
  return statuses;
}

/**
 * Pure mapping: annotate a plan's decision-parked nodes with their already-loaded action statuses.
 *
 * `node.status` is preserved, `node.pendingActionId` is preserved, and a node whose id is missing
 * from `statuses` (unknown/deleted row) simply gets no `pendingActionStatus` field.
 */
export function annotatePendingActionStatuses(
  plan: AppTaskPlan,
  statuses: ReadonlyMap<string, PendingActionStatus>,
): TaskPlanWithDecisionState {
  return {
    ...plan,
    results: plan.results.map((node): TaskNodeWithDecisionState => {
      const status = node.pendingActionId ? statuses.get(node.pendingActionId) : undefined;
      return status === undefined ? node : { ...node, pendingActionStatus: status };
    }),
  };
}

/** Collect every parked `pendingActionId` referenced by the given plans (feeds the batch loader). */
function pendingActionIdsOf(plans: readonly AppTaskPlan[]): string[] {
  const ids: string[] = [];
  for (const plan of plans) {
    for (const node of plan.results) {
      if (node.pendingActionId) ids.push(node.pendingActionId);
    }
  }
  return ids;
}

/**
 * Annotate ONE plan, loading the statuses of its referenced actions in a single batch.
 * Delegates the mapping to {@link annotatePendingActionStatuses}.
 */
export async function withPendingActionStatuses(plan: AppTaskPlan): Promise<TaskPlanWithDecisionState> {
  const statuses = await loadPendingActionStatuses(pendingActionIdsOf([plan]));
  return annotatePendingActionStatuses(plan, statuses);
}

/**
 * Annotate MANY plans in ONE status batch across ALL of them (the list endpoint's shape), so the
 * total work is a single lookup per distinct action regardless of how many plans/nodes are listed.
 * Order is preserved and each plan is mapped by {@link annotatePendingActionStatuses}.
 */
export async function withPendingActionStatusesForPlans(
  plans: readonly AppTaskPlan[],
): Promise<TaskPlanWithDecisionState[]> {
  const statuses = await loadPendingActionStatuses(pendingActionIdsOf(plans));
  return plans.map(plan => annotatePendingActionStatuses(plan, statuses));
}

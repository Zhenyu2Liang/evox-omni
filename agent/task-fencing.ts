/**
 * task-fencing.ts — the FENCED write primitives for durable plan/node persistence.
 *
 * `task-control.ts` owns the control/resume GLUE (execution claims, status CAS transitions, the
 * cancel sweep); THIS module owns HOW a plan snapshot / a decided node result reaches the
 * `AgentTask` / `AgentTaskNode` rows and how such a write is FENCED on the execution claim of the run
 * that makes it.
 *
 * Two writers:
 *
 * 1. `createTaskPersistence` — the planner's persistence ports, fenced per `TaskPersistenceOptions`
 *    (declared in `task-control.ts`): an EXECUTOR pass always fences (the NODE claim token, else the
 *    PLAN claim token) and therefore has NO unfenced write path at all; a CONTROL pass
 *    (`pauseTask`/`cancelTask`) writes deliberately unfenced — it holds no claim to fence on.
 * 2. `recordDecidedNodeFenced` — the confirm/verify CONTINUATION when it LOST the plan claim. It may
 *    not drive the plan (the LIVE owner does), but the human decision must never be dropped, so it
 *    records that ONE decided node through a single atomic OWNERSHIP-validated write (the node claim
 *    token, else the plan claim token, else — with NO owner left — a no-owner CAS that skips the write
 *    if a takeover has since claimed the plan); with NO owner left it also settles the plan status
 *    from the persisted node rows (`settlePlanFromNodes`), so a plan whose every node is terminal can
 *    never dangle a stale `waiting_confirmation`.
 *
 * The fence always lives INSIDE the single `updateMany` / compare-and-set statement (see
 * `lib/db/repositories/task.ts`), so ownership is verified ATOMICALLY with the write: a run whose
 * claim was taken over matches 0 rows and SKIPS its stale result instead of clobbering the takeover's.
 */
import type { TaskNodeResult, TaskNodeStatus, TaskPlanStatus } from '@/lib/contracts/task';
import type { PlanToolOutcome } from '@/planner';
import { demoNow } from '@/lib/clock';
import { toJson } from '@/lib/json';
import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/db/client';
import { synchronizeStandaloneWorkflowRun } from '@/lib/db/repositories/workflowRun';
import {
  getTask,
  getTaskNode,
  updateTaskNode,
  type UpdateTaskNodeInput,
} from '@/lib/db/repositories/task';

/** The JSON-text `output` column value for a node result (mirrors the repository's mapping). */
export function jsonNodeOutput(node: TaskNodeResult): string | null {
  return node.output === undefined || node.output === null ? null : toJson(node.output);
}

/** Map a planner `TaskNodeResult` to the repository's node-update payload (used by every mode). */
export function toNodeUpdate(node: TaskNodeResult): UpdateTaskNodeInput {
  return {
    status: node.status,
    output: node.output ?? null,
    error: node.error ?? null,
    startedAt: node.startedAt === undefined ? undefined : new Date(node.startedAt),
    endedAt: node.endedAt === undefined ? undefined : new Date(node.endedAt),
  };
}

/** Only a typed missing-node error can retire a stale persistence callback. */
export function isMissingNodeError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'NOT_FOUND' &&
    typeof error.detail === 'object' && error.detail !== null &&
    'resource' in error.detail && error.detail.resource === 'AgentTaskNode';
}

/** A decided node result plus the two bookkeeping hints the planner contract carries alongside it. */
type DecidedNodeResult = TaskNodeResult & { summary?: string; pendingActionId?: string };

/**
 * Derive the node result of a HUMAN decision EXACTLY as `planner/lifecycle.ts#resumePlan` does
 * (`ok` ⇒ `success` with `data` (or `{summary}`); a re-park ⇒ `waiting_confirmation`; anything else ⇒
 * `failed`), so the recorded row is identical no matter which path writes it.
 *
 * The planner picks `waiting_verification` over `waiting_confirmation` from an OPTIONAL `riskLevel` on
 * the node SPEC; a persisted node row has no such column, so a re-park recorded here is always
 * `waiting_confirmation` (the PLAN row carries `waiting_confirmation` either way, and a re-park only
 * happens when the gateway asked for another human decision).
 */
function decidedNodeResult(
  node: { id: string; name: string; tool?: string },
  previousStartedAt: number | undefined,
  outcome: PlanToolOutcome,
  now: number,
): DecidedNodeResult {
  let status: TaskNodeStatus;
  if (outcome.ok) {
    status = 'success';
  } else if (outcome.requiresConfirmation || outcome.pendingActionId !== undefined) {
    status = 'waiting_confirmation';
  } else {
    status = 'failed';
  }

  const updated: DecidedNodeResult = {
    id: node.id,
    name: node.name,
    status,
    tool: node.tool,
    startedAt: previousStartedAt ?? now,
    endedAt: now,
  };
  if (status === 'success') {
    let output = outcome.data;
    if (output === undefined && outcome.summary !== undefined) output = { summary: outcome.summary };
    updated.output = output;
    if (outcome.summary !== undefined) updated.summary = outcome.summary;
  } else if (status === 'failed') {
    updated.error = outcome.error ?? `tool '${node.tool ?? node.id}' failed`;
  } else {
    updated.output =
      outcome.pendingActionId !== undefined ? { pendingActionId: outcome.pendingActionId } : undefined;
    updated.error = outcome.error;
    if (outcome.pendingActionId !== undefined) updated.pendingActionId = outcome.pendingActionId;
  }
  return updated;
}

/** Input of `recordDecidedNodeFenced`: which node of which plan a human decision settled. */
export interface DecidedNodeInput {
  /** The owning `AgentTask.id` (= the canonical plan id). */
  taskId: string;
  /** The decided `AgentTaskNode.nodeId`. */
  nodeId: string;
  /** The REAL `PlanToolOutcome` of the decided tool (never model text). */
  outcome: PlanToolOutcome;
  /** Injectable clock for deterministic tests; defaults to the demo clock. */
  now?: () => number;
}

/**
 * Node statuses a plan may be settled FROM: a `settlePlanFromNodes` pass only derives a plan status
 * once every node has stopped moving on its own (mirrors `planner/executor.ts`'s `TERMINAL` set
 * MINUS `'cancelled'` — a cancelled node belongs to `cancelTask`, which owns that plan status).
 */
const SETTLEABLE_NODE_STATUSES: ReadonlySet<TaskNodeStatus> = new Set<TaskNodeStatus>([
  'success',
  'failed',
  'skipped',
]);

/** Plan statuses `settlePlanFromNodes` may move: the live, non-terminal, non-paused ones. */
const SETTLEABLE_PLAN_STATUSES: TaskPlanStatus[] = ['pending', 'running', 'waiting_confirmation'];

/**
 * Settle a plan's PERSISTED status from its PERSISTED node rows, but ONLY when NO executor owns the
 * plan (`executionToken IS NULL`).
 *
 * A LOST-claim confirm-continuation records the human-decided node on a plan whose LIVE owner had
 * ALREADY published its (now stale) snapshot — the owner saw the node re-parked, released its claim
 * and stopped; the continuation then made that node terminal. Without this settle the plan would
 * dangle `waiting_confirmation` with every node terminal (a wedged, stale summary). The derivation
 * mirrors the executor's own settlement: every node `success`/`skipped` ⇒ `'success'`, else `'failed'`.
 *
 * Safe by construction:
 * - a LIVE claim (`executionToken` set) is the single writer of the plan status, so this pass SKIPS;
 *   the condition is re-checked INSIDE the single `updateMany`, so a claim taken between the read and
 *   the write still wins;
 * - a `'cancelled'` plan is terminal and a `'paused'` plan must be RETAINED (pause retention), so both
 *   are left untouched;
 * - only statuses whose every node is terminal are eligible, so nothing is settled mid-walk.
 *
 * Returns `true` iff the plan status was written.
 */
export async function settlePlanFromNodes(taskId: string): Promise<boolean> {
  const row = await getTask(taskId);
  if (row === null) return false;
  if (row.executionToken !== null) return false; // a LIVE executor owns the plan status
  if (row.status === 'cancelled' || row.status === 'paused') return false;
  if (row.nodes.length === 0) return false;

  const statuses = row.nodes.map((node) => node.status as TaskNodeStatus);
  if (!statuses.every((status) => SETTLEABLE_NODE_STATUSES.has(status))) return false;

  const settled: TaskPlanStatus = statuses.every(
    (status) => status === 'success' || status === 'skipped',
  )
    ? 'success'
    : 'failed';
  if (row.status === settled) return false;

  return prisma.$transaction(async transaction => {
    const written = await transaction.agentTask.updateMany({
      where: { id: taskId, executionToken: null, status: { in: SETTLEABLE_PLAN_STATUSES } },
      data: { status: settled },
    });
    if (written.count > 0) await synchronizeStandaloneWorkflowRun(taskId, transaction);
    return written.count > 0;
  });
}

/**
 * Record a HUMAN decision's outcome on plan node `(taskId, nodeId)` through a SINGLE atomic FENCED
 * write, WITHOUT running the plan.
 *
 * Used by the confirm/verify continuation when it LOST the plan's execution claim — a LIVE executor
 * owns the plan right now, so the continuation must not drive the walk (two overlapping walks could
 * LAUNCH a node twice). It must not drop the decision either: the node is parked on an action this
 * continuation just settled, so its terminal outcome is recorded here and the LIVE owner observes it
 * on its own next write, i.e. the plan does not wedge.
 *
 * Fence precedence:
 * 1. the node's OWN current `AgentTaskNode.executionToken` (read now, fenced via `updateTaskNode`);
 * 2. else the LIVE owner's PLAN token (`AgentTask.executionToken`, read now) — the usual branch,
 *    because the executor RELEASES a parked node's claim in its `finally`, so a parked node has NO
 *    token of its own;
 * 3. else no claim exists at all (the owner released it between the reads): the decision is recorded
 *    through a single atomic NO-OWNER CAS — one `updateMany` conditioned on the plan still holding NO
 *    execution token (`task: { executionToken: null }`, the same predicate `settlePlanFromNodes` uses)
 *    — so a takeover that ACQUIRED the claim between our read and this write makes the statement match
 *    0 rows and SKIPS, never clobbering the takeover's row. The plan status is then settled from the
 *    persisted node rows (see `settlePlanFromNodes`), because no executor is left to publish it.
 *
 * There is therefore NO non-CAS / unfenced write in this module: every branch is a single-statement
 * ownership CAS.
 *
 * Returns `true` iff the outcome was written. `false` means the plan/node row is gone, or the
 * node/plan claim changed under us — in which case a LIVE owner of that very node writes the truth.
 */
export async function recordDecidedNodeFenced(input: DecidedNodeInput): Promise<boolean> {
  const now = input.now ?? (() => demoNow());
  const row = await getTask(input.taskId);
  if (row === null) return false;
  const spec = row.nodes.find((node) => node.nodeId === input.nodeId);
  if (spec === undefined) return false;

  const nodeRow = await getTaskNode(input.taskId, input.nodeId);
  const decided = decidedNodeResult(
    { id: spec.nodeId, name: spec.name, tool: spec.tool ?? undefined },
    nodeRow?.startedAt?.getTime(),
    input.outcome,
    now(),
  );
  const update = toNodeUpdate(decided);

  // 1. NODE fence — one atomic write conditioned on this node claim still being the current one.
  const nodeToken = nodeRow?.executionToken ?? undefined;
  if (nodeToken !== undefined) {
    const written = await updateTaskNode(input.taskId, input.nodeId, update, {
      fenceToken: nodeToken,
    });
    // `null` = the claim changed under us: a LIVE owner of that very node is recording the truth.
    return written !== null;
  }

  // 2. PLAN fence — the LIVE owner's claim token, still verified INSIDE the statement
  // (`task: { executionToken }`), so the write lands only while a live owner holds the plan.
  const planToken = row.executionToken ?? undefined;
  if (planToken !== undefined) {
    const res = await prisma.agentTaskNode.updateMany({
      where: { taskId: input.taskId, nodeId: input.nodeId, task: { executionToken: planToken } },
      data: { ...update, output: jsonNodeOutput(decided) },
    });
    return res.count > 0;
  }

  // 3. No owner at all: an atomic NO-OWNER fence, one `updateMany` conditioned on the plan still
  //    holding NO execution token (`task: { executionToken: null }`, the predicate `settlePlanFromNodes`
  //    uses), so a takeover that ACQUIRED the claim between our read and this write matches 0 rows and
  //    SKIPS. With NO executor left THIS continuation then settles the plan status from its now-terminal
  //    node rows (see `settlePlanFromNodes`).
  const res = await prisma.agentTaskNode.updateMany({
    where: { taskId: input.taskId, nodeId: input.nodeId, task: { executionToken: null } },
    data: { ...update, output: jsonNodeOutput(decided) },
  });
  if (res.count === 0) return false;
  await settlePlanFromNodes(input.taskId);
  return true;
}

/**
 * app/api/_lib/task-plans.ts — read-side mapping from persisted `AgentTask` rows to the frozen
 * `TaskPlan` transport contract (`@/lib/contracts/task`).
 *
 * The `@/planner` facade (READ-ONLY sibling) exposes NO plan-store reader: plans are persisted
 * only as `AgentTask` + `AgentTaskNode` Prisma rows, and the executor's `PlanControls` are
 * in-process (not reachable across HTTP requests). The task-plan read models therefore go through
 * the sanctioned repository read path (`@/lib/db/repositories/task`) and are mapped to `TaskPlan`
 * here — the mapping is pure (JSON columns decoded with `safeParse`), so it stays transport-thin
 * and holds no business logic.
 *
 * ADDITIVE surface (`AppTaskPlan` / `AppTaskNodeResult`): the frozen `TaskNodeResult` contract has
 * no `pendingActionId`, but the UI needs it to RESTORE the confirm/MFA entry after a page refresh.
 * We therefore widen the APP-LOCAL return type with an extra optional `pendingActionId`, extracted
 * from each node's persisted `output` (`{ pendingActionId?: string }`, the canonical shape written
 * by `@/agent` task-control) via its own reader `readPendingActionId`. The frozen contract is NOT
 * modified — an `AppTaskPlan` is still assignable to `TaskPlan`.
 *
 * `_lib` is a Next.js private folder (leading underscore) — it never becomes a route.
 */
import type { AgentTask, AgentTaskNode } from '@/lib/db/prisma';
import { readPendingActionId } from '@/agent';
import { safeParse } from '@/lib/json';
import type {
  TaskCondition,
  TaskNodeKind,
  TaskNodeResult,
  TaskNodeSpec,
  TaskNodeStatus,
  TaskPlan,
  TaskPlanStatus,
} from '@/lib/contracts/task';

/** A persisted task with its ordered node rows (`@/lib/db/repositories/task#getTask`). */
export type AgentTaskWithNodes = AgentTask & { nodes: AgentTaskNode[] };

/**
 * A `TaskNodeResult` ADDITIVELY carrying the parked pending-action id.
 *
 * `pendingActionId` is present only while the node is parked awaiting a human decision; it is
 * absent once the action settles (the executor clears it from `output`).
 */
export type AppTaskNodeResult = TaskNodeResult & { pendingActionId?: string };

/** A `TaskPlan` whose `results` carry the additive `pendingActionId` (still assignable to `TaskPlan`). */
export type AppTaskPlan = Omit<TaskPlan, 'results'> & { results: AppTaskNodeResult[] };

/** Map one persisted node row to a `TaskNodeSpec` (the plan's declared node shape). */
function toNodeSpec(node: AgentTaskNode): TaskNodeSpec {
  return {
    id: node.nodeId,
    name: node.name,
    dependencies: safeParse<string[]>(node.dependencies, []),
    ...(node.after ? { after: safeParse<string[]>(node.after, []) } : {}),
    kind: node.kind as TaskNodeKind,
    tool: node.tool ?? undefined,
    args: safeParse<Record<string, unknown> | undefined>(node.args, undefined),
    condition: safeParse<TaskCondition | undefined>(node.condition, undefined),
  };
}

/**
 * Map one persisted node row to an `AppTaskNodeResult` (the plan's runtime outcome shape).
 *
 * `pendingActionId` is lifted from the parsed `output` via the canonical `@/agent` reader — it is
 * `undefined` for an ordinary started/ended node and set only while the node awaits a decision.
 */
function toNodeResult(node: AgentTaskNode): AppTaskNodeResult {
  const output = safeParse<Record<string, unknown> | undefined>(node.output, undefined);
  return {
    id: node.nodeId,
    name: node.name,
    status: node.status as TaskNodeStatus,
    tool: node.tool ?? undefined,
    output,
    error: node.error ?? undefined,
    startedAt: node.startedAt?.getTime(),
    endedAt: node.endedAt?.getTime(),
    ...(node.compensation ? { compensation: safeParse(node.compensation, undefined) } : {}),
    pendingActionId: readPendingActionId(output),
  };
}

/**
 * Map a persisted task row (plus its ordered nodes) to the APP-LOCAL `AppTaskPlan` (a `TaskPlan`
 * whose `results` additively carry each node's `pendingActionId`).
 *
 * `AgentTask.status`/`AgentTaskNode.status` are stored as free-form strings (SQLite has no enum);
 * they are cast to the frozen `TaskPlanStatus`/`TaskNodeStatus` unions, mirroring how the planner
 * persists them.
 */
export function toTaskPlan(row: AgentTaskWithNodes): AppTaskPlan {
  return {
    id: row.id,
    sessionId: row.sessionId,
    goal: row.goal,
    status: row.status as TaskPlanStatus,
    nodes: row.nodes.map(toNodeSpec),
    results: row.nodes.map(toNodeResult),
    createdAt: row.createdAt.getTime(),
    generation: row.generation,
    updatedAt: row.updatedAt.getTime(),
  };
}

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
 * `_lib` is a Next.js private folder (leading underscore) — it never becomes a route.
 */
import type { AgentTask, AgentTaskNode } from '@prisma/client';
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

/** Map one persisted node row to a `TaskNodeSpec` (the plan's declared node shape). */
function toNodeSpec(node: AgentTaskNode): TaskNodeSpec {
  return {
    id: node.nodeId,
    name: node.name,
    dependencies: safeParse<string[]>(node.dependencies, []),
    kind: node.kind as TaskNodeKind,
    tool: node.tool ?? undefined,
    args: safeParse<Record<string, unknown> | undefined>(node.args, undefined),
    condition: safeParse<TaskCondition | undefined>(node.condition, undefined),
  };
}

/** Map one persisted node row to a `TaskNodeResult` (the plan's runtime outcome shape). */
function toNodeResult(node: AgentTaskNode): TaskNodeResult {
  return {
    id: node.nodeId,
    name: node.name,
    status: node.status as TaskNodeStatus,
    tool: node.tool ?? undefined,
    output: safeParse(node.output, undefined),
    error: node.error ?? undefined,
    startedAt: node.startedAt?.getTime(),
    endedAt: node.endedAt?.getTime(),
  };
}

/**
 * Map a persisted task row (plus its ordered nodes) to the frozen `TaskPlan` contract.
 *
 * `AgentTask.status`/`AgentTaskNode.status` are stored as free-form strings (SQLite has no enum);
 * they are cast to the frozen `TaskPlanStatus`/`TaskNodeStatus` unions, mirroring how the planner
 * persists them.
 */
export function toTaskPlan(row: AgentTaskWithNodes): TaskPlan {
  return {
    id: row.id,
    sessionId: row.sessionId,
    goal: row.goal,
    status: row.status as TaskPlanStatus,
    nodes: row.nodes.map(toNodeSpec),
    results: row.nodes.map(toNodeResult),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

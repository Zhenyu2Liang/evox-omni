import { Prisma } from '@prisma/client';
import type { AgentTask, AgentTaskNode } from '@prisma/client';
import { prisma } from '../client';
import { toJson } from '../../json';
import type { TaskCondition, TaskPlanStatus } from '../../contracts/task';

export type AgentTaskWithNodes = AgentTask & { nodes: AgentTaskNode[] };

export interface CreateTaskInput {
  sessionId: string;
  userId: string;
  goal: string;
  status?: string;
}

export interface CreateTaskNodeInput {
  taskId: string;
  nodeId: string;
  name: string;
  kind: string;
  order: number;
  tool?: string | null;
  args?: Record<string, unknown> | null;
  condition?: TaskCondition | null;
  dependencies?: string[];
  status?: string;
}

export interface UpdateTaskNodeInput {
  status?: string;
  output?: unknown;
  error?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

export function createTask(input: CreateTaskInput): Promise<AgentTask> {
  return prisma.agentTask.create({
    data: {
      sessionId: input.sessionId,
      userId: input.userId,
      goal: input.goal,
      status: input.status ?? 'pending',
    },
  });
}

export function getTask(id: string): Promise<AgentTaskWithNodes | null> {
  return prisma.agentTask.findUnique({
    where: { id },
    include: { nodes: { orderBy: { order: 'asc' } } },
  });
}

export function listTasksBySession(sessionId: string): Promise<AgentTask[]> {
  return prisma.agentTask.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Unconditional status setter — a blind set with no compare-and-set guard. Retained for
 * callers that genuinely need to force a status. For any transition that must be exactly-once
 * or must respect a terminal state, use `claimTaskStatus` (the PREFERRED concurrency-safe path).
 */
export function updateTaskStatus(id: string, status: string): Promise<AgentTask> {
  return prisma.agentTask.update({ where: { id }, data: { status } });
}

/**
 * The concurrency guard for an `AgentTask` status transition.
 *
 * Performs a SINGLE atomic compare-and-set: the task's status is moved from any of
 * `fromStatuses` to `toStatus` ONLY IF it currently matches one of `fromStatuses`.
 * Returns `true` iff exactly one row was transitioned.
 *
 * Because the transition is one `updateMany` statement, this:
 * (a) stops two concurrent resume/retry calls from both proceeding — the loser's
 *     `status IN fromStatuses` no longer matches, so it transitions 0 rows and returns `false`;
 * (b) stops a cancelled/terminal plan from being moved back to a non-terminal state — when the
 *     current status is not in `fromStatuses` the CAS matches 0 rows and returns `false`.
 *
 * Contract callers read the current status via `getTask(id)` (which returns the task row
 * including `status`) before deciding which transition to claim.
 */
export async function claimTaskStatus(
  taskId: string,
  fromStatuses: TaskPlanStatus[],
  toStatus: TaskPlanStatus,
): Promise<boolean> {
  const result = await prisma.agentTask.updateMany({
    where: { id: taskId, status: { in: fromStatuses } },
    data: { status: toStatus },
  });
  return result.count === 1;
}

/**
 * Exactly-once claim of the PLAN executor slot for `taskId`.
 *
 * A SINGLE atomic `updateMany` stamps `executionToken = token` / `executionClaimedAt = now`
 * ONLY WHERE the row is currently unclaimed (`executionToken IS NULL`) or, when `opts.staleBefore`
 * is supplied, its `executionClaimedAt` is older than that instant (a stale-claim takeover).
 * Returns `true` iff exactly one row was updated (this caller won); a concurrent claimant
 * transitions 0 rows and returns `false`.
 *
 * Fail-safe: when `opts.staleBefore` is NOT supplied only an unclaimed (token NULL) row is
 * claimable. A row whose token is set but whose `executionClaimedAt` is NULL is NOT reclaimable
 * via the stale path — SQL `NULL < x` evaluates to NULL (not true), so the stale OR-branch never
 * matches; such a row stays claimed until released by its owner.
 */
export async function claimTaskExecution(
  taskId: string,
  token: string,
  opts?: { staleBefore?: Date },
): Promise<boolean> {
  const staleBefore = opts?.staleBefore;
  const result = await prisma.agentTask.updateMany({
    where: {
      id: taskId,
      OR: [
        { executionToken: null },
        ...(staleBefore ? [{ executionClaimedAt: { lt: staleBefore } }] : []),
      ],
    },
    data: { executionToken: token, executionClaimedAt: new Date() },
  });
  return result.count === 1;
}

/**
 * Release the PLAN executor claim for `taskId`, clearing the token ONLY where it is still this
 * caller's `token`. A non-owner's token does not match, so nothing is released. The affected-row
 * count is irrelevant, so this returns `void`.
 */
export async function releaseTaskExecution(
  taskId: string,
  token: string,
): Promise<void> {
  await prisma.agentTask.updateMany({
    where: { id: taskId, executionToken: token },
    data: { executionToken: null, executionClaimedAt: null },
  });
}

export function createTaskNode(input: CreateTaskNodeInput): Promise<AgentTaskNode> {
  return prisma.agentTaskNode.create({
    data: {
      taskId: input.taskId,
      nodeId: input.nodeId,
      name: input.name,
      kind: input.kind,
      order: input.order,
      tool: input.tool ?? null,
      args: input.args == null ? null : toJson(input.args),
      condition: input.condition == null ? null : toJson(input.condition),
      dependencies: input.dependencies == null ? null : toJson(input.dependencies),
      status: input.status ?? 'pending',
    },
  });
}

export function getTaskNode(
  taskId: string,
  nodeId: string,
): Promise<AgentTaskNode | null> {
  return prisma.agentTaskNode.findFirst({
    where: { taskId, nodeId },
    orderBy: { order: 'asc' },
  });
}

export function updateTaskNode(
  taskId: string,
  nodeId: string,
  update: UpdateTaskNodeInput,
): Promise<AgentTaskNode> {
  const data: Prisma.AgentTaskNodeUpdateInput = {};
  if (update.status !== undefined) data.status = update.status;
  if (update.output !== undefined) {
    data.output = update.output === null ? null : toJson(update.output);
  }
  if (update.error !== undefined) data.error = update.error;
  if (update.startedAt !== undefined) data.startedAt = update.startedAt;
  if (update.endedAt !== undefined) data.endedAt = update.endedAt;

  return firstNodeId(taskId, nodeId).then((id) =>
    prisma.agentTaskNode.update({ where: { id }, data }),
  );
}

export function updateTaskNodeStatus(
  taskId: string,
  nodeId: string,
  status: string,
): Promise<AgentTaskNode> {
  return firstNodeId(taskId, nodeId).then((id) =>
    prisma.agentTaskNode.update({ where: { id }, data: { status } }),
  );
}

/**
 * Exactly-once claim of the NODE executor slot addressed by the logical `(taskId, nodeId)` pair —
 * the node-level analogue of `claimTaskExecution`.
 *
 * A SINGLE atomic `updateMany` stamps `executionToken = token` / `executionClaimedAt = now` ONLY
 * WHERE the node is unclaimed (`executionToken IS NULL`) or, when `opts.staleBefore` is supplied,
 * its `executionClaimedAt` is older than that instant (a stale-claim takeover). Returns `true` iff
 * exactly one row was updated (this caller won).
 *
 * NOTE: `(taskId, nodeId)` is NOT a DB-unique pair, so this `updateMany` targets ALL rows matching
 * the pair (normally exactly one). If a pair were ever duplicated more than one row would be
 * claimed and the `count === 1` check would report the claim as lost. The same fail-safe note as
 * `claimTaskExecution` applies: a set token with a NULL `executionClaimedAt` is not reclaimable via
 * the stale path.
 */
export async function claimNodeExecution(
  taskId: string,
  nodeId: string,
  token: string,
  opts?: { staleBefore?: Date },
): Promise<boolean> {
  const staleBefore = opts?.staleBefore;
  const result = await prisma.agentTaskNode.updateMany({
    where: {
      taskId,
      nodeId,
      OR: [
        { executionToken: null },
        ...(staleBefore ? [{ executionClaimedAt: { lt: staleBefore } }] : []),
      ],
    },
    data: { executionToken: token, executionClaimedAt: new Date() },
  });
  return result.count === 1;
}

/**
 * Release the NODE executor claim for the `(taskId, nodeId)` pair, clearing the token ONLY where it
 * is still this caller's `token`. A non-owner's token does not match, so nothing is released. The
 * affected-row count is irrelevant, so this returns `void`.
 */
export async function releaseNodeExecution(
  taskId: string,
  nodeId: string,
  token: string,
): Promise<void> {
  await prisma.agentTaskNode.updateMany({
    where: { taskId, nodeId, executionToken: token },
    data: { executionToken: null, executionClaimedAt: null },
  });
}

export function deleteTask(id: string): Promise<void> {
  return prisma.agentTask.delete({ where: { id } }).then(() => undefined);
}

/**
 * Resolves the row id of the FIRST node matching the logical `(taskId, nodeId)` pair.
 * `(taskId, nodeId)` is not a DB unique constraint, so node-addressed writes go through
 * this lookup to update exactly one row. Throws when the node does not exist.
 */
async function firstNodeId(taskId: string, nodeId: string): Promise<string> {
  const node = await prisma.agentTaskNode.findFirst({
    where: { taskId, nodeId },
    orderBy: { order: 'asc' },
    select: { id: true },
  });
  if (!node) {
    throw new Error(`AgentTaskNode not found (taskId="${taskId}", nodeId="${nodeId}")`);
  }
  return node.id;
}

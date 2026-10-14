import { Prisma, type AgentTask, type AgentTaskNode } from '@/lib/db/prisma';
import { prisma, type DbClient } from '../client';
import { toJson } from '../../json';
import { AppError } from '../../errors';
import type { TaskCondition, TaskPlanStatus } from '../../contracts/task';
import { ensureStandaloneWorkflowRun, synchronizeStandaloneWorkflowRun } from './workflowRun';

export type AgentTaskWithNodes = AgentTask & { nodes: AgentTaskNode[] };

export interface CreateTaskInput {
  sessionId: string;
  userId: string;
  goal: string;
  status?: string;
  runId?: string;
  parentInvocationId?: string;
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
  after?: string[];
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
      runId: input.runId,
      parentInvocationId: input.parentInvocationId,
    },
  });
}

/** Save a complete workflow definition before making it executable. */
export async function createTaskGraph(
  input: CreateTaskInput,
  nodes: readonly Omit<CreateTaskNodeInput, 'taskId' | 'order'>[],
  client: DbClient = prisma,
): Promise<AgentTaskWithNodes> {
  const persist = async (transaction: DbClient): Promise<AgentTaskWithNodes> => {
    const task = await transaction.agentTask.create({
      data: {
        sessionId: input.sessionId,
        userId: input.userId,
        goal: input.goal,
        status: input.status ?? 'pending',
        runId: input.runId,
        parentInvocationId: input.parentInvocationId,
        nodes: {
          create: nodes.map((node, order) => ({
            nodeId: node.nodeId,
            name: node.name,
            kind: node.kind,
            order,
            tool: node.tool ?? null,
            args: node.args == null ? null : toJson(node.args),
            condition: node.condition == null ? null : toJson(node.condition),
            dependencies: node.dependencies == null ? null : toJson(node.dependencies),
            after: node.after == null ? null : toJson(node.after),
            status: node.status ?? 'pending',
          })),
        },
      },
      include: { nodes: { orderBy: { order: 'asc' } } },
    });
    if (task.runId !== null) return task;
    const runId = await ensureStandaloneWorkflowRun(task, transaction);
    return { ...task, runId };
  };
  return '$transaction' in client ? client.$transaction(persist) : persist(client);
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
 *
 * Token fence (`opts.fenceToken`): when supplied, this SAME atomic CAS also requires the row's
 * `executionToken` to equal `opts.fenceToken`. This lets a running plan executor prove it still
 * OWNS the plan at the instant of the write, so a stale "zombie" executor whose claim was taken
 * over (its token overwritten by a newer executor) transitions 0 rows and returns `false` — it can
 * never move the status of a plan it no longer owns. The check lives INSIDE the single `updateMany`
 * statement (atomic, never a read-then-write). Omit `opts` (or `opts.fenceToken`) for the unfenced
 * behavior above. The return type is unchanged — `false` is the existing "claim lost" sentinel.
 */
export async function claimTaskStatus(
  taskId: string,
  fromStatuses: TaskPlanStatus[],
  toStatus: TaskPlanStatus,
  opts?: { fenceToken?: string },
): Promise<boolean> {
  const fenceToken = opts?.fenceToken;
  const result = await prisma.agentTask.updateMany({
    where: {
      id: taskId,
      status: { in: fromStatuses },
      ...(toStatus === 'running' ? { manualReviews: { none: { status: 'open' } } } : {}),
      ...(fenceToken === undefined ? {} : { executionToken: fenceToken }),
    },
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
 *
 * EXECUTION GENERATION: the SAME atomic statement also INCREMENTS `AgentTask.generation`, so every
 * (re)claim — the initial claim and every stale-owner takeover — advances a monotonic version
 * attributable to exactly one executor. A plan snapshot / `plan_update` stamped with this generation
 * lets a consumer reject a stale (lower-generation) event published by a superseded executor. Use
 * `claimTaskExecutionWithGeneration` to also read the generation this claim established.
 */
export async function claimTaskExecution(
  taskId: string,
  token: string,
  opts?: { staleBefore?: Date },
): Promise<boolean> {
  return (await claimTaskExecutionWithGeneration(taskId, token, opts)).won;
}

/**
 * `claimTaskExecution` that ALSO reports the task's `generation` after a WON claim (the version in
 * effect for this claim), so a caller can stamp its plan snapshots / `plan_update` events.
 * Returns `{ won: false, generation: null }` when the claim was lost (nothing was written).
 */
export async function claimTaskExecutionWithGeneration(
  taskId: string,
  token: string,
  opts?: { staleBefore?: Date },
): Promise<{ won: boolean; generation: number | null }> {
  const staleBefore = opts?.staleBefore;
  const result = await prisma.agentTask.updateMany({
    where: {
      id: taskId,
      manualReviews: { none: { status: 'open' } },
      OR: [
        { executionToken: null },
        ...(staleBefore ? [{ executionClaimedAt: { lt: staleBefore } }] : []),
      ],
    },
    data: { executionToken: token, executionClaimedAt: new Date(), generation: { increment: 1 } },
  });
  if (result.count !== 1) return { won: false, generation: null };
  const row = await prisma.agentTask.findUnique({
    where: { id: taskId },
    select: { generation: true },
  });
  return { won: true, generation: row?.generation ?? null };
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
  await prisma.$transaction(async transaction => {
    await transaction.agentTask.updateMany({
      where: { id: taskId, executionToken: token },
      data: { executionToken: null, executionClaimedAt: null },
    });
    await synchronizeStandaloneWorkflowRun(taskId, transaction);
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
      after: input.after == null ? null : toJson(input.after),
      status: input.status ?? 'pending',
    },
  });
}

export function getTaskNode(
  taskId: string,
  nodeId: string,
): Promise<AgentTaskNode | null> {
  return prisma.agentTaskNode.findUnique({
    where: { taskId_nodeId: { taskId, nodeId } },
  });
}

/**
 * Persist a node's result.
 *
 * Two modes, selected by whether `opts.fenceToken` is supplied:
 *
 * - **Control write (`opts` omitted or `fenceToken` undefined)** — address the
 *   unique `(taskId, nodeId)` pair and `update` it, returning the updated
 *   `AgentTaskNode`. THROWS when the node does not exist.
 *
 * - **Fenced (`opts.fenceToken` supplied)** — a SINGLE atomic conditional statement (`updateMany`
 *   with `executionToken: opts.fenceToken` in the `where`) writes the row ONLY while its
 *   `executionToken` still equals the caller's token. The token check lives INSIDE the same
 *   statement (never a read-then-write), so a stale "zombie" executor whose claim was taken over
 *   can NEVER overwrite the takeover's result.
 *   - Claim still owned → the row is written, then re-read via the `(taskId, nodeId)` unique
 *     lookup, and returned as `AgentTaskNode | null`.
 *   - Claim LOST (0 rows matched) → NO write happens and the **"lost" sentinel `null`** is
 *     returned. This is deliberately different from the unfenced path's throw-when-absent: a
 *     `null` means "the write was rejected because you no longer own the node", NOT "the node is
 *     missing". Callers that pass a fence token MUST branch on `null` (skip narrating/persisting)
 *     rather than treat it as an error.
 */
export function updateTaskNode(
  taskId: string,
  nodeId: string,
  update: UpdateTaskNodeInput,
): Promise<AgentTaskNode>;
export function updateTaskNode(
  taskId: string,
  nodeId: string,
  update: UpdateTaskNodeInput,
  opts: { fenceToken?: string },
): Promise<AgentTaskNode | null>;
export function updateTaskNode(
  taskId: string,
  nodeId: string,
  update: UpdateTaskNodeInput,
  opts?: { fenceToken?: string },
): Promise<AgentTaskNode | null> {
  const data: Prisma.AgentTaskNodeUpdateInput = {};
  if (update.status !== undefined) data.status = update.status;
  if (update.output !== undefined) {
    data.output = update.output === null ? null : toJson(update.output);
  }
  if (update.error !== undefined) data.error = update.error;
  if (update.startedAt !== undefined) data.startedAt = update.startedAt;
  if (update.endedAt !== undefined) data.endedAt = update.endedAt;

  const fenceToken = opts?.fenceToken;
  if (fenceToken === undefined) {
    return prisma.agentTaskNode.update({ where: { taskId_nodeId: { taskId, nodeId } }, data })
      .catch(error => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          throw new AppError('NOT_FOUND', 'The task node does not exist.', { resource: 'AgentTaskNode', taskId, nodeId });
        }
        throw error;
      });
  }

  return (async () => {
    const result = await prisma.agentTaskNode.updateMany({
      where: { taskId, nodeId, executionToken: fenceToken },
      data,
    });
    if (result.count === 0) return null;
    return prisma.agentTaskNode.findUnique({
      where: { taskId_nodeId: { taskId, nodeId } },
    });
  })();
}

export function updateTaskNodeStatus(
  taskId: string,
  nodeId: string,
  status: string,
): Promise<AgentTaskNode> {
  return prisma.agentTaskNode.update({ where: { taskId_nodeId: { taskId, nodeId } }, data: { status } });
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
 * The database enforces a unique `(taskId, nodeId)` pair. A set token with a NULL
 * `executionClaimedAt` remains unclaimable through the stale path, just as for a plan claim.
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

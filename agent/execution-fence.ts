/**
 * execution-fence.ts — the AGENT-side construction of the Banking SDK's WRITE fence.
 *
 * WHY this module exists
 * ----------------------
 * A Banking SDK write (`reserve_budget`, `transfer_money`, …) can be BLOCKED for an arbitrary time
 * inside a tool call (a slow DB, a fault-injection barrier in a review spec). Between the instant an
 * executor acquired the right to run a plan node and the instant that node's side effect COMMITS, a
 * concurrent control can TAKE OVER the plan (`resume`/`retry` rotating `AgentTask.executionToken` +
 * bumping `generation`) or CANCEL it. When that happens, the blocked write's authorization is GONE
 * and it must NOT commit.
 *
 * The Banking SDK executes banking writes and knows nothing about plans/claims/tokens, so the agent
 * layer hands the guarantee to the write boundary as an OPAQUE check carried on the INPUT OBJECT
 * itself (`banking-sdk/fence.ts#attachExecutionFence` — a non-enumerable Symbol property, so it can
 * never be injected through JSON/tool args). The SDK `await`s that check INSIDE its write transaction,
 * immediately BEFORE the business write, so a check that THROWS rolls the transaction back and NO
 * business row is persisted (see `banking-sdk/budget.ts`, `banking-sdk/idempotent.ts`,
 * `banking-sdk/transfer.ts`).
 *
 * TWO AUTHORITIES
 * ---------------
 *  - `buildPlanNodeFence` — the INLINE (GREEN) plan-node path. The authority is the plan/node EXECUTION
 *    CLAIM this run holds, captured when the tool starts and re-asserted at the write boundary: a
 *    rotated plan token / bumped generation / cancelled plan / non-executing plan-or-node status / a
 *    replaced node claim all mean the write is no longer authorized ⇒ `CONFLICT`, transaction rolled
 *    back.
 *  - `buildConfirmFence` — the confirm/verify continuation. Its authority is the ACTION's own
 *    effective decision (the gateway already claimed the action exactly-once and its execution lease /
 *    live marker governs the window), NOT the plan's `executionToken` — which a `resumeTaskForAction`
 *    legitimately mints, rotates and releases around the continuation. It therefore asserts only the
 *    one thing that MUST hold: the owning plan was not CANCELLED.
 *
 * Everything here is a READ-ONLY assertion: the fence never writes, never re-invokes a tool and never
 * swallows an error — a fence that cannot prove the write is still authorized THROWS.
 */
import type { Prisma } from '@prisma/client';
import type { ExecutionFenceCheck } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { getTask, getTaskNode } from '@/lib/db/repositories/task';

/**
 * Plan statuses during which a node's SDK write may legitimately commit. The planner writes the plan
 * `'running'` ONCE up-front (`persistPlanSnapshotGuarded`) and only touches NODE rows afterwards, so
 * `'running'` is what holds while a node's tool runs; `'waiting_confirmation'` is tolerated because a
 * run that parked one node may still be settling it. A `'cancelled'`/`'success'`/`'paused'`-driven
 * write is refused.
 */
const WRITABLE_PLAN_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting_confirmation']);

/**
 * Node statuses during which that node's SDK write may legitimately commit. The executor sets the node
 * `'running'` (`setNode`) immediately BEFORE launching its tool, so `'running'` is the only live state;
 * a node already settled (`success`/`failed`/`skipped`/`cancelled`) means this write belongs to a
 * superseded pass.
 */
const WRITABLE_NODE_STATUSES: ReadonlySet<string> = new Set(['running']);

/** The persisted execution identity a fence captures at tool-start and re-asserts at the write boundary. */
interface CapturedPlanIdentity {
  planToken: string | null;
  generation: number;
  planStatus: string;
  nodeToken: string | null;
  nodeStatus: string;
}

/** The `CONFLICT` a fence raises when the write's authorization is no longer provable. */
function fenceConflict(reason: string, details: Record<string, unknown>): AppError {
  return new AppError('CONFLICT', `执行权已失效，写入被拒绝：${reason}`, details);
}

/**
 * Whether an optional id identifies a real row. The Prisma columns behind a plan link are NULLABLE,
 * so a STANDALONE action yields `null` (never `undefined`); mirror `lib/ledger.ts#ledgerKeyForAction`'s
 * "non-null and non-empty after trimming" rule so a fence is built EXACTLY when the action is
 * plan-linked — never on a standalone action (which would query `getTask(null)`).
 */
function isUsableId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.trim().length > 0;
}

/**
 * THE CHECK: re-read the plan + node **on the caller's transaction client** (so the assertion joins the
 * very transaction that is about to write) and throw when the captured execution right no longer holds.
 */
async function assertPlanNodeUnchanged(
  client: Prisma.TransactionClient,
  taskId: string,
  nodeId: string,
  captured: CapturedPlanIdentity,
): Promise<void> {
  const plan = await client.agentTask.findUnique({ where: { id: taskId } });
  if (plan === null) throw fenceConflict('计划不存在', { taskId, nodeId });
  if (plan.executionToken !== captured.planToken) {
    throw fenceConflict('计划执行权已被接管', { taskId, nodeId, captured: captured.planToken });
  }
  if (plan.generation !== captured.generation) {
    throw fenceConflict('计划执行代际已变更', { taskId, nodeId, captured: captured.generation });
  }
  if (plan.status === 'cancelled') throw fenceConflict('计划已取消', { taskId, nodeId });
  if (!WRITABLE_PLAN_STATUSES.has(plan.status)) {
    throw fenceConflict(`计划状态不允许写入：${plan.status}`, { taskId, nodeId, planStatus: plan.status });
  }

  const node = await client.agentTaskNode.findFirst({
    where: { taskId, nodeId },
    orderBy: { order: 'asc' },
  });
  if (node === null) throw fenceConflict(`计划节点不存在：${nodeId}`, { taskId, nodeId });
  // A captured NULL node token means this pass holds no distinguishable node claim, so there is
  // nothing to compare — the plan token / status assertions above remain the authority. A NON-null
  // captured token that has been replaced (released then re-claimed by a takeover) is a rotation.
  if (captured.nodeToken !== null && node.executionToken !== captured.nodeToken) {
    throw fenceConflict('节点执行权已被接管', { taskId, nodeId, captured: captured.nodeToken });
  }
  if (!WRITABLE_NODE_STATUSES.has(node.status)) {
    throw fenceConflict(`节点状态不允许写入：${node.status}`, { taskId, nodeId, nodeStatus: node.status });
  }
}

/**
 * Build the fence for an INLINE plan-node (GREEN) tool execution.
 *
 * Captures the PERSISTED plan (`executionToken` / `generation` / `status`) and node (`executionToken`
 * / `status`) at execution START, then returns a check that re-reads them at the write boundary and
 * throws `CONFLICT` when ANY of: the plan token was rotated (a takeover), the plan generation changed,
 * the plan was cancelled, the plan/node is no longer in an executing state, or the node claim was
 * replaced. A write that would have been launched by a superseded executor therefore rolls back with
 * NO side effect.
 *
 * Returns `undefined` when either id is absent (a standalone call has no plan claim to fence on), or
 * when the plan/node row cannot be read at START (nothing to capture — existing behavior preserved).
 */
export async function buildPlanNodeFence(
  taskId: string | null | undefined,
  nodeId: string | null | undefined,
): Promise<ExecutionFenceCheck | undefined> {
  if (!isUsableId(taskId) || !isUsableId(nodeId)) return undefined;
  const plan = await getTask(taskId);
  if (plan === null) return undefined;
  const node = await getTaskNode(taskId, nodeId);
  if (node === null) return undefined;

  const captured: CapturedPlanIdentity = {
    planToken: plan.executionToken,
    generation: plan.generation,
    planStatus: plan.status,
    nodeToken: node.executionToken,
    nodeStatus: node.status,
  };
  return (client: Prisma.TransactionClient) => assertPlanNodeUnchanged(client, taskId, nodeId, captured);
}

/**
 * Build the fence for a CONFIRM/VERIFY continuation.
 *
 * The continuation's authority is the ACTION's own exactly-once gateway claim plus its execution
 * lease / live marker (`confirmation-recovery.ts`) — NOT the plan's `executionToken`, which
 * `resumeTaskForAction` legitimately mints/rotates/releases around the continuation and which may
 * therefore differ from any token captured earlier. The ONE fact that must hold is that the owning
 * plan was not CANCELLED while the blocked write was in flight; a cancelled plan's write must not
 * commit.
 *
 * Returns `undefined` when the action has NO usable plan link (a standalone action has no plan to
 * fence on) or when the owning plan row is unreadable.
 */
export async function buildConfirmFence(
  taskId: string | null | undefined,
  nodeId: string | null | undefined,
): Promise<ExecutionFenceCheck | undefined> {
  if (!isUsableId(taskId)) return undefined;
  const plan = await getTask(taskId);
  if (plan === null) return undefined;
  return async (client: Prisma.TransactionClient): Promise<void> => {
    const current = await client.agentTask.findUnique({ where: { id: taskId } });
    if (current === null) throw fenceConflict('计划不存在', { taskId, nodeId });
    if (current.status === 'cancelled') throw fenceConflict('计划已取消', { taskId, nodeId });
  };
}

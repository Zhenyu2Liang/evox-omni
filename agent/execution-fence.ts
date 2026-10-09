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
 * layer hands the guarantee to the write boundary through a trusted invocation context
 * (`banking-sdk/execution-context.ts`; legacy Symbol input fences remain supported). Neither
 * mechanism can be injected through JSON/tool args. The SDK awaits the check INSIDE its write transaction,
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
 *    legitimately mints, rotates and releases around the continuation. It asserts that the action
 *    is still confirmed, that its owning plan was not cancelled, and that its persisted session
 *    remains unlocked at the SDK mutation boundary (ordinary confirm, MFA verify and recovery).
 *
 * The fence uses conditional identity-preserving writes to obtain SQLite's writer slot before
 * banking mutations. It never re-invokes a tool or swallows an authorization failure.
 */
import type { Prisma } from '@prisma/client';
import type { ExecutionFenceCheck } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { getTask, getTaskNode } from '@/lib/db/repositories/task';
import { writePolicy } from '@/security';

/** SDK runners return business errors as values; a policy denial must still reach the API as 423. */
export function guardExecutionFence(fence: ExecutionFenceCheck | undefined): {
  fence: ExecutionFenceCheck;
  assertPolicyAllowed: () => void;
} {
  let policyError: AppError | undefined;
  return {
    fence: async client => {
      try { await fence?.(client); }
      catch (error) {
        if (error instanceof AppError && error.code === 'CIRCUIT_OPEN') policyError = error;
        throw error;
      }
    },
    assertPolicyAllowed: () => { if (policyError !== undefined) throw policyError; },
  };
}

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
 * "non-null and non-empty after trimming" rule so standalone actions never query a null plan id.
 */
function isUsableId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.trim().length > 0;
}

/**
 * Atomically verify plan/node identity on the business transaction's client before any mutation.
 */
async function assertPlanNodeUnchanged(
  client: Prisma.TransactionClient,
  taskId: string,
  nodeId: string,
  captured: CapturedPlanIdentity,
): Promise<void> {
  // Conditional FIRST WRITE obtains SQLite's writer slot. A concurrent cancel/takeover either
  // commits first (this CAS fails) or waits until this business transaction commits.
  const plan = await client.agentTask.updateMany({
    where: { id: taskId, executionToken: captured.planToken, generation: captured.generation,
      status: { in: [...WRITABLE_PLAN_STATUSES] } },
    data: { generation: { increment: 0 } },
  });
  if (plan.count !== 1) throw fenceConflict('计划执行权已被接管、取消或暂停', { taskId, nodeId });
  const node = await client.agentTaskNode.updateMany({
    where: { taskId, nodeId, executionToken: captured.nodeToken, status: { in: [...WRITABLE_NODE_STATUSES] } },
    data: { executionToken: captured.nodeToken },
  });
  if (node.count !== 1) throw fenceConflict('节点执行权已失效', { taskId, nodeId });
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
 * Automatic tools need the same write-time breaker check as human-confirmed actions.
 * The session is injected by the server, never obtained from tool arguments. Compose it with
 * plan ownership when present; standalone calls still receive a fence. A committed-result read
 * does not enter a mutation transaction and remains available without creating a new side effect.
 */
export async function buildAutomaticWriteFence(
  sessionId: string,
  taskId?: string,
  nodeId?: string,
): Promise<ExecutionFenceCheck> {
  const planFence = await buildPlanNodeFence(taskId, nodeId);
  return async client => {
    await planFence?.(client);
    // Standalone calls have no plan CAS: obtain the SQLite writer slot before checking the
    // session policy, just as confirmed writes do. This is an identity-preserving write.
    await client.agentSession.updateMany({ where: { id: sessionId }, data: { id: sessionId } });
    await writePolicy.assertSessionMayWrite(sessionId);
  };
}

/**
 * Build the fence for a CONFIRM/VERIFY continuation.
 *
 * The continuation's authority is the ACTION's own exactly-once gateway claim plus its execution
 * lease / live marker (`confirmation-recovery.ts`) — NOT the plan's `executionToken`, which
 * `resumeTaskForAction` legitimately mints/rotates/releases around the continuation and which may
 * therefore differ from any token captured earlier. The action must remain confirmed and the owning
 * plan must not be cancelled while the blocked write is in flight. These conditional writes take
 * the database writer slot before the business mutation; the current breaker is then rechecked.
 *
 * Standalone actions are fenced by action id. Returns undefined only when neither an action id
 * nor a usable plan id is supplied; missing rows fail closed inside the transaction.
 */
export async function buildConfirmFence(
  taskId: string | null | undefined,
  nodeId: string | null | undefined,
  actionId?: string,
): Promise<ExecutionFenceCheck | undefined> {
  if (!isUsableId(taskId) && actionId === undefined) return undefined;
  return async (client: Prisma.TransactionClient): Promise<void> => {
    let sessionId: string | undefined;
    if (actionId !== undefined) {
      const action = await client.pendingAction.updateMany({
        where: { id: actionId, status: 'confirmed' }, data: { status: 'confirmed' },
      });
      if (action.count !== 1) throw fenceConflict('操作已不再处于授权执行状态', { actionId });
      sessionId = (await client.pendingAction.findUniqueOrThrow({ where: { id: actionId } })).sessionId;
    }
    if (isUsableId(taskId)) {
      const plan = await client.agentTask.updateMany({
        where: { id: taskId, status: { not: 'cancelled' } }, data: { generation: { increment: 0 } },
      });
      if (plan.count !== 1) throw fenceConflict('计划已取消或不存在', { taskId, nodeId });
      sessionId ??= (await client.agentTask.findUniqueOrThrow({ where: { id: taskId } })).sessionId;
    }
    // Shared by ordinary confirm, MFA verify and recovery; the SDK invokes this in its write tx.
    // Receipt-only reads bypass the SDK mutation transaction and remain available while locked.
    if (sessionId !== undefined) await writePolicy.assertSessionMayWrite(sessionId);
  };
}

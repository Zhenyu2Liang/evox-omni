/**
 * tests/app/plan-linkage-http.test.ts — REAL-application-entry (HTTP) integration for the
 * `PendingAction` ↔ owning PLAN/NODE **LINK** (the "计划关联" invariant).
 *
 * The planner parks a gated DAG node by minting a `PendingAction`; that row must carry the
 * `taskId`/`nodeId` of the node that parked it, persisted AT CREATION
 * (`security/security-gateway.ts#gatewayCreatePendingAction`) — so a plan-level cancel can revoke it,
 * a human decision can resume the RIGHT node, and a re-drive of the SAME node REUSES its existing
 * action instead of minting a duplicate. The other app-entry specs cover the confirmation/verification
 * flows; none of them asserts the persisted PLAN LINK, which is what this spec pins down.
 *
 * It drives the REAL production stack in-process (`@/agent` `getOrCreateSession` + `runSubmitPlan` +
 * `executeGatedTool`, plus the REAL `POST /api/tasks/[id]` route handler for the re-drive) against the
 * real SQLite test DB. ONLY the model is scripted (`tests/setup.ts` forces `LLM_MODE=mock`); this spec
 * never touches the model directly. Offline, no network, no fake timers. Each test uses a UNIQUE
 * persisted session id (the in-process circuit breaker is keyed by `sessionId`) on a freshly seeded DB.
 *
 * CASE (c) is the anti-MERGE invariant: two INDEPENDENT plans in ONE session that call the SAME tool
 * with the SAME args must produce their OWN side effects — never one shared row — because the gateway
 * scopes both the auto-execution single-flight key and the parked-action reuse to the NODE identity
 * (`nodeExecutionKey(taskId, nodeId)`), never to `sessionId` + tool + args.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { executeGatedTool, getOrCreateSession, readPendingActionId } from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import type { TaskNodeResult, TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import {
  getPendingActionPlanLink,
  listPendingActionsByTask,
} from '@/lib/db/repositories/pendingAction';
import { safeParse } from '@/lib/json';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { idCtx, postJson, taskUrl, type HttpResult } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** Primary 活期账户 (¥23,580) — the default funding account every transfer debits. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance (¥23,580) — a parked transfer must never move it. */
const SEEDED_BALANCE = CHECKING.balance;
/** The recipient resolved by name from the seeded contacts. */
const RECIPIENT_NAME = '张伟';
/** The single node id used by every seeded plan in this spec. */
const NODE_ID = 'n1';

/**
 * The route's JSON envelope — the transport shape (NOT a frozen `@/lib/contracts` type), declared
 * structurally only so this spec can narrow `ok`/`data`/`error` without importing app-private modules.
 */
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Success protocol helper: assert the envelope and return its payload. */
function payload<T>(res: HttpResult<Envelope<T>>): T {
  expect(res.data?.ok, `expected success envelope, got ${JSON.stringify(res.data)}`).toBe(true);
  return res.data!.data as T;
}

/** The recorded `TaskNodeResult` for a node id (throws when absent — a missing node is a bug). */
function resultOf(plan: TaskPlan, nodeId: string): TaskNodeResult {
  const result = plan.results.find((candidate) => candidate.id === nodeId);
  expect(result, `plan ${plan.id} has no node '${nodeId}'`).toBeDefined();
  return result!;
}

/** The recorded node status in a plan snapshot (`undefined` when the node is absent). */
function nodeStatusOf(plan: TaskPlan, nodeId: string): TaskNodeStatus | undefined {
  return plan.results.find((result) => result.id === nodeId)?.status;
}

/* ----------------------------------------------------------------------------- plan seeding */

/** A plan node as supplied to `runSubmitPlan` (the model-free DAG runner). */
interface SeedNode {
  id: string;
  name: string;
  dependencies: string[];
  kind: 'tool' | 'condition' | 'note';
  tool?: string;
  args?: Record<string, unknown>;
}

/** The 🟢 GREEN node used as the COUNTABLE execution probe (exactly one `Budget` row per run). */
function budgetNode(id: string, budgetName: string, amount: number, deps: string[] = []): SeedNode {
  return { id, name: '预留预算', dependencies: deps, kind: 'tool', tool: 'reserve_budget', args: { name: budgetName, amount } };
}

/** The YELLOW `transfer_money` node (gated → PARKS for a human decision instead of executing). */
function transferNode(id: string, amount: number, deps: string[] = []): SeedNode {
  return { id, name: `给${RECIPIENT_NAME}转账`, dependencies: deps, kind: 'tool', tool: 'transfer_money', args: { name: RECIPIENT_NAME, amount } };
}

/** Create + persist a fresh `AgentSession` for the demo user and return its (unique) id. */
async function newPersistedSessionId(): Promise<string> {
  return (await getOrCreateSession(DEMO_USER_ID)).sessionId;
}

/**
 * The gateway-authorized per-node runner. It MUST forward the node identity (`ctx.taskId`/`ctx.nodeId`)
 * — that is what scopes the parked action to its node (the LINK) and dedupes a same-node re-drive.
 */
function gatewayRunTool(sessionId: string, userRequest = ''): PlanRunTool {
  return (toolName, args, ctx) =>
    executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName,
      args,
      userRequest,
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });
}

/** The model-free `submit_plan` outcome (its persisted plan snapshot lives under `data`). */
type PlanResult = Awaited<ReturnType<typeof runSubmitPlan>>;

/** Assert the runner succeeded and return its persisted plan snapshot. */
function planOf(result: PlanResult): TaskPlan {
  expect(result.ok, `runSubmitPlan produced no plan: ${result.error}`).toBe(true);
  return result.data as TaskPlan;
}

/**
 * Seed a durable plan through the PRODUCTION `submit_plan` runner: real `AgentTask`/`AgentTaskNode`
 * rows + a real `PendingAction` for a gated node. Returns the persisted plan and its owning session.
 */
async function seedPlan(
  sessionId: string,
  goal: string,
  nodes: SeedNode[],
): Promise<{ taskId: string; plan: TaskPlan }> {
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    { goal, nodes },
    { sessionId, runTool: gatewayRunTool(sessionId, goal) },
  );
  const plan = planOf(result);
  return { taskId: plan.id, plan };
}

/* ------------------------------------------------------------------------------------ probes */

/** The persisted `PendingAction` row (throws when absent — a missing action is a bug). */
function actionRow(actionId: string) {
  return getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
}

/** The durable `AgentTaskNode` row for a plan node (throws when absent). */
function nodeRow(taskId: string, nodeId: string) {
  return getTestPrisma().agentTaskNode.findFirstOrThrow({ where: { taskId, nodeId } });
}

/** The `pendingActionId` a durable node row records under its `output` JSON. */
function nodeOutputActionId(output: string | null): string | undefined {
  return readPendingActionId(safeParse<unknown>(output ?? undefined, undefined));
}

/** The seeded 活期 account's CURRENT balance (a parked transfer must leave it untouched). */
async function checkingBalance(): Promise<number> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return account.balance;
}

/** Count the `Budget` rows with the given name (2 ⇒ two independent executions). */
function countBudgets(name: string): Promise<number> {
  return getTestPrisma().budget.count({ where: { userId: DEMO_USER_ID, name } });
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] the parked PendingAction carries its owning plan/node LINK (persisted at creation)', () => {
  it('[integration] a gated DAG node parks with taskId === plan.id and nodeId === the parked node, readable via getPendingActionPlanLink', async () => {
    const sessionId = await newPersistedSessionId();
    const { taskId, plan } = await seedPlan(sessionId, `给${RECIPIENT_NAME}转200元`, [
      transferNode(NODE_ID, 200),
    ]);

    // Preconditions: ONE node, gated (YELLOW transfer) → PARKED, nothing executed yet.
    expect(plan.id).toBe(taskId);
    expect(plan.status).toBe('waiting_confirmation');
    expect(nodeStatusOf(plan, NODE_ID)).toBe('waiting_confirmation');
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);

    const actionId = readPendingActionId(resultOf(plan, NODE_ID).output);
    expect(typeof actionId).toBe('string');

    // --- THE LINK, persisted AT CREATION on the raw row.
    const row = await actionRow(actionId!);
    expect(row.toolName).toBe('transfer_money');
    expect(row.status).toBe('pending');
    expect(row.riskLevel).toBe('YELLOW');
    expect(row.requiresMfa).toBe(false);
    expect(row.sessionId).toBe(sessionId);
    expect(row.userId).toBe(DEMO_USER_ID);
    expect(row.taskId).toBe(taskId);
    expect(row.nodeId).toBe(NODE_ID);

    // --- The SAME link through the sanctioned repository reader.
    expect(await getPendingActionPlanLink(actionId!)).toEqual({
      id: actionId,
      taskId,
      nodeId: NODE_ID,
    });

    // --- The durable node row agrees: it is parked on THAT action.
    const node = await nodeRow(taskId, NODE_ID);
    expect(node.status).toBe('waiting_confirmation');
    expect(nodeOutputActionId(node.output)).toBe(actionId);

    // Exactly ONE action belongs to the plan (no duplicate minted by the park).
    expect((await listPendingActionsByTask(taskId)).map((candidate) => candidate.id)).toEqual([
      actionId,
    ]);
  });

  it('[integration] re-driving the SAME parked node through POST /api/tasks/[id] {action:"resume"} REUSES the action and leaves the link unchanged', async () => {
    const sessionId = await newPersistedSessionId();
    const { taskId, plan } = await seedPlan(sessionId, `给${RECIPIENT_NAME}转200元`, [
      transferNode(NODE_ID, 200),
    ]);
    const actionId = readPendingActionId(resultOf(plan, NODE_ID).output)!;

    const before = await actionRow(actionId);
    expect(before.taskId).toBe(taskId);
    expect(before.nodeId).toBe(NODE_ID);
    expect(before.status).toBe('pending');

    // The re-drive goes through the REAL control route (the production resume path), which forwards
    // the node identity to the gateway — so the gateway's node-scoped reuse
    // (`findReusableAction`) applies instead of minting a second action.
    const resumed = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'resume' },
      { ctx: idCtx(taskId), sessionId },
    );
    expect(resumed.status).toBe(200);
    const recovered = payload(resumed);
    expect(recovered.id).toBe(taskId);
    // Still parked on the SAME node — the human decision is still outstanding.
    expect(nodeStatusOf(recovered, NODE_ID)).toBe('waiting_confirmation');

    // --- REUSE, not a second row: exactly ONE action for the plan, the SAME id, still actionable.
    const planActions = await listPendingActionsByTask(taskId);
    expect(planActions.length).toBe(1);
    expect(planActions[0]!.id).toBe(actionId);
    expect(planActions[0]!.status).toBe('pending');

    // --- The persisted LINK is UNCHANGED (same action, same taskId, same nodeId).
    const after = await actionRow(actionId);
    expect(after.taskId).toBe(taskId);
    expect(after.nodeId).toBe(NODE_ID);
    expect(await getPendingActionPlanLink(actionId)).toEqual({
      id: actionId,
      taskId,
      nodeId: NODE_ID,
    });

    // No duplicate was minted anywhere in the session, and nothing moved.
    expect(
      await getTestPrisma().pendingAction.count({
        where: { sessionId, toolName: 'transfer_money', status: 'pending' },
      }),
    ).toBe(1);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect((await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
      'waiting_confirmation',
    );
  });
});

describe('[integration] two INDEPENDENT plans in ONE session with IDENTICAL tool+args never merge', () => {
  it('[integration] two GREEN reserve_budget nodes with the SAME name+amount produce exactly TWO Budget rows', async () => {
    const sessionId = await newPersistedSessionId();
    const marker = '计划隔离预算';

    const first = await seedPlan(sessionId, '预留预算（计划一）', [budgetNode(NODE_ID, marker, 500)]);
    const second = await seedPlan(sessionId, '预留预算（计划二）', [budgetNode(NODE_ID, marker, 500)]);

    // Two DISTINCT durable plans in the ONE session, both fully executed.
    expect(first.taskId).not.toBe(second.taskId);
    expect(first.plan.status).toBe('success');
    expect(second.plan.status).toBe('success');
    expect(nodeStatusOf(first.plan, NODE_ID)).toBe('success');
    expect(nodeStatusOf(second.plan, NODE_ID)).toBe('success');
    expect(
      await getTestPrisma().agentTask.count({ where: { sessionId } }),
    ).toBe(2);

    // THE POINT: identical tool+args in one session are DIFFERENT work → TWO side effects, never one.
    // (The single-flight key is the NODE identity, not sessionId+tool+args.)
    expect(await countBudgets(marker)).toBe(2);
    const rows = await getTestPrisma().budget.findMany({
      where: { userId: DEMO_USER_ID, name: marker },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((row) => row.amount)).toEqual([500, 500]);
    // Each reservation carries its OWN at-most-once key (`nxe:<taskId>:<nodeId>`) → distinct keys.
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(2);
  });

  it('[integration] two gated transfer nodes with the SAME tool+args park TWO actions, each linked to its OWN plan', async () => {
    const sessionId = await newPersistedSessionId();

    const first = await seedPlan(sessionId, `给${RECIPIENT_NAME}转200元（计划一）`, [
      transferNode(NODE_ID, 200),
    ]);
    const second = await seedPlan(sessionId, `给${RECIPIENT_NAME}转200元（计划二）`, [
      transferNode(NODE_ID, 200),
    ]);

    expect(first.taskId).not.toBe(second.taskId);
    expect(first.plan.status).toBe('waiting_confirmation');
    expect(second.plan.status).toBe('waiting_confirmation');

    const actionA = readPendingActionId(resultOf(first.plan, NODE_ID).output);
    const actionB = readPendingActionId(resultOf(second.plan, NODE_ID).output);
    expect(typeof actionA).toBe('string');
    expect(typeof actionB).toBe('string');
    // NEVER one shared row: two independent parks mint two distinct actions.
    expect(actionA).not.toBe(actionB);

    // Each plan enumerates EXACTLY its own action, linked to its own id.
    expect((await listPendingActionsByTask(first.taskId)).map((row) => row.id)).toEqual([actionA]);
    expect((await listPendingActionsByTask(second.taskId)).map((row) => row.id)).toEqual([actionB]);
    expect(await getPendingActionPlanLink(actionA!)).toEqual({
      id: actionA,
      taskId: first.taskId,
      nodeId: NODE_ID,
    });
    expect(await getPendingActionPlanLink(actionB!)).toEqual({
      id: actionB,
      taskId: second.taskId,
      nodeId: NODE_ID,
    });

    // The session holds BOTH pending actions, each pointing at a DIFFERENT plan (no cross-plan merge).
    const pending = await getTestPrisma().pendingAction.findMany({
      where: { sessionId, toolName: 'transfer_money', status: 'pending' },
      orderBy: { id: 'asc' },
    });
    expect(pending.length).toBe(2);
    expect(pending.every((row) => row.riskLevel === 'YELLOW' && row.requiresMfa === false)).toBe(true);
    expect(new Set(pending.map((row) => row.taskId))).toEqual(
      new Set([first.taskId, second.taskId]),
    );
    expect(new Set(pending.map((row) => row.nodeId))).toEqual(new Set([NODE_ID]));

    // Neither plan moved money (both are still waiting on a human decision).
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
  });
});

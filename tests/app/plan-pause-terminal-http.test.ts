/**
 * tests/app/plan-pause-terminal-http.test.ts — REAL-application-entry (HTTP) end-to-end specs for
 * two durable DAG invariants that the other `tests/app` suites leave open:
 *
 * 1. PAUSE + CONFIRM A PARKED NODE. A paused plan whose gated node is parked
 *    (`waiting_confirmation`) must NOT advance when that parked node is confirmed: the human
 *    decision settles the node (money moves) but the plan REMAINS `paused` — the SUBSEQUENT nodes
 *    are launched only by an EXPLICIT resume.
 * 2. TERMINAL-STATE PROTECTION. Once a plan is `cancelled` (and, where applicable, once it has
 *    `completed`), no `resume`/`retry`/`pause` may resurrect it: the route response AND the durable
 *    `AgentTask` row must agree on the terminal status, and no node may be re-executed.
 *
 * These specs drive the REAL Next.js route handlers — `POST /api/tasks/[id]` (pause/resume/cancel/
 * retry), `POST /api/actions/[id]/confirm` and `GET /api/tasks` — by importing their exported
 * `POST`/`GET` functions and calling them with REAL `NextRequest` objects (see `./harness.ts`).
 * Underneath the whole production stack runs (`route → @/agent → banking tools → security gateway
 * beforeToolCall → Banking SDK → SQLite`). Only the MODEL is scripted (`tests/setup.ts` forces
 * `LLM_MODE=mock`) — offline, no network.
 *
 * COUNTABLE NODE EXECUTION — the 🟢 GREEN `reserve_budget` node creates exactly ONE `Budget` row, so
 * "did the subsequent node run?" is an OBSERVABLE side effect (a wrongly-started node would create
 * the row, a correctly-blocked one leaves it absent), not just a status string.
 *
 * Plans are SEEDED through the PRODUCTION APIs (`getOrCreateSession` + `runSubmitPlan`) so real
 * `AgentTask`/`AgentTaskNode`/`PendingAction`/`AgentSession` rows exist and every control path's
 * ownership check (`loadOwnedTask`: task.sessionId + matching `AgentSession`) is satisfied.
 *
 * DB lifecycle matches the other DB-backed suites. Every plan gets a UNIQUE persisted session id
 * (the in-process circuit breaker is keyed by `sessionId`). No fake timers.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as tasksGet } from '@/app/api/tasks/route';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { executeGatedTool, getOrCreateSession, readPendingActionId } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, getJson, idCtx, postJson, taskUrl, tasksUrl, type HttpResult } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** Primary 活期账户 (¥23,580) — the default funding account every transfer debits. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance (¥23,580). */
const SEEDED_BALANCE = CHECKING.balance;
/** The recipient resolved by name from the seeded contacts. */
const RECIPIENT_NAME = '张伟';

/** A plan node as supplied to `runSubmitPlan` (the model-free DAG runner). */
interface SeedNode {
  id: string;
  name: string;
  dependencies: string[];
  kind: 'tool' | 'condition' | 'note';
  tool?: string;
  args?: Record<string, unknown>;
}

/** The 🟢 GREEN node used as the COUNTABLE execution probe (one `Budget` row per run). */
function budgetNode(id: string, name: string, budgetName: string, amount: number, deps: string[] = []): SeedNode {
  return { id, name, dependencies: deps, kind: 'tool', tool: 'reserve_budget', args: { name: budgetName, amount } };
}

/** The YELLOW `transfer_money` node (gated → PARKS for a human decision instead of executing). */
function transferNode(id: string, amount: number, deps: string[] = []): SeedNode {
  return { id, name: `给${RECIPIENT_NAME}转账`, dependencies: deps, kind: 'tool', tool: 'transfer_money', args: { name: RECIPIENT_NAME, amount } };
}

/**
 * The route's JSON envelope — the transport shape (NOT a frozen `@/lib/contracts` type). Declared
 * structurally only so specs can narrow `ok`/`data`/`error` without importing app-private modules.
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
function resultOf(plan: TaskPlan, nodeId: string) {
  const result = plan.results.find((candidate) => candidate.id === nodeId);
  expect(result, `plan ${plan.id} has no node '${nodeId}'`).toBeDefined();
  return result!;
}

/** The recorded node status in a plan snapshot (`undefined` when the node is absent). */
function nodeStatusOf(plan: TaskPlan, nodeId: string): TaskNodeStatus | undefined {
  return plan.results.find((result) => result.id === nodeId)?.status;
}

/** The DURABLE per-node statuses, in declaration order (the source of truth the route writes). */
async function nodeStatuses(taskId: string): Promise<string[]> {
  const nodes = await getTestPrisma().agentTaskNode.findMany({ where: { taskId }, orderBy: { order: 'asc' } });
  return nodes.map((node) => node.status);
}

/* ----------------------------------------------------------------------------- plan seeding */

/** Create + persist a fresh `AgentSession` for the demo user and return its id. */
async function newPersistedSessionId(): Promise<string> {
  return (await getOrCreateSession(DEMO_USER_ID)).sessionId;
}

/** The gateway-authorized per-node runner (a gated node parks instead of executing). */
function gatewayRunTool(sessionId: string, userRequest = '') {
  return (toolName: string, args: Record<string, unknown>) =>
    executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: toolName as Parameters<typeof executeGatedTool>[0]['toolName'],
      args,
      userRequest,
    });
}

/**
 * Seed a durable plan through the PRODUCTION `submit_plan` runner: real `AgentTask`/`AgentTaskNode`
 * rows + a real `PendingAction` for a gated node. Returns the persisted plan and its owning session.
 */
async function seedPlan(
  goal: string,
  nodes: SeedNode[],
): Promise<{ sessionId: string; taskId: string; plan: TaskPlan }> {
  const sessionId = await newPersistedSessionId();
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    { goal, nodes },
    { sessionId, runTool: gatewayRunTool(sessionId, goal) },
  );
  const plan = result.data as TaskPlan | undefined;
  expect(plan, `runSubmitPlan produced no plan: ${result.error}`).toBeDefined();
  return { sessionId, taskId: plan!.id, plan: plan! };
}

/** Count the `Budget` rows with the given name (0 ⇒ that node never executed). */
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

describe('[integration] POST /api/tasks/[id] pause → confirm a parked node → plan stays PAUSED', () => {
  it('confirming a parked node in a paused plan does NOT advance it; only an explicit resume runs the rest', async () => {
    // n1: 🟢 GREEN probe (ONE Budget row). n2: YELLOW transfer → PARKS. n3: GREEN probe (blocked).
    const { sessionId, taskId, plan } = await seedPlan('先预留预算A，再给张伟转200元，最后预留预算B', [
      budgetNode('n1', '预留预算A', '预留预算A', 1200),
      transferNode('n2', 200, ['n1']),
      budgetNode('n3', '预留预算B', '预留预算B', 800, ['n2']),
    ]);

    // Seed precondition: n1 executed, n2 parked, n3 never started.
    expect(plan.status).toBe('waiting_confirmation');
    expect(nodeStatusOf(plan, 'n1')).toBe('success');
    expect(nodeStatusOf(plan, 'n2')).toBe('waiting_confirmation');
    expect(nodeStatusOf(plan, 'n3')).toBe('pending');
    expect(await countBudgets('预留预算A')).toBe(1);
    expect(await countBudgets('预留预算B')).toBe(0);
    expect(await nodeStatuses(taskId)).toEqual(['success', 'waiting_confirmation', 'pending']);

    const parkedActionId = readPendingActionId(resultOf(plan, 'n2').output);
    expect(typeof parkedActionId).toBe('string');

    // --- PAUSE through the REAL route: the durable row and snapshot both say `paused`.
    const pausedRes = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'pause' },
      { ctx: idCtx(taskId), sessionId },
    );
    expect(pausedRes.status).toBe(200);
    const paused = payload(pausedRes);
    expect(paused.status).toBe('paused');
    expect(nodeStatusOf(paused, 'n1')).toBe('success');
    expect(nodeStatusOf(paused, 'n2')).toBe('waiting_confirmation');
    expect(nodeStatusOf(paused, 'n3')).toBe('pending');
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('paused');
    expect(await nodeStatuses(taskId)).toEqual(['success', 'waiting_confirmation', 'pending']);
    expect(await countBudgets('预留预算B')).toBe(0);

    // --- CONFIRM the parked YELLOW node through the REAL route: it executes for real (money moves)
    //     and the node settles `success`, but the PLAN must NOT advance — it stays PAUSED.
    const confirmRes = await postJson<Envelope<{ ok: boolean; status: string; tier: string }>>(
      confirmPost,
      actionUrl(parkedActionId!, 'confirm'),
      {},
      { ctx: idCtx(parkedActionId!), sessionId },
    );
    expect(confirmRes.status).toBe(200);
    const outcome = payload(confirmRes);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    // The real transfer moved exactly ¥200; n2 durably settled `success`.
    expect((await getTestPrisma().account.findUnique({ where: { id: CHECKING.id } }))!.balance).toBe(
      SEEDED_BALANCE - 200,
    );
    expect(await nodeStatuses(taskId)).toEqual(['success', 'success', 'pending']);

    // THE INVARIANT: the confirm did NOT advance the paused plan — it is STILL `paused` and n3 never ran.
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('paused');
    expect(await countBudgets('预留预算B')).toBe(0); // n3's side effect is still absent

    // --- EXPLICIT resume through the REAL route: NOW the SUBSEQUENT node runs.
    const resumedRes = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'resume' },
      { ctx: idCtx(taskId), sessionId },
    );
    expect(resumedRes.status).toBe(200);
    const resumed = payload(resumedRes);
    expect(resumed.status).toBe('success');
    expect(nodeStatusOf(resumed, 'n3')).toBe('success');
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('success');
    expect(await nodeStatuses(taskId)).toEqual(['success', 'success', 'success']);
    // n1 is not re-executed (still exactly one Budget A) and n3 ran exactly once.
    expect(await countBudgets('预留预算A')).toBe(1);
    expect(await countBudgets('预留预算B')).toBe(1);
  });
});

describe('[integration] POST /api/tasks/[id] terminal-state protection — a cancelled plan stays cancelled', () => {
  it('resume/retry/pause on a cancelled plan are no-ops (route AND DB agree), moving no money', async () => {
    const { sessionId, taskId, plan } = await seedPlan('先预留预算C，再给张伟转200元', [
      budgetNode('n1', '预留预算C', '预留预算C', 600),
      transferNode('n2', 200, ['n1']),
    ]);
    expect(nodeStatusOf(plan, 'n1')).toBe('success');
    expect(nodeStatusOf(plan, 'n2')).toBe('waiting_confirmation');
    expect(await countBudgets('预留预算C')).toBe(1);
    const budgetC = await getTestPrisma().budget.findFirst({ where: { userId: DEMO_USER_ID, name: '预留预算C' } });
    const parkedActionId = readPendingActionId(resultOf(plan, 'n2').output);
    expect(typeof parkedActionId).toBe('string');

    // Cancel through the REAL route → the plan is TERMINAL.
    const cancelRes = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'cancel' },
      { ctx: idCtx(taskId), sessionId },
    );
    expect(cancelRes.status).toBe(200);
    expect(payload(cancelRes).status).toBe('cancelled');
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('cancelled');
    expect(await nodeStatuses(taskId)).toEqual(['success', 'cancelled']);

    // TERMINAL-STATE PROTECTION: EVERY control on a cancelled plan is a NO-OP — the route response
    // AND the durable row keep saying `cancelled`, and no node is resurrected / re-executed.
    for (const action of ['resume', 'retry', 'pause'] as const) {
      const res = await postJson<Envelope<TaskPlan>>(
        taskPost,
        taskUrl(taskId),
        { action },
        { ctx: idCtx(taskId), sessionId },
      );
      expect(res.status, `${action} on a cancelled plan must be a 200 domain no-op`).toBe(200);
      expect(payload(res).status, `${action} must keep the plan cancelled (route response)`).toBe('cancelled');
      expect(
        (await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status,
        `${action} must keep the plan cancelled (durable row)`,
      ).toBe('cancelled');
      expect(await nodeStatuses(taskId)).toEqual(['success', 'cancelled']);
      // The already-executed node's side effect is neither rolled back nor duplicated.
      expect(await countBudgets('预留预算C')).toBe(1);
      expect(
        (await getTestPrisma().budget.findFirst({ where: { userId: DEMO_USER_ID, name: '预留预算C' } }))!.id,
      ).toBe(budgetC!.id);
    }

    // NOTHING moved: the cancelled plan revoked its parked transfer, so the balance is untouched.
    expect((await getTestPrisma().account.findUnique({ where: { id: CHECKING.id } }))!.balance).toBe(SEEDED_BALANCE);
    expect((await getTestPrisma().pendingAction.findUnique({ where: { id: parkedActionId! } }))!.status).toBe(
      'cancelled',
    );

    // The read model AGREES: `GET /api/tasks` still lists the plan as cancelled.
    const listed = await getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, tasksUrl(), { sessionId });
    expect(listed.status).toBe(200);
    const listedPlan = payload(listed).plans.find((candidate) => candidate.id === taskId);
    expect(listedPlan, `GET /api/tasks must list plan ${taskId}`).toBeDefined();
    expect(listedPlan!.status).toBe('cancelled');
  });
});

describe('[integration] POST /api/tasks/[id] terminal-state protection — a completed plan stays terminal', () => {
  it('retry/resume on a completed plan keep it success and never re-execute a node', async () => {
    // Two 🟢 GREEN probes only → the plan runs to completion (`success`) with no park.
    const { sessionId, taskId, plan } = await seedPlan('先预留预算F，再预留预算G', [
      budgetNode('n1', '预留预算F', '预留预算F', 500),
      budgetNode('n2', '预留预算G', '预留预算G', 700, ['n1']),
    ]);
    expect(plan.status).toBe('success');
    expect(await nodeStatuses(taskId)).toEqual(['success', 'success']);
    const budgetF = await getTestPrisma().budget.findFirst({ where: { userId: DEMO_USER_ID, name: '预留预算F' } });
    const budgetG = await getTestPrisma().budget.findFirst({ where: { userId: DEMO_USER_ID, name: '预留预算G' } });

    // A COMPLETED plan is terminal: retry/resume must leave it `success` (route AND DB) and must never
    // re-run an already-successful node (its side-effect row count stays exactly 1, same row).
    for (const action of ['retry', 'resume'] as const) {
      const res = await postJson<Envelope<TaskPlan>>(
        taskPost,
        taskUrl(taskId),
        { action },
        { ctx: idCtx(taskId), sessionId },
      );
      expect(res.status, `${action} on a completed plan must be a 200 domain no-op`).toBe(200);
      expect(payload(res).status, `${action} must keep the completed plan terminal`).toBe('success');
      expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('success');
      expect(await nodeStatuses(taskId)).toEqual(['success', 'success']);
      expect(await countBudgets('预留预算F')).toBe(1);
      expect(await countBudgets('预留预算G')).toBe(1);
      expect(
        (await getTestPrisma().budget.findFirst({ where: { userId: DEMO_USER_ID, name: '预留预算F' } }))!.id,
      ).toBe(budgetF!.id);
      expect(
        (await getTestPrisma().budget.findFirst({ where: { userId: DEMO_USER_ID, name: '预留预算G' } }))!.id,
      ).toBe(budgetG!.id);
    }
  });
});

/**
 * tests/app/dag-recovery-http.test.ts — REAL-application-entry (HTTP) end-to-end specs for DAG
 * CONTROL / RECOVERY (`pause`→`resume` without re-execution, `cancel` terminal state, `retry` of
 * ONLY the failed node, and refresh RESTORE of per-node statuses + non-terminal pending actions).
 *
 * These specs drive the REAL Next.js route handlers — `POST /api/tasks/[id]` (pause/resume/cancel/
 * retry), `GET /api/tasks/[id]`, `GET /api/actions`, `POST /api/actions/[id]/confirm` and
 * `POST /api/chat` — by importing their exported `POST`/`GET` functions and calling them with REAL
 * `NextRequest` objects (see `./harness.ts`). Underneath the whole production stack runs
 * (`route → @/agent → banking tools → security gateway beforeToolCall → Banking SDK → SQLite`).
 * Only the MODEL is scripted (`tests/setup.ts` forces `LLM_MODE=mock`) — offline, no network.
 *
 * OBSERVABLE NODE EXECUTION — the gap `tasks-http.test.ts` leaves open. That suite asserts node
 * STATUS ONLY (a `retry` there proves a completed node's recorded `output` marker is untouched).
 * These specs add a node whose execution has a COUNTABLE SIDE EFFECT: a 🟢 GREEN `reserve_budget`
 * node creates exactly ONE `Budget` row, so a node that is (wrongly) re-executed would visibly
 * double that row. That lets us prove the real invariants:
 *   • PAUSE stops before the not-yet-run node (no side-effect row is created);
 *   • RESUME skips every already-`success` node (its side-effect row count stays exactly 1);
 *   • RETRY re-runs ONLY the `failed` node (the success node's row count stays 1);
 *   • CANCEL is terminal (the executed node keeps its row; the parked node is `cancelled`).
 *
 * Plans are SEEDED through the PRODUCTION APIs (`getOrCreateSession` + `runSubmitPlan`, exactly as
 * `tasks-http.test.ts#seedPlan`) so real `AgentTask`/`AgentTaskNode` rows exist and every control
 * path's ownership check (`loadOwnedTask`: task.sessionId + matching `AgentSession`) is satisfied.
 *
 * DB lifecycle matches the other DB-backed suites. Every plan gets a UNIQUE persisted session id
 * (the in-process circuit breaker is keyed by `sessionId`). No fake timers.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import { executeGatedTool, getOrCreateSession, readPendingActionId } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { newId } from '@/lib/ids';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import type { PendingAction } from '@/lib/contracts/security';
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  actionUrl,
  chatUrl,
  getJson,
  idCtx,
  postJson,
  taskUrl,
  type HttpResult,
} from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** Primary 活期账户 (¥23,580) — the default funding account every transfer debits. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance (¥23,580). */
const SEEDED_BALANCE = CHECKING.balance;
/** The recipient resolved by name from the seeded contacts. */
const RECIPIENT_NAME = '张伟';

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

/** Failure protocol helper: assert the envelope and return its `{ code, message }`. */
function failure(res: HttpResult<Envelope<unknown>>): { code: string; message: string } {
  expect(res.data?.ok).toBe(false);
  return res.data!.error!;
}

/** The refreshed plan carried by the FIRST `plan_update` event, if any. */
function planUpdateOf(events: readonly { type: string }[]): TaskPlan | undefined {
  return (events as readonly { type: string; plan?: TaskPlan }[]).find((e) => e.type === 'plan_update')?.plan;
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
 *
 * `runSubmitPlan` reports `ok:false` for a HARD-failed plan, but the plan snapshot is still carried in
 * `data`; this helper tolerates that (the failing-node seed is asserted by node status, not `ok`).
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

describe('[integration] POST /api/tasks/[id] pause → resume — no re-execution of successful nodes', () => {
  it('pause halts before the pending node; resume skips the successful one and the plan completes', async () => {
    // n1: 🟢 GREEN probe (ONE Budget row). n2: YELLOW transfer → PARKS. n3: GREEN probe (blocked).
    const { sessionId, taskId, plan } = await seedPlan('先预留预算A，再给张伟转200元，最后预留预算B', [
      budgetNode('n1', '预留预算A', '预留预算A', 1200),
      transferNode('n2', 200, ['n1']),
      budgetNode('n3', '预留预算B', '预留预算B', 800, ['n2']),
    ]);

    // The seeded run executed n1 (exactly one Budget A), parked n2, and never reached n3.
    expect(plan.status).toBe('waiting_confirmation');
    expect(nodeStatusOf(plan, 'n1')).toBe('success');
    expect(nodeStatusOf(plan, 'n2')).toBe('waiting_confirmation');
    expect(nodeStatusOf(plan, 'n3')).toBe('pending');
    expect(await countBudgets('预留预算A')).toBe(1);
    expect(await countBudgets('预留预算B')).toBe(0);
    const budgetA = await getTestPrisma().budget.findFirst({
      where: { userId: DEMO_USER_ID, name: '预留预算A' },
    });

    // --- PAUSE: the not-yet-run node (n3) has NOT executed (its side-effect row is still absent).
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
    expect(nodeStatusOf(paused, 'n3')).toBe('pending'); // never started
    expect(await countBudgets('预留预算B')).toBe(0); // no side effect
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('paused');

    // --- RESUME: n1 is terminal → NEVER re-run (its Budget row count stays exactly 1, same row);
    // n2 (parked, non-terminal) re-runs through the gateway and RE-PARKS; n3 stays un-run.
    const resumedRes = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'resume' },
      { ctx: idCtx(taskId), sessionId },
    );
    expect(resumedRes.status).toBe(200);
    const resumed = payload(resumedRes);
    expect(resumed.status).toBe('waiting_confirmation');
    expect(nodeStatusOf(resumed, 'n1')).toBe('success');
    expect(nodeStatusOf(resumed, 'n2')).toBe('waiting_confirmation');
    expect(nodeStatusOf(resumed, 'n3')).toBe('pending');

    // The success node was NOT re-executed: exactly one Budget A row, and it is the SAME row.
    expect(await countBudgets('预留预算A')).toBe(1);
    const budgetAAfter = await getTestPrisma().budget.findFirst({
      where: { userId: DEMO_USER_ID, name: '预留预算A' },
    });
    expect(budgetAAfter!.id).toBe(budgetA!.id);
    expect(await countBudgets('预留预算B')).toBe(0); // n3 still not started

    // n2 re-parked on a FRESH pending action (a re-run minted a new gate).
    const reparkedActionId = readPendingActionId(resultOf(resumed, 'n2').output);
    expect(typeof reparkedActionId).toBe('string');
    expect(reparkedActionId).not.toBe(readPendingActionId(resultOf(plan, 'n2').output));

    // --- Confirm the re-parked action: n2 executes for real and the plan CONTINUES to n3 (completes).
    const confirmRes = await postJson<Envelope<{ ok: boolean; status: string; tier: string; events: { type: string; plan?: TaskPlan }[] }>>(
      confirmPost,
      actionUrl(reparkedActionId!, 'confirm'),
      {},
      { ctx: idCtx(reparkedActionId!), sessionId },
    );
    expect(confirmRes.status).toBe(200);
    const outcome = payload(confirmRes);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    const finalPlan = planUpdateOf(outcome.events);
    expect(finalPlan).toBeDefined();
    expect(finalPlan!.status).toBe('success');
    expect(nodeStatusOf(finalPlan!, 'n3')).toBe('success');

    // The GREEN probe n1 STILL ran exactly once; n3 ran exactly once now.
    expect(await countBudgets('预留预算A')).toBe(1);
    expect(await countBudgets('预留预算B')).toBe(1);
    // The real transfer moved exactly ¥200 out of the checking account.
    const account = await getTestPrisma().account.findUnique({ where: { id: CHECKING.id } });
    expect(account!.balance).toBe(SEEDED_BALANCE - 200);
  });
});

describe('[integration] POST /api/tasks/[id] cancel — terminal state, executed work preserved', () => {
  it('cancels the remaining nodes, keeps the executed node, revokes the parked action, moves no money', async () => {
    const { sessionId, taskId, plan } = await seedPlan('先预留预算C，再给张伟转200元', [
      budgetNode('n1', '预留预算C', '预留预算C', 600),
      transferNode('n2', 200, ['n1']),
    ]);
    expect(nodeStatusOf(plan, 'n1')).toBe('success');
    expect(nodeStatusOf(plan, 'n2')).toBe('waiting_confirmation');
    expect(await countBudgets('预留预算C')).toBe(1);
    const parkedActionId = readPendingActionId(resultOf(plan, 'n2').output);
    expect(typeof parkedActionId).toBe('string');

    const res = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'cancel' },
      { ctx: idCtx(taskId), sessionId },
    );

    expect(res.status).toBe(200);
    const cancelled = payload(res);
    expect(cancelled.status).toBe('cancelled');
    // The TERMINAL state: the executed node keeps `success`, the remaining node is `cancelled`.
    expect(nodeStatusOf(cancelled, 'n1')).toBe('success');
    expect(nodeStatusOf(cancelled, 'n2')).toBe('cancelled');

    // Durable: node rows + the AgentTask row agree with the snapshot.
    const nodes = await getTestPrisma().agentTaskNode.findMany({
      where: { taskId },
      orderBy: { order: 'asc' },
    });
    expect(nodes.map((node) => node.status)).toEqual(['success', 'cancelled']);
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('cancelled');

    // The executed node's side effect is NOT rolled back (irreversible) and is NOT duplicated.
    expect(await countBudgets('预留预算C')).toBe(1);
    // NOTHING moved: the parked transfer never ran and the balance is untouched.
    expect((await getTestPrisma().account.findUnique({ where: { id: CHECKING.id } }))!.balance).toBe(SEEDED_BALANCE);
    // The parked action was REVOKED through the gateway (a later confirm can never move money).
    const revoked = await getTestPrisma().pendingAction.findUnique({ where: { id: parkedActionId! } });
    expect(revoked!.status).toBe('cancelled');
  });
});

describe('[integration] POST /api/tasks/[id] retry — re-runs ONLY the failed node', () => {
  it('re-runs the failed gated node (fresh gate) while the successful node is not re-executed', async () => {
    const { sessionId, taskId, plan } = await seedPlan('先预留预算R，再给张伟转200元', [
      budgetNode('n1', '预留预算R', '预留预算R', 600),
      transferNode('n2', 200, ['n1']),
    ]);
    expect(nodeStatusOf(plan, 'n1')).toBe('success');
    expect(nodeStatusOf(plan, 'n2')).toBe('waiting_confirmation');
    expect(await countBudgets('预留预算R')).toBe(1);
    const budgetR = await getTestPrisma().budget.findFirst({
      where: { userId: DEMO_USER_ID, name: '预留预算R' },
    });
    const firstActionId = readPendingActionId(resultOf(plan, 'n2').output);
    expect(typeof firstActionId).toBe('string');

    // Drain EVERY account so the confirmed transfer FAILS honestly (`INSUFFICIENT_FUNDS`) whichever
    // account the SDK resolves as the funding source — the ONLY way a plan node becomes `failed`
    // (a gated node parks, it never fails inline).
    await getTestPrisma().account.updateMany({ where: { userId: DEMO_USER_ID }, data: { balance: 0 } });

    const confirmRes = await postJson<Envelope<{ ok: boolean; status: string; tier: string }>>(
      confirmPost,
      actionUrl(firstActionId!, 'confirm'),
      {},
      { ctx: idCtx(firstActionId!), sessionId },
    );
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.data?.ok).toBe(false);
    expect(confirmRes.data!.data!.ok).toBe(false);
    expect(confirmRes.data!.data!.status).toBe('failed');

    // The plan and its failing node are durably `failed`; the parked action is settled `failed`.
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('failed');
    const failedNode = await getTestPrisma().agentTaskNode.findFirst({ where: { taskId, nodeId: 'n2' } });
    expect(failedNode!.status).toBe('failed');
    expect((await getTestPrisma().pendingAction.findUnique({ where: { id: firstActionId! } }))!.status).toBe('failed');

    const retryRes = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'retry' },
      { ctx: idCtx(taskId), sessionId },
    );
    expect(retryRes.status).toBe(200);
    const retried = payload(retryRes);

    // The failed node RE-RAN: it went through the gateway again and re-parked on a FRESH action.
    expect(nodeStatusOf(retried, 'n2')).toBe('waiting_confirmation');
    const secondActionId = readPendingActionId(resultOf(retried, 'n2').output);
    expect(typeof secondActionId).toBe('string');
    expect(secondActionId).not.toBe(firstActionId);
    const fresh = await getTestPrisma().pendingAction.findUnique({ where: { id: secondActionId! } });
    expect(fresh!.toolName).toBe('transfer_money');
    expect(fresh!.status).toBe('pending');

    // The already-successful node was NOT re-run: exactly ONE Budget R row, still the SAME row.
    expect(await countBudgets('预留预算R')).toBe(1);
    expect((await getTestPrisma().budget.findFirst({ where: { userId: DEMO_USER_ID, name: '预留预算R' } }))!.id).toBe(
      budgetR!.id,
    );
  });
});

describe('[integration] GET /api/tasks/[id] + GET /api/actions — refresh restore', () => {
  it('GET /api/tasks/[id] returns per-node statuses AND the parked node pendingActionId', async () => {
    const { sessionId, taskId, plan } = await seedPlan('先预留预算D，再给张伟转200元，最后预留预算E', [
      budgetNode('n1', '预留预算D', '预留预算D', 300),
      transferNode('n2', 200, ['n1']),
      budgetNode('n3', '预留预算E', '预留预算E', 400, ['n2']),
    ]);
    const parkedActionId = readPendingActionId(resultOf(plan, 'n2').output);
    expect(typeof parkedActionId).toBe('string');

    const res = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), {
      ctx: idCtx(taskId),
      sessionId,
    });
    expect(res.status).toBe(200);
    const recovered = payload(res);
    expect(recovered.id).toBe(taskId);
    expect(recovered.sessionId).toBe(sessionId);
    expect(recovered.status).toBe('waiting_confirmation');
    // Per-node statuses survived the reload: executed / parked / never-started.
    expect(recovered.nodes.map((node) => node.id)).toEqual(['n1', 'n2', 'n3']);
    expect(recovered.results.map((result) => result.status)).toEqual([
      'success',
      'waiting_confirmation',
      'pending',
    ]);
    // The parked node's `pendingActionId` (recorded in its `output` JSON) points at the REAL row.
    const recoveredActionId = readPendingActionId(resultOf(recovered, 'n2').output);
    expect(recoveredActionId).toBe(parkedActionId);
    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: recoveredActionId! } });
    expect(row!.sessionId).toBe(sessionId);
    expect(row!.toolName).toBe('transfer_money');
    expect(row!.status).toBe('pending');
  });

  it('GET /api/actions returns the caller session non-terminal action only (foreign session sees none)', async () => {
    // A real chat turn parks a YELLOW transfer → the session gets a durable pending action.
    const chat = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
      sessionId: newId('sess'),
      message: '给张伟转200元',
    });
    expect(chat.status).toBe(200);
    const turn = payload(chat);

    // (a) The OWNING session lists exactly its parked YELLOW action, with truthful contract fields.
    const own = await getJson<Envelope<PendingAction[]>>(actionsGet, '/api/actions', {
      sessionId: turn.sessionId,
    });
    expect(own.status).toBe(200);
    const actions = payload(own);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    const action = actions[0];
    expect(action.sessionId).toBe(turn.sessionId);
    expect(action.toolName).toBe('transfer_money');
    expect(action.tier).toBe('YELLOW');
    expect(action.requiresMfa).toBe(false);
    expect(action.status).toBe('pending');
    // It corresponds to a persisted NON-TERMINAL row (never an executed/cancelled one).
    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row!.status).toBe('pending');

    // (b) A DIFFERENT (foreign) persisted session sees NOTHING of this session's actions.
    const foreignSessionId = await newPersistedSessionId();
    const foreign = await getJson<Envelope<PendingAction[]>>(actionsGet, '/api/actions', {
      sessionId: foreignSessionId,
    });
    expect(foreign.status).toBe(200);
    expect(payload(foreign)).toEqual([]);

    // (c) Missing cookie → 403 SECURITY_DENIED (identity is cookie-only, never a query param).
    const anonymous = await getJson<Envelope<PendingAction[]>>(actionsGet, '/api/actions');
    expect(anonymous.status).toBe(403);
    expect(failure(anonymous).code).toBe('SECURITY_DENIED');
  });
});

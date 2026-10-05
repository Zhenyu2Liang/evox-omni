/**
 * tests/app/task-resume-retry-http.test.ts — REAL-application-entry (HTTP) end-to-end regression for
 * CONCURRENT task-control requests racing on the SAME durable task.
 *
 * The other task specs (`dag-recovery-http.test.ts`, `tasks-http.test.ts`) drive the control routes
 * ONE request at a time. This spec drives TWO overlapping `POST /api/tasks/[id]` requests in
 * PARALLEL against the same `paused` / `failed` task and pins the two invariants a durable control
 * path must uphold under concurrency:
 *
 *   1. EXACTLY-ONCE side effect — the still-unfinished node runs ONCE, never twice. A 🟢 GREEN
 *      `reserve_budget` node creates exactly ONE `Budget` row per execution, so a doubled run is
 *      directly observable (`budget.count({ where: { userId, name } }) === 1`); for the gated retry
 *      path the countable side effect is the single FRESH `PendingAction` (`pendingAction.count`).
 *   2. CONSISTENT persisted state — the durable `AgentTask.status` agrees with the node rows and the
 *      `GET /api/tasks/[id]` read model (no lost update, no duplicated node rows, no stale
 *      `running` written over a settled plan).
 *
 * The two requests are forced to OVERLAP by a controlled, non-deadlocking BARRIER at the route
 * boundary (`makeBarrier`): neither request may enter the control logic until BOTH have arrived, so
 * the compare-and-set the fix relies on is genuinely exercised instead of one request finishing
 * before the other starts.
 *
 * The whole production stack runs (`route → @/agent → banking tools → security gateway
 * beforeToolCall → Banking SDK → SQLite`); ONLY the model is scripted (`tests/setup.ts` forces
 * `LLM_MODE=mock`) — offline, no network, no fake timers. Plans are SEEDED through the production
 * APIs (`getOrCreateSession` + `runSubmitPlan`) so real `AgentTask`/`AgentTaskNode`/`PendingAction`
 * rows exist and every control path's ownership check (`loadOwnedTask`: task.sessionId + matching
 * `AgentSession`) is satisfied. Each test gets a fresh DB and a UNIQUE persisted session id (the
 * in-process circuit breaker is keyed by `sessionId`).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import { executeGatedTool, getOrCreateSession, pauseTask, readPendingActionId } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  actionUrl,
  getJson,
  idCtx,
  postJson,
  taskUrl,
  type HttpResult,
  type RouteHandler,
} from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** Primary 活期账户 (¥23,580) — the default funding account every transfer debits. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance (¥23,580). */
const SEEDED_BALANCE = CHECKING.balance;
/** The recipient resolved by name from the seeded contacts. */
const RECIPIENT_NAME = '张伟';
/** How long the barrier waits for its second arrival before falling back (guards against a HANG). */
const BARRIER_TIMEOUT_MS = 3000;

/**
 * The route's JSON envelope — the transport shape (NOT a frozen `@/lib/contracts` type), declared
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

/** The 🟢 GREEN node used as the COUNTABLE execution probe (one `Budget` row per run). */
function budgetNode(id: string, name: string, budgetName: string, amount: number, deps: string[] = []): SeedNode {
  return { id, name, dependencies: deps, kind: 'tool', tool: 'reserve_budget', args: { name: budgetName, amount } };
}

/** The YELLOW `transfer_money` node (gated → PARKS for a human decision instead of executing). */
function transferNode(id: string, amount: number, deps: string[] = []): SeedNode {
  return { id, name: `给${RECIPIENT_NAME}转账`, dependencies: deps, kind: 'tool', tool: 'transfer_money', args: { name: RECIPIENT_NAME, amount } };
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

/** Count the `Budget` rows with the given name (0 ⇒ that node never executed; 2 ⇒ it ran twice). */
function countBudgets(name: string): Promise<number> {
  return getTestPrisma().budget.count({ where: { userId: DEMO_USER_ID, name } });
}

/** All durable node rows of a task, in topological (insertion) order. */
function nodeRowsOf(taskId: string) {
  return getTestPrisma().agentTaskNode.findMany({ where: { taskId }, orderBy: { order: 'asc' } });
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

/**
 * Seed a plan that settles `paused` with its 🟢 GREEN `n1` already `success` and its 🟢 GREEN `n2`
 * still `pending` — by pausing the LIVE run from inside `n1`'s `runTool` (the durable pause is
 * observed at the next node checkpoint, so `n2` never starts). This is the canonical way to obtain a
 * genuinely resumable task whose remaining node has a COUNTABLE side effect.
 */
async function seedPausedPlan(marker: string): Promise<{ sessionId: string; taskId: string; plan: TaskPlan }> {
  const sessionId = await newPersistedSessionId();
  let taskId = '';
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    {
      goal: '先读余额，再预留并发预算',
      nodes: [
        { id: 'n1', name: '读余额', kind: 'tool', tool: 'get_balance', args: {}, dependencies: [] },
        budgetNode('n2', '预留并发预算', marker, 1200, ['n1']),
      ],
    },
    {
      sessionId,
      runTool: async () => {
        const task = await getTestPrisma().agentTask.findFirst({ where: { sessionId } });
        taskId = task!.id;
        await pauseTask(sessionId, taskId);
        return { ok: true, data: { balance: SEEDED_BALANCE } };
      },
    },
  );
  const plan = result.data as TaskPlan | undefined;
  expect(plan, `runSubmitPlan produced no plan: ${result.error}`).toBeDefined();
  return { sessionId, taskId: taskId === '' ? plan!.id : taskId, plan: plan! };
}

/* ---------------------------------------------------------------------------------- barrier */

/**
 * A CONTROLLED request rendezvous. `expected` entries must arrive before EITHER proceeds past
 * `wait()`, so the two HTTP control requests are genuinely IN FLIGHT at the same time and the race
 * the production compare-and-set must resolve actually happens (instead of one request finishing
 * before the other starts).
 *
 * A bounded timeout releases the barrier if the second entry never arrives, so a regression can
 * never HANG the suite. The fallback is OBSERVABLE (`timedOut()`): every spec asserts it stayed
 * `false`, so a broken rendezvous fails loudly instead of silently weakening the overlap.
 */
function makeBarrier(expected: number) {
  let arrived = 0;
  let timedOut = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return {
    wait: async (): Promise<void> => {
      arrived += 1;
      if (arrived >= expected) {
        releaseGate();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fallback = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, BARRIER_TIMEOUT_MS);
      });
      try {
        await Promise.race([gate, fallback]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    arrived: (): number => arrived,
    timedOut: (): boolean => timedOut,
  };
}

/** Wrap the REAL task-control handler so both invocations rendezvous before entering the control path. */
function gatedHandler(barrier: { wait: () => Promise<void> }): RouteHandler {
  return async (req, ctx) => {
    await barrier.wait();
    return taskPost(req, ctx);
  };
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] POST /api/tasks/[id] concurrent resume — the unfinished node runs EXACTLY ONCE', () => {
  it('[integration] two overlapping {action:"resume"} requests execute the pending node once and settle one consistent status', async () => {
    const marker = '并发恢复预算';
    const { sessionId, taskId, plan } = await seedPausedPlan(marker);

    // Preconditions: n1 already succeeded (its side effect is a single Budget row), n2 never ran.
    expect(plan.status).toBe('paused');
    expect(nodeStatusOf(plan, 'n1')).toBe('success');
    expect(nodeStatusOf(plan, 'n2')).toBe('pending');
    expect(await countBudgets(marker)).toBe(0);
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('paused');

    // --- The CONTROLLED BARRIER: both control requests must be in flight before either proceeds.
    const barrier = makeBarrier(2);
    const gated = gatedHandler(barrier);
    const [first, second] = await Promise.all([
      postJson<Envelope<TaskPlan>>(gated, taskUrl(taskId), { action: 'resume' }, { ctx: idCtx(taskId), sessionId }),
      postJson<Envelope<TaskPlan>>(gated, taskUrl(taskId), { action: 'resume' }, { ctx: idCtx(taskId), sessionId }),
    ]);

    // The rendezvous really happened — a fallback timeout would flag a broken overlap.
    expect(barrier.arrived()).toBe(2);
    expect(barrier.timedOut()).toBe(false);

    // Both requests were handled by the route without an unhandled crash, and at least one resumed.
    // (Whether the LOSING request reports the current snapshot or a domain conflict is an
    // implementation detail of the fix; the DURABLE invariants below are the contract.)
    expect([first.status, second.status]).not.toContain(500);
    expect([first.status, second.status]).toContain(200);

    // --- EXACTLY-ONCE: the unfinished node's side effect happened exactly ONCE, never twice.
    expect(await countBudgets(marker)).toBe(1);

    // --- CONSISTENT PERSISTED STATE: one durable row per node, one settled plan status.
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('success');
    const nodeRows = await nodeRowsOf(taskId);
    expect(nodeRows.map((node) => node.nodeId)).toEqual(['n1', 'n2']); // no duplicated node rows
    expect(nodeRows.map((node) => node.status)).toEqual(['success', 'success']);

    // The durable read model AGREES with the row (same settled plan status, same node statuses).
    const readBack = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), { ctx: idCtx(taskId), sessionId });
    expect(readBack.status).toBe(200);
    const recovered = payload(readBack);
    expect(recovered.id).toBe(taskId);
    expect(recovered.status).toBe(row!.status);
    expect(recovered.results.map((result) => result.status)).toEqual(nodeRows.map((node) => node.status));
  });
});

describe('[integration] POST /api/tasks/[id] concurrent retry — the failed node re-runs EXACTLY ONCE', () => {
  it('[integration] two overlapping {action:"retry"} requests re-gate the failed node once and settle one consistent status', async () => {
    const marker = '并发重试预算';
    const { sessionId, taskId, plan } = await seedPlan('先预留并发重试预算，再给张伟转200元', [
      budgetNode('n1', marker, marker, 600),
      transferNode('n2', 200, ['n1']),
    ]);
    expect(nodeStatusOf(plan, 'n1')).toBe('success');
    expect(nodeStatusOf(plan, 'n2')).toBe('waiting_confirmation');
    expect(await countBudgets(marker)).toBe(1);
    const firstActionId = readPendingActionId(resultOf(plan, 'n2').output);
    expect(typeof firstActionId).toBe('string');

    // Drain EVERY account so the confirmed transfer FAILS honestly (`INSUFFICIENT_FUNDS`) whichever
    // account the SDK resolves as the funding source — the ONLY way a plan node becomes `failed`
    // (a gated node parks, it never fails inline). Mirrors `dag-recovery-http.test.ts`.
    await getTestPrisma().account.updateMany({ where: { userId: DEMO_USER_ID }, data: { balance: 0 } });
    const confirmRes = await postJson<Envelope<{ ok: boolean; status: string }>>(
      confirmPost,
      actionUrl(firstActionId!, 'confirm'),
      {},
      { ctx: idCtx(firstActionId!), sessionId },
    );
    expect(confirmRes.status).toBe(200);
    // Domain outcome INSIDE the success envelope: the transport succeeded, the TOOL failed honestly.
    expect(confirmRes.data?.ok).toBe(true);
    expect(confirmRes.data!.data!.ok).toBe(false);
    expect(confirmRes.data!.data!.status).toBe('failed');
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('failed');
    expect((await nodeRowsOf(taskId)).map((node) => node.status)).toEqual(['success', 'failed']);

    // --- The CONTROLLED BARRIER: both retry requests in flight before either proceeds.
    const barrier = makeBarrier(2);
    const gated = gatedHandler(barrier);
    const [first, second] = await Promise.all([
      postJson<Envelope<TaskPlan>>(gated, taskUrl(taskId), { action: 'retry' }, { ctx: idCtx(taskId), sessionId }),
      postJson<Envelope<TaskPlan>>(gated, taskUrl(taskId), { action: 'retry' }, { ctx: idCtx(taskId), sessionId }),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(barrier.timedOut()).toBe(false);
    expect([first.status, second.status]).not.toContain(500);
    expect([first.status, second.status]).toContain(200);

    // --- EXACTLY-ONCE: the failed node re-ran ONE time → exactly ONE fresh gate (not two). The
    // original gate was settled `failed` by the honest failure above, so only a fresh one is pending.
    const freshGates = await getTestPrisma().pendingAction.findMany({
      where: { sessionId, toolName: 'transfer_money', status: 'pending' },
    });
    expect(freshGates.length).toBe(1);
    expect(freshGates[0]!.id).not.toBe(firstActionId);

    // The already-successful n1 was NOT re-executed: still exactly ONE Budget row.
    expect(await countBudgets(marker)).toBe(1);

    // --- CONSISTENT PERSISTED STATE: the plan re-parked (not a stale `running`), one row per node.
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('waiting_confirmation');
    const nodeRows = await nodeRowsOf(taskId);
    expect(nodeRows.map((node) => node.nodeId)).toEqual(['n1', 'n2']);
    expect(nodeRows.map((node) => node.status)).toEqual(['success', 'waiting_confirmation']);

    // The read model agrees, and its parked node points at the SINGLE fresh gate.
    const readBack = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), { ctx: idCtx(taskId), sessionId });
    expect(readBack.status).toBe(200);
    const recovered = payload(readBack);
    expect(recovered.status).toBe(row!.status);
    expect(readPendingActionId(resultOf(recovered, 'n2').output)).toBe(freshGates[0]!.id);
  });
});

/**
 * tests/app/concurrent-execution-http.test.ts — REAL-application-entry (HTTP) e2e for a node whose
 * SIDE EFFECT is already done but whose RESULT has not yet been persisted, driven through CONTROLLED,
 * non-deadlocking BARRIERS.
 *
 * The sibling `task-resume-retry-http.test.ts` already proves "two overlapping `{action:'resume'}`
 * (or two `retry`) requests run the unfinished node once" by racing the control handler against itself
 * at its very ENTRY. This spec adds the DISTINCT concurrency windows the entry-barrier technique
 * cannot reach, and pins the exactly-once invariants under each:
 *
 *   WINDOW A — "side effect DONE, node result NOT yet persisted". The real plan runner executes each
 *     node through an injected `runTool` port (`runSubmitPlan`), so this spec wraps that port
 *     (`heldRunTool`) to run the node's REAL work through the real gate (`executeGatedTool` → creates
 *     exactly ONE `Budget` row for the 🟢 GREEN `reserve_budget` node) and then AWAIT a deferred gate
 *     BEFORE returning. While the run is held there, the node's `AgentTaskNode` row is still `running`
 *     (the executor persisted the ROW status before calling `runTool` but has not recorded the RESULT
 *     yet) and the plan row is `running`. A concurrent `POST /api/tasks/[id]` (`resume` / `retry`) is
 *     issued through the REAL handler INSIDE that window; it must add NO second side effect. Releasing
 *     the gate lets the held node settle and the whole plan is asserted consistent.
 *
 *   WINDOW B — the CONFIRM-CONTINUATION racing a control request. The confirm path
 *     (`POST /api/actions/[id]/confirm`) does NOT take the plan's DB execution claim — it authorizes,
 *     executes the ORIGINAL args, records the terminal status and then RESUMES the owning plan
 *     (`agent/confirmation.ts#resumeOwningPlan` → `resumeTaskForAction`). Racing it, through a
 *     rendezvous barrier, against a concurrent `POST /api/tasks/[id]` (`resume` / `retry`) on the SAME
 *     parked plan exercises the mechanisms that keep the parked node's work exactly-once across the two
 *     independent drive paths (the gateway's reusable-`PendingAction` dedupe, the planner's per-node DB
 *     claim and the SDK `nodeExecutionKey` idempotency).
 *
 * THE EXACTLY-ONCE INVARIANTS ASSERTED IN EVERY WINDOW (window A / B alike):
 *   1. EXACTLY ONE countable side effect — ONE `Budget` row per `reserve_budget` node, ONE ledger row
 *      for the parked transfer, ONE `PendingAction` (no duplicate gate).
 *   2. CONSISTENT settled state — exactly ONE `AgentTaskNode` row per declared node (asserted as the
 *      exact ordered `nodeId` list), a non-stale `AgentTask.status`, and a `GET /api/tasks/[id]` read
 *      model that AGREES with the durable row.
 *
 * THE BARRIER TECHNIQUE (the point of the spec): a bounded rendezvous (`makeBarrier`) releases only
 * once `n` callers have arrived, so two requests are genuinely IN FLIGHT at the same time. A bounded
 * timeout (`BARRIER_TIMEOUT_MS`) releases the barrier if the second entry never arrives, so a
 * regression can never HANG the suite; the fallback is OBSERVABLE (`timedOut()`) and every spec
 * asserts it stayed `false`, so a broken overlap fails LOUDLY instead of silently weakening.
 *
 * The whole production stack runs (`route → @/agent → banking tools → security gateway
 * beforeToolCall → Banking SDK → SQLite`); ONLY the model is scripted (`tests/setup.ts` forces
 * `LLM_MODE=mock`) — offline, no network, no fake timers. Plans are SEEDED through the production APIs
 * (`getOrCreateSession` + `runSubmitPlan`) so real `AgentTask`/`AgentTaskNode`/`PendingAction` rows
 * exist and every control path's ownership check (`loadOwnedTask`: `task.sessionId` + a matching
 * `AgentSession`) is satisfied. Each test gets a fresh DB and a UNIQUE persisted session id (the
 * in-process circuit breaker is keyed by `sessionId`).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { executeGatedTool, getOrCreateSession, readPendingActionId } from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
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

/** Primary 活期账户 (¥23,580) — the funding account the parked transfer debits. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance (¥23,580). */
import { centsToMoney, moneyToCents, normalizeMoney, subtractMoney } from '@/lib/money';
const SEEDED_BALANCE = normalizeMoney(CHECKING.balance);
/** Recipient 张伟 — the parked transfer's payee (the money-moved-at-most-once probe). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The parked transfer amount (≤ ¥1000 ⇒ YELLOW / confirmation-only). */
const TRANSFER_AMOUNT = '200';
/** How long a barrier waits for its second arrival before falling back (guards against a HANG). */
const BARRIER_TIMEOUT_MS = 3000;

/** `PendingAction` statuses an action could still be executed from (the "no executable gate" probe). */
const EXECUTABLE_STATUSES: PendingActionStatus[] = ['pending', 'awaiting_mfa', 'confirmed'];

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

/** The 🟢 GREEN read used as the already-settled first node. */
function balanceNode(id: string, deps: string[] = []): SeedNode {
  return { id, name: '读余额', kind: 'tool', tool: 'get_balance', args: {}, dependencies: deps };
}

/** The 🟢 GREEN node used as the COUNTABLE execution probe (one `Budget` row per real execution). */
function budgetNode(id: string, budgetName: string, amount: string, deps: string[] = []): SeedNode {
  return {
    id,
    name: '预留并发预算',
    dependencies: deps,
    kind: 'tool',
    tool: 'reserve_budget',
    args: { name: budgetName, amount },
  };
}

/** The YELLOW `transfer_money` node (gated → PARKS for a human decision instead of executing). */
function transferNode(id: string, amount: string, deps: string[] = []): SeedNode {
  return {
    id,
    name: `给${ZHANGWEI.name}转账`,
    dependencies: deps,
    kind: 'tool',
    tool: 'transfer_money',
    args: { name: ZHANGWEI.name, amount },
  };
}

/** Create + persist a fresh `AgentSession` for the demo user and return its id. */
async function newPersistedSessionId(): Promise<string> {
  return (await getOrCreateSession(DEMO_USER_ID)).sessionId;
}

/**
 * The gateway-routed per-node runner: every node passes its `{taskId, nodeId}` node identity, so a
 * gated node parks with a PERSISTED plan link and the SDK idempotency key is the node identity.
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

/** Count the `Budget` rows with the given name (0 ⇒ never ran; 2 ⇒ ran twice). */
function countBudgets(name: string): Promise<number> {
  return getTestPrisma().budget.count({ where: { userId: DEMO_USER_ID, name } });
}

/** All durable node rows of a task, in topological (insertion) order. */
function nodeRowsOf(taskId: string) {
  return getTestPrisma().agentTaskNode.findMany({ where: { taskId }, orderBy: { order: 'asc' } });
}

/** Every ledger row paid to 张伟 (the money-moved-at-most-once probe). */
function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/** The session's `PendingAction`s that could still be EXECUTED (settled ones are excluded). */
function executableActions(sessionId: string) {
  return getTestPrisma().pendingAction.findMany({
    where: { sessionId, status: { in: EXECUTABLE_STATUSES } },
  });
}

/** Current 活期 balance (¥23,580 seeded). */
async function checkingBalance(): Promise<string> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return centsToMoney(account.balanceMinor);
}

/**
 * Seed a durable plan through the PRODUCTION `submit_plan` runner: real `AgentTask`/`AgentTaskNode`
 * rows + (for a gated node) a real plan-linked `PendingAction`.
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

/* ------------------------------------------------------------------ the held-node barrier seam */

/** A run held OPEN inside a node, with its side effect already applied but its result unrecorded. */
interface HeldRun {
  /** Resolves once the hold node's REAL work has completed (its side effect exists). */
  reached: Promise<void>;
  /** Releases the held node so the run records its result and settles. */
  release: () => void;
  /** The gateway-routed, holding `runTool` to hand to `runSubmitPlan`. */
  runTool: PlanRunTool;
}

/**
 * Build the held-node `runTool` for `sessionId`.
 *
 * Every node routes through the REAL gate (`executeGatedTool`), so a 🟢 GREEN node's side effect
 * (e.g. the `Budget` row for `reserve_budget`) happens HERE, inline. The call for `holdNodeId` then
 * signals `reached` and AWAITS a deferred `gate` — so the side effect EXISTS while `runPlan` has not
 * yet recorded the node's result (its row is still `running`).
 */
function heldRunTool(sessionId: string, goal: string, holdNodeId: string): HeldRun {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });

  const runTool: PlanRunTool = async (toolName, args, ctx) => {
    const outcome = await executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName,
      args,
      userRequest: goal,
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });
    if (ctx.nodeId === holdNodeId) {
      signalReached();
      await gate; // the side effect exists; the planner has NOT persisted the node result yet
    }
    return outcome;
  };

  return { reached, release, runTool };
}

/* ---------------------------------------------------------------------------------- barrier */

/**
 * A CONTROLLED request rendezvous. `expected` entries must arrive before EITHER proceeds past
 * `wait()`, so the two HTTP requests are genuinely IN FLIGHT at the same time and the race the
 * production compare-and-set must resolve actually happens (instead of one request finishing before
 * the other starts).
 *
 * A bounded timeout releases the barrier if the second entry never arrives, so a regression can never
 * HANG the suite. The fallback is OBSERVABLE (`timedOut()`): every spec asserts it stayed `false`.
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

/** Wrap a REAL route handler so every invocation rendezvous at the barrier before entering it. */
function gatedHandler(
  handler: RouteHandler,
  barrier: { wait: () => Promise<void> },
): RouteHandler {
  return async (req, ctx) => {
    await barrier.wait();
    return handler(req, ctx);
  };
}

/* ------------------------------------------------------------------ route invokers */

/** `POST /api/tasks/[id]` with `{action}` — identity travels as the `banking_session` cookie. */
function taskControl(
  taskId: string,
  action: 'pause' | 'resume' | 'cancel' | 'retry',
  sessionId: string,
  handler: RouteHandler = taskPost,
): Promise<HttpResult<Envelope<TaskPlan>>> {
  return postJson<Envelope<TaskPlan>>(handler, taskUrl(taskId), { action }, {
    ctx: idCtx(taskId),
    sessionId,
  });
}

/** `POST /api/actions/[id]/confirm` — identity travels as the `banking_session` cookie. */
function confirmAction(
  actionId: string,
  sessionId: string,
  handler: RouteHandler = confirmPost,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(handler, actionUrl(actionId, 'confirm'), {}, {
    ctx: idCtx(actionId),
    sessionId,
  });
}

/** `GET /api/tasks/[id]` — the durable read model. */
function readTask(
  taskId: string,
  sessionId: string,
): Promise<HttpResult<Envelope<TaskPlan>>> {
  return getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), { ctx: idCtx(taskId), sessionId });
}

/** Assert the durable `AgentTask` row and the `GET /api/tasks/[id]` read model fully agree. */
async function expectReadModelAgrees(
  taskId: string,
  sessionId: string,
  expectedStatus: string,
): Promise<void> {
  const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
  expect(row, `AgentTask ${taskId} must exist`).not.toBeNull();
  expect(row!.status).toBe(expectedStatus);
  const nodeRows = await nodeRowsOf(taskId);
  const readBack = await readTask(taskId, sessionId);
  expect(readBack.status).toBe(200);
  const recovered = payload(readBack);
  expect(recovered.id).toBe(taskId);
  expect(recovered.status).toBe(row!.status);
  expect(recovered.results.map((result) => result.status)).toEqual(
    nodeRows.map((node) => node.status),
  );
}

/**
 * The post-race EXACTLY-ONCE + CONSISTENCY contract of Window B, asserted identically for both the
 * `resume` and the `retry` drive (the two requests genuinely overlapped, so the interleaving decides
 * whether the control request re-parked the gated node or observed it already decided — BOTH are
 * legitimate, and NEITHER may break these invariants).
 *
 * 1. EXACTLY-ONCE MONEY: one ledger row for the parked transfer, the balance debited once. This is
 *    the money-safety invariant and it does NOT depend on the interleaving.
 * 2. The HUMAN decision executed the ORIGINAL parked action exactly once; a control request can only
 *    PARK a gated node, never execute one, so exactly ONE action ever reaches `executed`.
 * 3. The already-`success` 🟢 node was NOT re-executed (exactly ONE `Budget` side effect).
 * 4. Exactly ONE `AgentTaskNode` row per declared node — never a duplicated row.
 * 5. The plan never settles stale: no `'running'` status, the plan-level execution claim released,
 *    and the `GET /api/tasks/[id]` read model agreeing with the durable row.
 * 6. EXACTLY-ONCE AT THE LEDGER, whatever the GATE count: the racing control request may add ONE
 *    fresh gate, but only a RE-PARK of the SAME node — and executing that fresh gate REPLAYS the
 *    node's original side effect (its `nodeExecutionKey` idempotency) instead of double-debiting.
 */
async function expectExactlyOnceLedgerAndConsistentState(state: {
  sessionId: string;
  taskId: string;
  actionId: string;
  marker: string;
}): Promise<void> {
  const { sessionId, taskId, actionId, marker } = state;

  // (1) EXACTLY-ONCE MONEY.
  const transfers = await zhangweiTransfers();
  expect(transfers).toHaveLength(1);
  expect(transfers[0]!.amountMinor).toBe(-moneyToCents(TRANSFER_AMOUNT));
  expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, TRANSFER_AMOUNT));

  // (2) The human decision executed the ORIGINAL action exactly once — and nothing else ever did.
  const settled = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
  expect(settled.status).toBe('executed');
  expect(
    await getTestPrisma().pendingAction.count({ where: { sessionId, status: 'executed' } }),
  ).toBe(1);

  // (3) The already-`success` 🟢 node was NOT re-executed.
  expect(await countBudgets(marker)).toBe(1);

  // (4) EXACTLY ONE node row per declared node.
  const nodeRows = await nodeRowsOf(taskId);
  expect(nodeRows.map((node) => node.nodeId)).toEqual(['n1', 'n2']);

  // (5) No stale `'running'`, execution claim released, read model agrees with the durable row.
  const row = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
  expect(row.status, 'a settled plan must never be left stale `running`').not.toBe('running');
  expect(row.executionToken).toBeNull();
  await expectReadModelAgrees(taskId, sessionId, row.status);

  // (6) Whatever the gate count, the LEDGER stays exactly-once.
  const leftovers = await executableActions(sessionId);
  expect(leftovers.length).toBeLessThanOrEqual(1);
  if (leftovers.length === 0) {
    // No fresh gate survived: the interleaving decided the node BEFORE the control request walked it,
    // so the parked plan COMPLETED — every node succeeded and the durable row agrees.
    expect(nodeRows.map((node) => node.status)).toEqual(['success', 'success']);
    expect(row.status).toBe('success');
    return;
  }
  const leftover = leftovers[0]!;
  expect(leftover.taskId).toBe(taskId); // never work of ANOTHER plan
  expect(leftover.nodeId).toBe('n2'); // never a DIFFERENT node
  expect(leftover.toolName).toBe('transfer_money');
  // Executing that fresh gate REPLAYS the node's side effect — a second debit must NOT happen.
  const replayed = await confirmAction(leftover.id, sessionId);
  expect(replayed.status).toBe(200);
  expect(payload(replayed).status).toBe('executed');
  const ledger = await zhangweiTransfers();
  expect(ledger).toHaveLength(1); // still exactly ONE ledger row
  expect(ledger[0]!.id).toBe(transfers[0]!.id); // the SAME row — no second debit
  expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, TRANSFER_AMOUNT));
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] WINDOW A — a control request landing after the node side effect but before its result is persisted', () => {
  it('[integration] a concurrent {action:"resume"} while the node holds its side effect adds NO second Budget row and the plan settles consistently', async () => {
    const marker = '并发执行预算A';
    const sessionId = await newPersistedSessionId();
    const held = heldRunTool(sessionId, '先读余额，再预留并发预算', 'n2');
    const planRun = runSubmitPlan(
      DEMO_USER_ID,
      {
        goal: '先读余额，再预留并发预算',
        nodes: [balanceNode('n1'), budgetNode('n2', marker, '1200', ['n1'])],
      },
      { sessionId, runTool: held.runTool },
    );

    // WINDOW A: the held node's REAL work is done (the Budget row exists) and its result is NOT yet
    // persisted (its row is still `running`), so the plan row is `running`.
    await held.reached;
    const taskId = (await getTestPrisma().agentTask.findFirstOrThrow({ where: { sessionId } })).id;
    expect(await countBudgets(marker)).toBe(1);
    expect((await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
      'running',
    );
    expect((await nodeRowsOf(taskId)).map((node) => node.status)).toEqual(['success', 'running']);

    // THE SECOND DRIVE, through the REAL handler, INSIDE the window.
    const resumed = await taskControl(taskId, 'resume', sessionId);
    expect(resumed.status).toBe(200);

    // EXACTLY-ONCE: the second drive added NO second side effect and never advanced the held node.
    expect(await countBudgets(marker)).toBe(1);
    expect((await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
      'running',
    );
    expect((await nodeRowsOf(taskId)).map((node) => node.status)).toEqual(['success', 'running']);

    // Release the held node: the run records its result and settles.
    held.release();
    const done = await planRun;
    expect(done.ok).toBe(true);
    expect((done.data as TaskPlan).status).toBe('success');

    // EXACTLY-ONCE + CONSISTENT: one Budget row, one node row per node, settled status, agreeing read.
    expect(await countBudgets(marker)).toBe(1);
    const nodeRows = await nodeRowsOf(taskId);
    expect(nodeRows.map((node) => node.nodeId)).toEqual(['n1', 'n2']); // no duplicated node rows
    expect(nodeRows.map((node) => node.status)).toEqual(['success', 'success']);
    await expectReadModelAgrees(taskId, sessionId, 'success');
  });

  it('[integration] a concurrent {action:"retry"} while the node holds its side effect adds NO second Budget row and the plan settles consistently', async () => {
    const marker = '并发执行预算B';
    const sessionId = await newPersistedSessionId();
    const held = heldRunTool(sessionId, '先读余额，再预留并发预算', 'n2');
    const planRun = runSubmitPlan(
      DEMO_USER_ID,
      {
        goal: '先读余额，再预留并发预算',
        nodes: [balanceNode('n1'), budgetNode('n2', marker, '1200', ['n1'])],
      },
      { sessionId, runTool: held.runTool },
    );

    await held.reached;
    const taskId = (await getTestPrisma().agentTask.findFirstOrThrow({ where: { sessionId } })).id;
    expect(await countBudgets(marker)).toBe(1);
    expect((await nodeRowsOf(taskId)).map((node) => node.status)).toEqual(['success', 'running']);

    // retry's compare-and-set EXCLUDES `'running'` (the deliberate asymmetry with `resume`), so this
    // drive must be a no-op that returns the persisted snapshot WITHOUT a second side effect.
    const retried = await taskControl(taskId, 'retry', sessionId);
    expect(retried.status).toBe(200);
    expect(await countBudgets(marker)).toBe(1);
    expect((await nodeRowsOf(taskId)).map((node) => node.status)).toEqual(['success', 'running']);

    held.release();
    const done = await planRun;
    expect(done.ok).toBe(true);
    expect((done.data as TaskPlan).status).toBe('success');

    expect(await countBudgets(marker)).toBe(1);
    const nodeRows = await nodeRowsOf(taskId);
    expect(nodeRows.map((node) => node.nodeId)).toEqual(['n1', 'n2']);
    expect(nodeRows.map((node) => node.status)).toEqual(['success', 'success']);
    await expectReadModelAgrees(taskId, sessionId, 'success');
  });
});

describe('[integration] WINDOW B — the confirm-continuation racing a concurrent task-control request on the SAME parked plan', () => {
  /** Seed the shared Window B plan: 🟢 `reserve_budget` (done) → YELLOW `transfer_money` (PARKED). */
  async function seedParkedTransferPlan(marker: string) {
    const seeded = await seedPlan('先预留预算，再给张伟转200元', [
      budgetNode('n1', marker, '600'),
      transferNode('n2', TRANSFER_AMOUNT, ['n1']),
    ]);
    // Preconditions: n1 already executed (ONE Budget row); n2 is PARKED on a real plan-linked action.
    expect(nodeStatusOf(seeded.plan, 'n1')).toBe('success');
    expect(nodeStatusOf(seeded.plan, 'n2')).toBe('waiting_confirmation');
    expect(await countBudgets(marker)).toBe(1);

    const actionId = readPendingActionId(resultOf(seeded.plan, 'n2').output);
    expect(typeof actionId).toBe('string');
    const beforeActions = await getTestPrisma().pendingAction.findMany({
      where: { sessionId: seeded.sessionId },
    });
    expect(beforeActions).toHaveLength(1);
    expect(beforeActions[0]!.id).toBe(actionId);
    return { ...seeded, actionId: actionId! };
  }

  it('[integration] a confirm racing a concurrent {action:"resume"} moves the money once, gates no other work and settles consistently', async () => {
    const marker = '并发确认预算';
    const { sessionId, taskId, actionId } = await seedParkedTransferPlan(marker);

    // --- The CONTROLLED BARRIER: the confirm and the control request must overlap.
    const barrier = makeBarrier(2);
    const [confirmed, resumed] = await Promise.all([
      confirmAction(actionId, sessionId, gatedHandler(confirmPost, barrier)),
      taskControl(taskId, 'resume', sessionId, gatedHandler(taskPost, barrier)),
    ]);
    expect(barrier.arrived()).toBe(2); // BOTH requests really were in flight…
    expect(barrier.timedOut()).toBe(false); // …and neither slipped through on the fallback
    expect(confirmed.status).toBe(200);
    expect(resumed.status).toBe(200);

    // The confirm reported the honest terminal outcome of the ORIGINAL validated args.
    const confirmData = payload(confirmed);
    expect(confirmData.ok).toBe(true);
    expect(confirmData.status).toBe('executed');
    expect(confirmData.actionId).toBe(actionId);

    await expectExactlyOnceLedgerAndConsistentState({ sessionId, taskId, actionId, marker });
  });

  it('[integration] a confirm racing a concurrent {action:"retry"} moves the money once, gates no other work and settles consistently', async () => {
    const marker = '并发确认重试预算';
    const { sessionId, taskId, actionId } = await seedParkedTransferPlan(marker);

    const barrier = makeBarrier(2);
    const [confirmed, retried] = await Promise.all([
      confirmAction(actionId, sessionId, gatedHandler(confirmPost, barrier)),
      taskControl(taskId, 'retry', sessionId, gatedHandler(taskPost, barrier)),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(barrier.timedOut()).toBe(false);
    expect(confirmed.status).toBe(200);
    expect(retried.status).toBe(200);
    expect(payload(confirmed).status).toBe('executed');

    await expectExactlyOnceLedgerAndConsistentState({ sessionId, taskId, actionId, marker });
  });
});

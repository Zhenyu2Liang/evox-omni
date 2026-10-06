/**
 * tests/app/confirm-continuation-fencing.test.ts — REAL-application-entry (HTTP) proof of the
 * CONFIRM-CONTINUATION FENCING contract owned by `agent/task-control.ts#resumeTaskForAction`.
 *
 * THE CONTRACT UNDER TEST (the LOST-claim branch). The confirm/verify continuation first tries to
 * take the plan's single DB execution claim (`claimTaskExecution`, the same stale-horizon CAS
 * `resumeTask`/`retryTask` use). When it WINS it is a real executor pass and drives the plan. When it
 * LOSES, a LIVE executor owns the plan right now, so the continuation must
 *
 *   (a) NOT overwrite the live owner's `AgentTask` row (it holds no claim — every write it makes is
 *       FENCED on the owner's token, and a fenced write landing on someone else's row is impossible),
 *   (b) NOT advance the plan (two overlapping walks could LAUNCH a node twice, so it must not call
 *       `resumePlan`/`runPlan` at all — no downstream side effect), and
 *   (c) STILL record the HUMAN-decided node through ONE atomic FENCED write
 *       (`agent/task-fencing.ts#recordDecidedNodeFenced`, fenced on the live owner's PLAN token), so
 *       the decision is never dropped and the plan as a whole can still complete.
 *
 * The whole production stack runs (`route → @/agent → banking tools → security gateway
 * beforeToolCall → Banking SDK → SQLite`); ONLY the model is scripted (`tests/setup.ts` forces
 * `LLM_MODE=mock`) — offline, no network, no fake timers, no wall-clock races.
 *
 * DETERMINISM — how a "LIVE owner" is simulated without timing. The stale horizon is
 * `staleExecutionClaimBefore()` = `Date.now() - EXECUTION_CLAIM_TTL_MS` (10 minutes). Stamping the
 * plan row with a FRESH `executionClaimedAt` therefore makes the continuation's
 * `claimTaskExecution(..., { staleBefore })` match 0 rows — a claim loss that is DETERMINISTIC (the
 * row is neither unclaimed nor stale), not a race. Nothing depends on scheduling: the assertion is
 * that the continuation behaves correctly while another executor holds the plan.
 *
 * Plans are SEEDED through the production APIs (`getOrCreateSession` + `runSubmitPlan`) so real
 * `AgentTask`/`AgentTaskNode`/`PendingAction` rows exist and every control path's ownership check
 * (`taskLoadOwned`: `task.sessionId` + a matching `AgentSession`) is satisfied. Each test gets a
 * fresh DB (`resetDatabase`) and a UNIQUE persisted session id (the in-process circuit breaker is
 * keyed by `sessionId`).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { executeGatedTool, getOrCreateSession, readPendingActionId } from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
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
const SEEDED_BALANCE = CHECKING.balance;
/** Recipient 张伟 — the parked transfer's payee (the money-moved-at-most-once probe). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The parked transfer amount (≤ ¥1000 ⇒ YELLOW / confirmation-only). */
const TRANSFER_AMOUNT = 200;
/** The pre-existing 🟢 node's countable side effect marker (ONE `Budget` row per real execution). */
const MARKER_UPSTREAM = '确认续行预算A';
/** The DOWNSTREAM 🟢 node's marker — proving the LOST continuation never advanced the plan. */
const MARKER_DOWNSTREAM = '确认续行预算B';
/** The token stamped on the plan row to impersonate the LIVE owner of the plan. */
const LIVE_OWNER_TOKEN = 'live-owner-token';

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

/** The recorded node status in a plan snapshot (`undefined` when the node is absent). */
function nodeStatusOf(plan: TaskPlan, nodeId: string): TaskNodeStatus | undefined {
  return plan.results.find((result) => result.id === nodeId)?.status;
}

/** Decode a persisted JSON-text column; a NULL value is a hard failure (never silently swallowed). */
function decodeJson(raw: string | null): unknown {
  expect(raw, 'the persisted node output must be present').not.toBeNull();
  return JSON.parse(raw!) as unknown;
}

/** Deep-search a JSON-ish value for a numeric literal (tolerant of the SDK's result nesting). */
function containsNumber(value: unknown, target: number): boolean {
  if (typeof value === 'number') return value === target;
  if (Array.isArray(value)) return value.some((item) => containsNumber(item, target));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsNumber(item, target),
    );
  }
  return false;
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

/** A 🟢 GREEN node used as the COUNTABLE execution probe (one `Budget` row per real execution). */
function budgetNode(id: string, budgetName: string, amount: number, deps: string[] = []): SeedNode {
  return {
    id,
    name: '预留预算',
    dependencies: deps,
    kind: 'tool',
    tool: 'reserve_budget',
    args: { name: budgetName, amount },
  };
}

/** The YELLOW `transfer_money` node (gated → PARKS for a human decision instead of executing). */
function transferNode(id: string, amount: number, deps: string[] = []): SeedNode {
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

/** The durable row of ONE node (a missing node row is a bug). */
async function nodeRowOf(taskId: string, nodeId: string) {
  const row = await nodeRowsOf(taskId).then((rows) => rows.find((node) => node.nodeId === nodeId));
  expect(row, `AgentTaskNode ${taskId}/${nodeId} must exist`).not.toBeNull();
  return row!;
}

/** Every ledger row paid to 张伟 (the money-moved-at-most-once probe). */
function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/** Current 活期 balance (¥23,580 seeded). */
async function checkingBalance(): Promise<number> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return account.balance;
}

/** The durable `AgentTask` row (its claim columns ARE the ownership state under test). */
function taskRowOf(taskId: string) {
  return getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
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
function readTask(taskId: string, sessionId: string): Promise<HttpResult<Envelope<TaskPlan>>> {
  return getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), { ctx: idCtx(taskId), sessionId });
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] the confirm-continuation LOSING the plan execution claim to a LIVE owner', () => {
  it('[integration] records the decided node via a FENCED write without overwriting the live owner or advancing the plan, and the plan still completes once the owner releases', async () => {
    const sessionId = await newPersistedSessionId();

    // --- SEED a parked plan through the production `submit_plan` runner.
    //     n1 🟢 reserve_budget (runs → success) → n2 🟡 transfer_money (PARKS) → n3 🟢 reserve_budget.
    const seeded = await runSubmitPlan(
      DEMO_USER_ID,
      {
        goal: '先预留一笔预算，再给张伟转200元，最后再预留一笔预算',
        nodes: [
          budgetNode('n1', MARKER_UPSTREAM, 600),
          transferNode('n2', TRANSFER_AMOUNT, ['n1']),
          budgetNode('n3', MARKER_DOWNSTREAM, 700, ['n2']),
        ],
      },
      { sessionId, runTool: gatewayRunTool(sessionId, '先预留一笔预算，再给张伟转200元，最后再预留一笔预算') },
    );
    const plan = seeded.data as TaskPlan | undefined;
    expect(plan, `runSubmitPlan produced no plan: ${seeded.error}`).toBeDefined();
    const taskId = plan!.id;

    // Seed preconditions: upstream executed, the gated node PARKED, the downstream node still pending.
    expect(nodeStatusOf(plan!, 'n1')).toBe('success');
    expect(nodeStatusOf(plan!, 'n2')).toBe('waiting_confirmation');
    expect(nodeStatusOf(plan!, 'n3')).toBe('pending');
    expect(await countBudgets(MARKER_UPSTREAM)).toBe(1);
    expect(await countBudgets(MARKER_DOWNSTREAM)).toBe(0);

    const parkedNode = plan!.results.find((result) => result.id === 'n2')!;
    const actionId = readPendingActionId(parkedNode.output);
    expect(typeof actionId, 'the parked node must expose its PendingAction id').toBe('string');

    // --- SIMULATE A LIVE OWNER: the plan carries a FRESH claim, so the continuation's
    //     `claimTaskExecution(..., { staleBefore: now() - 10min })` can match neither the
    //     unclaimed branch nor the stale branch ⇒ a DETERMINISTIC claim LOSS (never a race).
    const claimedAt = new Date();
    await getTestPrisma().agentTask.update({
      where: { id: taskId },
      data: {
        status: 'running',
        executionToken: LIVE_OWNER_TOKEN,
        executionClaimedAt: claimedAt,
      },
    });

    // --- THE REAL CONFIRM, through the REAL route handler (cookie identity).
    const confirmed = await confirmAction(actionId!, sessionId);
    expect(confirmed.status).toBe(200);
    const confirmData = payload(confirmed);
    expect(confirmData.ok).toBe(true);
    expect(confirmData.status).toBe('executed');
    expect(confirmData.actionId).toBe(actionId);

    // --- (a) THE LIVE OWNER'S PLAN ROW IS UNTOUCHED: no claim was taken/rewritten, no settle.
    const ownerRow = await taskRowOf(taskId);
    expect(ownerRow.executionToken, 'a claim-less continuation must not touch the owner’s token').toBe(
      LIVE_OWNER_TOKEN,
    );
    expect(ownerRow.executionClaimedAt?.getTime()).toBe(claimedAt.getTime());
    expect(ownerRow.status, 'a claim-less continuation must not settle the owner’s status').toBe(
      'running',
    );

    // --- (b) NO ADVANCE: the downstream 🟢 node never ran and its row is still `pending`.
    expect(nodeStatusOf(await loadPlanSnapshot(taskId, sessionId), 'n3')).toBe('pending');
    expect((await nodeRowOf(taskId, 'n3')).status).toBe('pending');
    expect(await countBudgets(MARKER_DOWNSTREAM)).toBe(0);

    // --- (c) THE DECIDED NODE IS RECORDED through the owner-token-FENCED write.
    const decided = await nodeRowOf(taskId, 'n2');
    expect(decided.status, 'the human decision must never be dropped').toBe('success');
    expect(decided.error).toBeNull();
    const decidedOutput = decodeJson(decided.output);
    expect(
      JSON.stringify(decidedOutput),
      'the decided node output must carry the REAL transfer result (its recipient)',
    ).toContain(ZHANGWEI.name);
    expect(
      containsNumber(decidedOutput, TRANSFER_AMOUNT),
      'the decided node output must carry the transferred amount',
    ).toBe(true);

    // --- MONEY MOVED EXACTLY ONCE (the human decision, not model text).
    const transfers = await zhangweiTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.amount).toBe(-TRANSFER_AMOUNT);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);
    const settledAction = await getTestPrisma().pendingAction.findUniqueOrThrow({
      where: { id: actionId! },
    });
    expect(settledAction.status).toBe('executed');

    // --- COMPLETES CORRECTLY: release the simulated owner, then the plan resumes and finishes.
    //     `'running'` is in `RESUMABLE_PLAN_STATUSES` (`agent/task-control.ts`), so no status
    //     adjustment is needed — only the dead owner's claim has to go.
    await getTestPrisma().agentTask.update({
      where: { id: taskId },
      data: { executionToken: null, executionClaimedAt: null },
    });

    const resumed = await taskControl(taskId, 'resume', sessionId);
    expect(resumed.status).toBe(200);
    const resumedPlan = payload(resumed);
    expect(resumedPlan.status).toBe('success');
    expect(nodeStatusOf(resumedPlan, 'n1')).toBe('success');
    expect(nodeStatusOf(resumedPlan, 'n2')).toBe('success'); // terminal ⇒ SKIPPED, never re-run
    expect(nodeStatusOf(resumedPlan, 'n3')).toBe('success');
    expect(await countBudgets(MARKER_DOWNSTREAM)).toBe(1);

    // The re-run must NOT have double-debited: n2 was already terminal `success`, so the resume
    // skipped it and the ledger still holds the SINGLE original row.
    const ledgerAfterResume = await zhangweiTransfers();
    expect(ledgerAfterResume).toHaveLength(1);
    expect(ledgerAfterResume[0]!.id).toBe(transfers[0]!.id);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);

    // The durable read model agrees with the durable rows.
    const readBack = await readTask(taskId, sessionId);
    expect(readBack.status).toBe(200);
    expect(payload(readBack).status).toBe('success');
  });
});

/** Read the plan as the durable read model exposes it (the `GET /api/tasks/[id]` payload). */
async function loadPlanSnapshot(taskId: string, sessionId: string): Promise<TaskPlan> {
  const readBack = await readTask(taskId, sessionId);
  expect(readBack.status).toBe(200);
  return payload(readBack);
}

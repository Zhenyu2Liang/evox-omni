/**
 * tests/app/cancel-safety-http.test.ts — REAL-application-entry (HTTP) e2e for PLAN-CANCEL SAFETY
 * WINDOWS: the moments during a gated DAG node's park at which a plan-level cancel must still be
 * able to prevent any money from moving.
 *
 * THE INVARIANT THIS PROVES: whichever interleaving a plan cancel lands in, no `PendingAction` that
 * outlives the cancellation may ever be executed, and no ledger/daily-total movement may occur. The
 * decision is made ENTIRELY in code (the gateway's exactly-once CAS claim + the plan-level action
 * revocation in `agent/task-control.ts#cancelTask`), never by the model.
 *
 * -------------------------------------------------------------------------------------------
 * WINDOW (a) — "the PendingAction is created but its node result is NOT yet persisted"
 * -------------------------------------------------------------------------------------------
 * The executor persists a parked node's `{ pendingActionId }` link ONLY after `runTool` returns
 * (`planner/executor.ts#runToolNode` → `setNode(parked)`); the gateway, however, persists the
 * `PendingAction.taskId`/`nodeId` link AT CREATION (`security/security-gateway.ts
 * #gatewayCreatePendingAction`). So there is a real window in which the action exists but NO node
 * output points at it. `cancelTask` closes that window with ONE atomic
 * `revokePendingActionsByTask(taskId, ['pending','awaiting_mfa'])` (keyed by `taskId`, not by the
 * node-output scan), so the action is revoked regardless.
 *
 * THE BARRIER TECHNIQUE (this is the point of the spec):
 *   The real plan runner (`runSubmitPlan`) executes each node through an injected `runTool` port.
 *   This spec wraps that port (`parkingBarrier(sessionId).runTool`) so it:
 *     1. routes the node through the REAL gate (`executeGatedTool` from `@/agent`), forwarding
 *        `ctx.taskId`/`ctx.nodeId` so the gateway persists the action's plan link AT CREATION —
 *        which PERSISTS the `PendingAction` on the blocked path (the park), then
 *     2. resolves `park` (handing the parked `{ actionId, taskId }` back to the test) and
 *     3. AWAITS a deferred `gate` promise — the barrier — holding the whole plan run open.
 *   While the run is held at the barrier the node row is still `running` and its `output` does NOT
 *   yet reference the action — EXACTLY window (a). The test then issues a REAL
 *   `POST /api/tasks/[id]` `{action:'cancel'}` so the human cancellation genuinely interleaves with
 *   the in-flight park instead of running after it. `release()` then lets the held node settle.
 *
 * Only the MODEL is scripted (`tests/setup.ts` forces `LLM_MODE=mock`); the route handlers, the
 * gateway chokepoint, the Banking SDK and SQLite are all real. Offline, no API key, no network.
 *
 * IDENTITY IS COOKIE-ONLY: the session is minted via `getOrCreateSession(userId)` and carried to the
 * real task/action routes as the `banking_session` cookie (the harness `sessionId` option); a
 * `?sessionId=` query param is IGNORED. Deterministic DB lifecycle (reset + seed per test) and NO
 * fake timers.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { executeGatedTool, getOrCreateSession, readPendingActionId } from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import { safeParse } from '@/lib/json';
import { security } from '@/security';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, idCtx, postJson, taskUrl, type HttpResult, type RouteHandler } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (¥23,580) — the account the parked transfer would draw from. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance (¥23,580). */
const SEEDED_BALANCE = CHECKING.balance;
/** Recipient 张伟 — the parked transfer's payee (the money-moved-at-most-once probe). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;

/** The parked transfer amount (≤ ¥1000 ⇒ confirmation-only / YELLOW at PARK time). */
const TRANSFER_AMOUNT = 200;
/** The natural-language request the parked transfer is attributed to (audit + gate context). */
const TRANSFER_REQUEST = `给张伟转${TRANSFER_AMOUNT}元`;
/** The single plan node's id (the node whose `output` link is the object of window (a)). */
const NODE_ID = 'n1';

/** The single-node DAG whose only node is a gated `transfer_money` call. */
const transferNode = {
  id: NODE_ID,
  name: `转${TRANSFER_AMOUNT}给张伟`,
  kind: 'tool',
  tool: 'transfer_money',
  args: { name: '张伟', amount: TRANSFER_AMOUNT },
  dependencies: [],
};

/**
 * The `PendingAction` statuses an action could still be EXECUTED from. A settled action
 * (`executed` / `failed` / `cancelled`) is NOT here — the "no executable action survives the
 * cancellation" probe.
 */
const EXECUTABLE_STATUSES: PendingActionStatus[] = ['pending', 'awaiting_mfa'];

/**
 * The route's JSON envelope — the transport shape (NOT a frozen `@/lib/contracts` type). Declared
 * structurally only so specs can narrow `ok`/`data`/`error` without importing app-private modules.
 */
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/* -------------------------------------------------------------------------- envelope helpers */

/** Success protocol helper: assert the transport envelope and return its payload. */
function payload<T>(res: HttpResult<Envelope<T>>): T {
  expect(res.data?.ok, `expected success envelope, got ${JSON.stringify(res.data)}`).toBe(true);
  return res.data!.data as T;
}

/* -------------------------------------------------------------------------------- invokers */

/**
 * Invoke the REAL plan-level control handler (`POST /api/tasks/[id]`) with `{action:'cancel'}`.
 * The dynamic-route `ctx` MUST be passed explicitly (the harness defaults to `idCtx('')`) and
 * `sessionId` travels as the `banking_session` COOKIE — identity is cookie-only.
 */
function cancelPlanHttp(taskId: string, sessionId: string): Promise<HttpResult<Envelope<TaskPlan>>> {
  return postJson<Envelope<TaskPlan>>(taskPost, taskUrl(taskId), { action: 'cancel' }, {
    ctx: idCtx(taskId),
    sessionId,
  });
}

/** Invoke the REAL confirm handler (`POST /api/actions/[id]/confirm`) for the parked action. */
function confirmHttp(id: string, sessionId: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(confirmPost, actionUrl(id, 'confirm'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

/* ------------------------------------------------------------------------- the barrier seam */

/** The `{ actionId, taskId }` a barrier hands back once the gate has persisted the action. */
interface ParkRef {
  /** The persisted `PendingAction` id (`undefined` when the gate did not park). */
  actionId?: string;
  /** The owning durable `AgentTask` id (the plan id the node belongs to). */
  taskId: string;
}

/** The controlled barrier exposed to a spec (see the module doc). */
interface ParkingBarrier {
  /** Resolves ONCE the gate has persisted the action (and the run is held). */
  park: Promise<ParkRef>;
  /** Releases the held `runTool` so the plan's node settles. */
  release: () => void;
  /** The gateway-routed per-node runner to hand to `runSubmitPlan`. */
  runTool: PlanRunTool;
}

/**
 * Build the barrier-wrapped, gateway-routed `runTool` for `sessionId`.
 *
 * Each node call is routed through the REAL gate (`executeGatedTool`) — forwarding `ctx.taskId`/
 * `ctx.nodeId` so the gateway persists the action's plan link AT CREATION — which PERSISTS the
 * `PendingAction` on the blocked (parked) path; the runner then signals `park` with the action id +
 * owning task id and AWAITS a deferred `gate` promise, holding the whole plan run open until
 * `release()`.
 */
function parkingBarrier(sessionId: string): ParkingBarrier {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalParked!: (ref: ParkRef) => void;
  const park = new Promise<ParkRef>((resolve) => {
    signalParked = resolve;
  });

  const runTool: PlanRunTool = async (toolName, args, ctx) => {
    // Route through the REAL security chokepoint: a gated call is BLOCKED and its PendingAction
    // persisted here (never executed) — WITH its plan link, because ctx.taskId/nodeId are forwarded.
    const outcome = await executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName,
      args,
      userRequest: TRANSFER_REQUEST,
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });
    // The owning durable task row already exists (minted by `runSubmitPlan` BEFORE any node runs).
    const task = await getTestPrisma().agentTask.findFirst({ where: { sessionId } });
    signalParked({ actionId: outcome.pendingActionId, taskId: task?.id ?? '' });
    // THE BARRIER: hold the in-flight park here so the spec's HTTP cancel can interleave.
    await gate;
    return outcome;
  };

  return { park, release, runTool };
}

/* ----------------------------------------------------------------------------- DB helpers */

/** Current 活期 balance (¥23,580 seeded). */
async function checkingBalance(): Promise<number> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return account.balance;
}

/** Every ledger row paid to 张伟 (the money-moved-at-most-once probe). */
function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ----------------------------------------------------------------------------------- tests */

describe('[integration] plan cancel safety — WINDOW (a): the parked action exists but its node result is NOT yet persisted', () => {
  it('[integration] a plan cancel landing in that window revokes the never-node-linked action, fails a follow-up confirm closed, and moves NO money', async () => {
    const sessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;

    // Start the real plan run (NOT awaited): its only node routes through the barrier.
    const barrier = parkingBarrier(sessionId);
    const planRun = runSubmitPlan(
      DEMO_USER_ID,
      { goal: TRANSFER_REQUEST, nodes: [transferNode] },
      { sessionId, runTool: barrier.runTool },
    );

    // (1) The gate has persisted the ¥200 transfer's PendingAction and is now HELD at the barrier.
    const park = await barrier.park;
    expect(park.actionId, 'the gated ¥200 transfer must PARK (persist a PendingAction)').toBeDefined();
    const actionId = park.actionId as string;
    expect(park.taskId, 'the owning AgentTask row must exist before the node settles').not.toBe('');
    const taskId = park.taskId;

    const parkedRow = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(parkedRow.toolName).toBe('transfer_money');
    expect(parkedRow.status).toBe('pending');
    expect(parkedRow.riskLevel).toBe('YELLOW');
    // The plan link is persisted AT CREATION — which is exactly why the revocation below works.
    expect(parkedRow.taskId).toBe(taskId);
    expect(parkedRow.nodeId).toBe(NODE_ID);

    // (2) THE WINDOW: the node row is `running` and its `output` does NOT yet reference the action —
    // the executor persists `{ pendingActionId }` only AFTER `runTool` returns, and it is held here.
    const nodeRow = await getTestPrisma().agentTaskNode.findFirst({
      where: { taskId, nodeId: NODE_ID },
    });
    expect(nodeRow, `expected a node row for (${taskId}, ${NODE_ID})`).not.toBeNull();
    expect(nodeRow!.status).toBe('running');
    expect(
      readPendingActionId(safeParse(nodeRow!.output, undefined)),
      'the node result must NOT yet reference the parked action (this is window (a))',
    ).toBeUndefined();

    // (3) WHILE HELD, the PLAN-level cancel lands through the REAL handler.
    const cancelled = await cancelPlanHttp(taskId, sessionId);
    expect(cancelled.status).toBe(200);
    const cancelledPlan = payload(cancelled);
    expect(cancelledPlan.id).toBe(taskId);
    expect(cancelledPlan.status).toBe('cancelled');
    const durable = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(durable.status).toBe('cancelled');

    // (4) The parked action is REVOKED even though NO node output ever linked it — the revocation is
    // keyed by the action's persisted `taskId`, not by the node-output scan.
    const revoked = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(revoked.status).toBe('cancelled');
    const stillExecutable = await getTestPrisma().pendingAction.findMany({
      where: { taskId, status: { in: EXECUTABLE_STATUSES } },
    });
    expect(stillExecutable, 'no executable PendingAction may survive the plan cancellation').toHaveLength(0);

    // (5) Release the barrier: the held node settles as a park, but the plan stays CANCELLED durably
    // (a cancelled plan is terminal and is never resurrected by the settling run).
    barrier.release();
    const plan = await planRun;
    expect(plan.ok).toBe(true);
    const durableAfter = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(
      durableAfter.status,
      'a cancelled plan must never be resurrected by the settling run',
    ).toBe('cancelled');
    // (6) A follow-up confirm of the old action MUST be REFUSED — never `ok:true`/`'executed'`.
    const confirmed = await confirmHttp(actionId, sessionId);
    const refusedAsError =
      confirmed.status === 409 && confirmed.data?.ok === false && confirmed.data?.error?.code === 'CONFLICT';
    const refusedAsDomain =
      confirmed.status === 200 && confirmed.data?.ok === true && confirmed.data?.data?.ok === false;
    expect(
      refusedAsError || refusedAsDomain,
      `a confirm of a cancelled plan's action must be refused, got ${confirmed.status} ${JSON.stringify(confirmed.data)}`,
    ).toBe(true);
    if (refusedAsDomain) {
      expect(confirmed.data!.data!.status).toBe('cancelled');
    }

    // (7) STRICT no-movement: no 张伟 debit, the balance is untouched and the day total is still ¥0.
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* WINDOW (b) — "cancel vs confirm concurrency on the SAME parked action"                        */
/* ------------------------------------------------------------------------------------------- */
/**
 * WINDOW (a) above races a PLAN-level cancel against the park itself. This window races the two
 * HUMAN decisions on the SAME already-parked action: a real `POST /api/actions/[id]/cancel` and a
 * real `POST /api/actions/[id]/confirm`, both aimed at ONE `PendingAction`.
 *
 * The gateway's exactly-once CAS claim makes this a zero-or-one question:
 *   - the action settles in EXACTLY ONE terminal status (`executed` XOR `cancelled`);
 *   - the ¥200 may move EXACTLY ZERO or ONE time — never twice, never partially;
 *   - EXACTLY ONE `AuditLog` row is written, for the ONE decision that actually took effect, and it
 *     is CONSISTENT with that decision (`success`/`confirmed:true` vs `cancelled`/`confirmed:false`);
 *   - the loser is REFUSED (a `409 CONFLICT` error envelope OR a `200` domain `ok:false`) — never a
 *     second success;
 *   - a confirm that WON is never rolled back by a later cancel: the ledger row and the balance
 *     decrement are truthful history.
 *
 * OVERLAP IS FORCED, NOT HOPED FOR: `makeBarrier(2)` is a controlled rendezvous placed at the ROUTE
 * BOUNDARY (`gated(handler, barrier)`), so neither decision may enter the logic until BOTH have
 * arrived — the compare-and-set is genuinely exercised instead of one request finishing before the
 * other starts. The barrier is bounded (a lone caller is released after a timeout) so a regression
 * can never HANG the suite, and the fallback is asserted ABSENT (`timedOut() === false`) so a broken
 * overlap fails LOUDLY instead of silently degrading into a sequential run.
 *
 * Offline & deterministic (mock model, isolated test SQLite, no fake timers); a UNIQUE persisted
 * session per test isolates the in-process circuit breaker.
 */

/** How long a rendezvous waits for its missing arrival before falling back (guards against a HANG). */
const BARRIER_TIMEOUT_MS = 3000;

/**
 * A CONTROLLED request rendezvous: `expected` callers must arrive before EITHER proceeds past
 * `wait()`. The bounded timeout releases a lone caller (so a regression can never hang the suite)
 * and the fallback is OBSERVABLE through `timedOut()` — every spec asserts it stayed `false`.
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

/** Wrap a REAL route handler so it only enters the decision logic once the rendezvous has released. */
function gated(handler: RouteHandler, barrier: { wait: () => Promise<void> }): RouteHandler {
  return async (req, ctx) => {
    await barrier.wait();
    return handler(req, ctx);
  };
}

/* --------------------------------------------------------------------- WINDOW (b) park seeding */

/** The settled park this window races on: its owning session, its owning task and the action id. */
interface ParkedAction {
  sessionId: string;
  taskId: string;
  actionId: string;
}

/**
 * The gateway-authorized per-node runner used to SEED a settled park.
 *
 * A gated node is BLOCKED by the REAL gate (`executeGatedTool`) and its `PendingAction` persisted —
 * with its plan link, because `ctx.taskId`/`ctx.nodeId` are forwarded — instead of executing.
 */
function gatewayRunTool(sessionId: string, userRequest: string): PlanRunTool {
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

/**
 * Seed a FULLY-SETTLED park through the PRODUCTION planner: `runSubmitPlan` mints the durable
 * `AgentTask`/`AgentTaskNode` rows and the gated ¥200 `transfer_money` node PARKS (one real
 * `PendingAction`, `status:'pending'`, owned by a fresh session). No barrier here — the run finishes,
 * so the race below starts from a settled, fully-linked park.
 */
async function seedParkedAction(): Promise<ParkedAction> {
  const sessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    { goal: TRANSFER_REQUEST, nodes: [transferNode] },
    { sessionId, runTool: gatewayRunTool(sessionId, TRANSFER_REQUEST) },
  );
  const plan = result.data as TaskPlan | undefined;
  expect(plan, `runSubmitPlan produced no plan: ${result.error}`).toBeDefined();
  const nodeRow = await getTestPrisma().agentTaskNode.findFirstOrThrow({
    where: { taskId: plan!.id, nodeId: NODE_ID },
  });
  const actionId = readPendingActionId(safeParse(nodeRow.output, undefined));
  expect(actionId, 'the gated ¥200 transfer must PARK (persist a PendingAction)').toBeDefined();
  return { sessionId, taskId: plan!.id, actionId: actionId as string };
}

/* ---------------------------------------------------------------- WINDOW (b) response readers */

/** Invoke the REAL cancel handler (`POST /api/actions/[id]/cancel`) for the parked action. */
function cancelActionHttp(
  id: string,
  sessionId: string,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(cancelPost, actionUrl(id, 'cancel'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

/** Did this decision actually TAKE EFFECT? (`200` + domain `ok:true` + a terminal status.) */
function isSettled(res: HttpResult<Envelope<ActionResponse>>): boolean {
  return (
    res.status === 200 &&
    res.data?.ok === true &&
    res.data.data?.ok === true &&
    (res.data.data.status === 'executed' || res.data.data.status === 'cancelled')
  );
}

/**
 * Was this decision REFUSED? Accepts BOTH refusal transports: a `409 CONFLICT` error envelope (the
 * losing CAS propagated as an `AppError`) and a `200` success envelope carrying a domain `ok:false`
 * (the conflict surfaced as an outcome). A refusal is NEVER a second success.
 */
function isRefused(res: HttpResult<Envelope<ActionResponse>>): boolean {
  const errorEnvelope = res.status === 409 && res.data?.ok === false;
  const domainRefusal = res.status === 200 && res.data?.ok === true && res.data.data?.ok === false;
  return errorEnvelope || domainRefusal;
}

/* ------------------------------------------------------------ WINDOW (b) cancel vs confirm races */

describe('[integration] cancel vs confirm concurrency on the SAME parked action — WINDOW (b)', () => {
  it('[integration] a cancel and a confirm racing on one parked action settle it EXACTLY ONCE — one terminal status, at most one ¥200 debit, one consistent audit row', async () => {
    const { sessionId, taskId, actionId } = await seedParkedAction();

    // Preconditions: the park is fully settled — linked by BOTH the node output and the action row.
    const parked = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(parked.status).toBe('pending');
    expect(parked.taskId).toBe(taskId);
    expect(parked.nodeId).toBe(NODE_ID);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(0);

    // --- The CONTROLLED BARRIER: BOTH decisions must be in flight before either proceeds.
    const barrier = makeBarrier(2);
    const [cancelRes, confirmRes] = await Promise.all([
      postJson<Envelope<ActionResponse>>(
        gated(cancelPost, barrier),
        actionUrl(actionId, 'cancel'),
        {},
        { ctx: idCtx(actionId), sessionId },
      ),
      postJson<Envelope<ActionResponse>>(
        gated(confirmPost, barrier),
        actionUrl(actionId, 'confirm'),
        {},
        { ctx: idCtx(actionId), sessionId },
      ),
    ]);

    // The rendezvous really happened — a fallback timeout would flag a broken overlap.
    expect(barrier.arrived(), 'both decisions must genuinely be in flight').toBe(2);
    expect(barrier.timedOut(), 'the rendezvous must not have fallen back to a timeout').toBe(false);

    // --- EXACTLY-ONE: one decision took effect, the other was REFUSED (never two successes).
    const settled = [cancelRes, confirmRes].filter(isSettled);
    const refused = [cancelRes, confirmRes].filter(isRefused);
    expect(
      settled,
      `exactly ONE concurrent decision may take effect, got cancel=${cancelRes.status} ${JSON.stringify(
        cancelRes.data,
      )} confirm=${confirmRes.status} ${JSON.stringify(confirmRes.data)}`,
    ).toHaveLength(1);
    expect(refused, 'the race loser must be REFUSED, never a second success').toHaveLength(1);

    // --- The action settles in EXACTLY ONE of the two terminal statuses, matching the winner.
    const finalRow = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(['executed', 'cancelled']).toContain(finalRow.status);
    const executed = finalRow.status === 'executed';
    expect(settled[0]!.data!.data!.status).toBe(finalRow.status);

    // --- ZERO or ONE ¥200 debit to 张伟 — never two — with the balance consistent.
    const transfers = await zhangweiTransfers();
    if (executed) {
      expect(transfers, 'the winning confirm must debit 张伟 EXACTLY once').toHaveLength(1);
      expect(transfers[0]!.amount).toBe(-TRANSFER_AMOUNT);
      expect(transfers[0]!.direction).toBe('DEBIT');
      expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);
    } else {
      expect(transfers, 'a winning cancel must move NO money').toHaveLength(0);
      expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    }

    // --- The day total agrees with the winner (¥0 cancelled / ¥200 executed).
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(
      executed ? TRANSFER_AMOUNT : 0,
    );

    // --- EXACTLY ONE audit row — the ONE decision that took effect (the loser audits nothing).
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits, 'exactly one decision took effect ⇒ exactly one audit row').toHaveLength(1);
    expect(audits[0]!.toolName).toBe('transfer_money');
    expect(audits[0]!.confirmed).toBe(executed);
    expect(audits[0]!.status).toBe(executed ? 'success' : 'cancelled');
  });

  it('[integration] cancel-then-confirm: the cancel wins and the late confirm is REFUSED, moving NO money', async () => {
    const { sessionId, actionId } = await seedParkedAction();

    // (1) The cancel lands FIRST and wins the exactly-once claim.
    const cancelled = await cancelActionHttp(actionId, sessionId);
    const cancelledBody = payload(cancelled);
    expect(cancelledBody.status).toBe('cancelled');
    expect(cancelledBody.ok).toBe(true);
    expect(isSettled(cancelled)).toBe(true);

    // (2) The late confirm is REFUSED — a `409 CONFLICT` or a domain `ok:false`, never a success.
    const confirmed = await confirmHttp(actionId, sessionId);
    expect(
      isRefused(confirmed),
      `a confirm after a cancel must be refused, got ${confirmed.status} ${JSON.stringify(confirmed.data)}`,
    ).toBe(true);
    expect(isSettled(confirmed)).toBe(false);

    // (3) STRICT no-movement: no 张伟 debit, the balance is untouched, the day total is still ¥0.
    expect(await getTestPrisma().transaction.count({ where: { counterpartyId: ZHANGWEI.id } })).toBe(0);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(0);

    // (4) EXACTLY ONE audit row — the cancelled decision.
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe('cancelled');
    expect(audits[0]!.confirmed).toBe(false);
  });

  it('[integration] confirm-then-cancel: the executed transfer is TRUTHFULLY PRESERVED and the late cancel is REFUSED', async () => {
    const { sessionId, actionId } = await seedParkedAction();

    // (1) The confirm lands FIRST and wins: the ¥200 actually moves.
    const confirmed = await confirmHttp(actionId, sessionId);
    const executedBody = payload(confirmed);
    expect(executedBody.status).toBe('executed');
    expect(executedBody.ok).toBe(true);
    expect(isSettled(confirmed)).toBe(true);

    const transfers = await zhangweiTransfers();
    expect(transfers, 'the winning confirm must debit 张伟 EXACTLY once').toHaveLength(1);
    expect(transfers[0]!.amount).toBe(-TRANSFER_AMOUNT);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(TRANSFER_AMOUNT);

    // (2) The late cancel is REFUSED — the completed transfer is never rolled back.
    const cancelled = await cancelActionHttp(actionId, sessionId);
    expect(
      isRefused(cancelled),
      `a cancel after an executed confirm must be refused, got ${cancelled.status} ${JSON.stringify(cancelled.data)}`,
    ).toBe(true);
    expect(isSettled(cancelled)).toBe(false);

    // (3) The money stays moved: the ledger row + the balance decrement are durable history.
    const finalRow = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(finalRow.status).toBe('executed');
    expect(await zhangweiTransfers()).toHaveLength(1);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(TRANSFER_AMOUNT);

    // (4) EXACTLY ONE audit row — the successful decision.
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.status).toBe('success');
    expect(audits[0]!.confirmed).toBe(true);
  });
});

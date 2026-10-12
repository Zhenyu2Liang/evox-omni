/**
 * tests/app/tasks-http.test.ts — REAL-application-entry (HTTP) end-to-end specs for the DAG/task
 * lifecycle (demo Case 11 driven at the app-entry layer).
 *
 * These specs drive the REAL Next.js App Router route handlers — `GET/POST /api/tasks/[id]`,
 * `GET /api/tasks`, `POST /api/actions/[id]/{confirm,verify}` and `POST /api/chat` — by importing
 * their exported `POST`/`GET` functions and calling them with REAL `NextRequest` objects (see
 * `./harness.ts`). Underneath, the whole production stack runs (`route → @/agent → banking tools →
 * security gateway beforeToolCall → Banking SDK → SQLite`). Only the MODEL is scripted
 * (`tests/setup.ts` forces `LLM_MODE=mock`). Offline, no API key, no network.
 *
 * ============================================================================================
 * HONEST SPLIT — what is REAL-HTTP here vs what is deliberately left to the `@/agent`-level harness
 * ============================================================================================
 * (i) REAL HTTP (this spec). A durable plan WITH a parked GATED node is SEEDED through the production
 *     APIs (`agent/tools/planning.ts#runSubmitPlan` → real `AgentTask`/`AgentTaskNode` rows + a real
 *     `PendingAction`), then driven over the real handlers:
 *       • `POST /api/actions/[id]/confirm|verify` RESUMES the parked plan and writes the REAL tool
 *         result back into the plan/session (asserted on the persisted `AgentTaskNode`, a real
 *         `Transaction` row and the decremented balance);
 *       • `POST /api/tasks/[id]` pause / cancel / retry drive the real executor lifecycle;
 *       • `GET /api/tasks/[id]` returns the persisted plan (refresh recovery), for both a seeded plan
 *         and a durable GREEN plan submitted through `POST /api/chat`.
 * (ii) NOT COVERED HERE — the PARKING-EVENT emission DURING a chat turn. The PLAIN plan trigger
 *     (`帮我计划一下…`) makes `agent/providers/mock-responder.ts#handlePlan` emit ONLY GREEN plan
 *     nodes, so a `submit_plan` issued through `POST /api/chat` for THAT trigger NEVER parks. The
 *     CONDITIONAL limit-adjustment trigger DOES emit a gated DAG and PARKS mid-turn over the same
 *     real HTTP + mock path — that is covered end-to-end by `./plan-parking-http.test.ts`; (ii) here
 *     is limited to the plain GREEN plan lifecycle. No unreachable behaviour is fabricated.
 *
 * DB lifecycle matches the other DB-backed suites: reset + seed before each test, disconnect after.
 * Every scenario uses a UNIQUE persisted session id (the in-process circuit breaker is keyed by
 * `sessionId`, and the task-control ownership path additionally requires the matching `AgentSession`
 * row) — obtained via `getOrCreateSession`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { GET as tasksGet } from '@/app/api/tasks/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import { executeGatedTool, getOrCreateSession, readPendingActionId } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { MFA_CODE } from '@/lib/constants';
import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import { createTask, createTaskNode, updateTaskNode } from '@/lib/db/repositories/task';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  actionUrl,
  chatUrl,
  getJson,
  idCtx,
  postJson,
  taskUrl,
  tasksUrl,
  type HttpResult,
} from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** Primary 活期账户 (¥23,580) — the default funding account every transfer debits. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance (¥23,580). */
const SEEDED_BALANCE = CHECKING.balance;
/** The recipient resolved by name from the seeded contacts. */
const RECIPIENT_NAME = '张伟';

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
function planUpdateOf(events: readonly AgentStreamEvent[]): TaskPlan | undefined {
  const event = events.find(
    (candidate): candidate is Extract<AgentStreamEvent, { type: 'plan_update' }> =>
      candidate.type === 'plan_update',
  );
  return event?.plan;
}

/** The recorded `TaskNodeResult` for a node id (throws when absent — a missing node is a bug). */
function resultOf(plan: TaskPlan, nodeId: string) {
  const result = plan.results.find((candidate) => candidate.id === nodeId);
  expect(result, `plan ${plan.id} has no node '${nodeId}'`).toBeDefined();
  return result!;
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

/** A two-step DAG: a GREEN read, then a gated transfer (which parks for a human decision). */
function transferPlanNodes(amount: number): SeedNode[] {
  return [
    { id: 'n1', name: '查询余额', dependencies: [], kind: 'tool', tool: 'get_balance', args: {} },
    {
      id: 'n2',
      name: `给${RECIPIENT_NAME}转账`,
      dependencies: ['n1'],
      kind: 'tool',
      tool: 'transfer_money',
      args: { name: RECIPIENT_NAME, amount },
    },
  ];
}

/** Create + persist a fresh `AgentSession` for the demo user and return its id. */
async function newPersistedSessionId(): Promise<string> {
  return (await getOrCreateSession(DEMO_USER_ID)).sessionId;
}

/** The gateway-authorized per-node runner (a gated node parks instead of executing). */
function gatewayRunTool(sessionId: string, userRequest = '') {
  return (toolName: string, args: Record<string, unknown>, ctx: { taskId: string; nodeId: string }) =>
    executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: toolName as Parameters<typeof executeGatedTool>[0]['toolName'],
      args,
      userRequest,
      ...ctx,
    });
}

/**
 * Seed a durable plan through the PRODUCTION `submit_plan` runner: real `AgentTask`/`AgentTaskNode`
 * rows + a real `PendingAction` for the gated node. Returns the persisted plan and its owning session.
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
  expect(result.ok, `runSubmitPlan failed: ${result.error}`).toBe(true);
  const plan = result.data as TaskPlan;
  return { sessionId, taskId: plan.id, plan };
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] POST /api/tasks/[id] — real task control (pause / cancel / retry)', () => {
  it('pause — halts the parked plan and persists the paused snapshot (status:paused)', async () => {
    const { sessionId, taskId, plan } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));
    expect(plan.status).toBe('waiting_confirmation');

    const res = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'pause' },
      { ctx: idCtx(taskId), sessionId },
    );

    expect(res.status).toBe(200);
    const paused = payload(res);
    expect(paused.id).toBe(taskId);
    // `TaskPlanStatus` includes 'paused': `pauseTask` persists that status on the snapshot AND the row.
    expect(paused.status).toBe('paused');

    // The halt is DURABLE — the AgentTask row carries the paused status.
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('paused');
    // The already-successful node keeps its result; the parked node stays parked (awaiting a decision).
    expect(resultOf(paused, 'n1').status).toBe('success');
    expect(resultOf(paused, 'n2').status).toBe('waiting_confirmation');
  });

  it('cancel — halts the plan and cancels every remaining node (executed node keeps its result)', async () => {
    const { sessionId, taskId } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));

    const res = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(taskId),
      { action: 'cancel' },
      { ctx: idCtx(taskId), sessionId },
    );

    expect(res.status).toBe(200);
    const cancelled = payload(res);
    expect(cancelled.status).toBe('cancelled');
    // n1 already executed (irreversible) → kept `success`; the parked n2 is cancelled.
    expect(resultOf(cancelled, 'n1').status).toBe('success');
    expect(resultOf(cancelled, 'n2').status).toBe('cancelled');

    // Durable: the node rows agree with the snapshot.
    const nodes = await getTestPrisma().agentTaskNode.findMany({
      where: { taskId },
      orderBy: { order: 'asc' },
    });
    expect(nodes.map((node) => node.status)).toEqual(['success', 'cancelled']);
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('cancelled');
  });

  it('retry — re-runs ONLY the failed node; a completed node keeps its recorded result', async () => {
    const sessionId = await newPersistedSessionId();
    // Seed a plan with one COMPLETED node (a recorded marker) and one FAILED node (its would-be
    // failure cause is transient: it is re-run through the real GREEN `get_balance`, which succeeds).
    const task = await createTask({
      sessionId,
      userId: DEMO_USER_ID,
      goal: '重试计划',
      status: 'failed',
    });
    await createTaskNode({
      taskId: task.id,
      nodeId: 'n1',
      name: '已完成的查询',
      kind: 'tool',
      tool: 'get_balance',
      args: {},
      order: 0,
      dependencies: [],
      status: 'success',
    });
    await updateTaskNode(task.id, 'n1', { output: { marker: 'n1-original' } });
    await createTaskNode({
      taskId: task.id,
      nodeId: 'n2',
      name: '失败的查询',
      kind: 'tool',
      tool: 'get_balance',
      args: {},
      order: 1,
      dependencies: ['n1'],
      status: 'failed',
    });

    const res = await postJson<Envelope<TaskPlan>>(
      taskPost,
      taskUrl(task.id),
      { action: 'retry' },
      { ctx: idCtx(task.id), sessionId },
    );

    expect(res.status).toBe(200);
    const retried = payload(res);
    expect(retried.status).toBe('success');

    // The completed node was NOT re-run — its recorded marker is untouched.
    expect(resultOf(retried, 'n1').output).toEqual({ marker: 'n1-original' });
    // The failed node WAS re-run and now carries the REAL tool result.
    const n2 = resultOf(retried, 'n2');
    expect(n2.status).toBe('success');
    expect(Array.isArray((n2.output as { accounts?: unknown }).accounts)).toBe(true);

    // Durable: pending→success persisted.
    const nodes = await getTestPrisma().agentTaskNode.findMany({
      where: { taskId: task.id },
      orderBy: { order: 'asc' },
    });
    expect(nodes.map((node) => node.status)).toEqual(['success', 'success']);
    expect(nodes[0].output).toContain('n1-original');
  });
});

describe('[integration] POST /api/actions/[id]/{confirm,verify} — resume the parked plan with the REAL result', () => {
  it('confirm (YELLOW) — resumes the parked YELLOW node and writes the REAL transfer result back', async () => {
    const { sessionId, taskId, plan } = await seedPlan(
      '先查余额再给张伟转200元',
      transferPlanNodes(200),
    );
    const parkedActionId = readPendingActionId(resultOf(plan, 'n2').output);
    expect(typeof parkedActionId).toBe('string');

    const res = await postJson<Envelope<{ ok: boolean; status: string; tier: string; requiresMfa: boolean; events: AgentStreamEvent[] }>>(
      confirmPost,
      actionUrl(parkedActionId!, 'confirm'),
      {},
      { ctx: idCtx(parkedActionId!), sessionId },
    );

    expect(res.status).toBe(200);
    const outcome = payload(res);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');
    expect(outcome.tier).toBe('YELLOW');
    expect(outcome.requiresMfa).toBe(false);

    // The response forwards a refreshed plan whose parked node now carries the REAL tool result.
    const resumed = planUpdateOf(outcome.events);
    expect(resumed).toBeDefined();
    const n2 = resultOf(resumed!, 'n2');
    expect(n2.status).toBe('success');
    const transfer = n2.output as { amount: number; transactionId: string; newBalance: number };
    expect(transfer.amount).toBe(200);
    expect(typeof transfer.transactionId).toBe('string');
    expect(transfer.newBalance).toBe(SEEDED_BALANCE - 200);

    // Durable side effects: plan settled success, node persisted, a real ledger row + the debit.
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('success');
    const nodeRow = await getTestPrisma().agentTaskNode.findFirst({
      where: { taskId, nodeId: 'n2' },
    });
    expect(nodeRow!.status).toBe('success');
    expect(nodeRow!.output).toContain(transfer.transactionId);

    const ledger = await getTestPrisma().transaction.findUnique({
      where: { id: transfer.transactionId },
    });
    expect(ledger).not.toBeNull();
    expect(ledger!.amount).toBe(-200);
    const account = await getTestPrisma().account.findUnique({ where: { id: CHECKING.id } });
    expect(account!.balance).toBe(SEEDED_BALANCE - 200);
  });

  it('verify (RED) — resumes the parked RED node after MFA and writes the REAL transfer result back', async () => {
    // amount 5000 > the ¥1000 daily limit ⇒ RED (MFA-gated).
    const { sessionId, taskId, plan } = await seedPlan(
      '先查余额再给张伟转5000元',
      transferPlanNodes(5000),
    );
    const parkedActionId = readPendingActionId(resultOf(plan, 'n2').output);
    expect(typeof parkedActionId).toBe('string');
    // A RED gate parks as `awaiting_mfa`.
    const parked = await getTestPrisma().pendingAction.findUnique({
      where: { id: parkedActionId! },
    });
    expect(parked!.riskLevel).toBe('RED');
    expect(parked!.requiresMfa).toBe(true);
    expect(parked!.status).toBe('awaiting_mfa');

    const res = await postJson<Envelope<{ ok: boolean; status: string; tier: string; mfaResult?: string; events: AgentStreamEvent[] }>>(
      verifyPost,
      actionUrl(parkedActionId!, 'verify'),
      { code: MFA_CODE },
      { ctx: idCtx(parkedActionId!), sessionId },
    );

    expect(res.status).toBe(200);
    const outcome = payload(res);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');
    expect(outcome.tier).toBe('RED');
    expect(outcome.mfaResult).toBe('success');
    // The MFA code is never echoed back.
    expect(JSON.stringify(res.data)).not.toContain(MFA_CODE);

    const resumed = planUpdateOf(outcome.events);
    expect(resumed).toBeDefined();
    const n2 = resultOf(resumed!, 'n2');
    expect(n2.status).toBe('success');
    const transfer = n2.output as { amount: number; transactionId: string; newBalance: number };
    expect(transfer.amount).toBe(5000);
    expect(transfer.newBalance).toBe(SEEDED_BALANCE - 5000);

    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('success');
    const account = await getTestPrisma().account.findUnique({ where: { id: CHECKING.id } });
    expect(account!.balance).toBe(SEEDED_BALANCE - 5000);
  });
});

describe('[integration] GET /api/tasks/[id] + GET /api/tasks — refresh recovery / listing', () => {
  it('GET /api/tasks/[id] returns the persisted plan (refresh recovery for a seeded parked plan)', async () => {
    const { sessionId, taskId, plan } = await seedPlan(
      '先查余额再给张伟转200元',
      transferPlanNodes(200),
    );

    const res = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), {
      ctx: idCtx(taskId),
      sessionId,
    });

    expect(res.status).toBe(200);
    const recovered = payload(res);
    expect(recovered.id).toBe(taskId);
    expect(recovered.sessionId).toBe(sessionId);
    expect(recovered.goal).toBe('先查余额再给张伟转200元');
    expect(recovered.status).toBe('waiting_confirmation');
    expect(recovered.nodes.map((node) => node.id)).toEqual(['n1', 'n2']);
    expect(resultOf(recovered, 'n2').status).toBe('waiting_confirmation');
    // The parked node's `pendingActionId` survived the reload.
    expect(readPendingActionId(resultOf(recovered, 'n2').output)).toBe(
      readPendingActionId(resultOf(plan, 'n2').output),
    );
  });

  it('GET /api/tasks/[id] returns the durable GREEN plan submitted through POST /api/chat', async () => {
    // "帮我计划一下…" is the mock `submit_plan` trigger; the balance branch emits a GREEN DAG
    // (`get_balance` → `note`) — never a gated node (see the honest-split header).
    const chat = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
      message: '帮我计划一下查询余额',
    });
    expect(chat.status).toBe(200);
    const turn = payload(chat);

    // The turn persisted exactly one durable plan for its session.
    const listRes = await getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, tasksUrl(), {
      sessionId: turn.sessionId,
    });
    const listed = payload(listRes).plans;
    expect(listed).toHaveLength(1);
    const planId = listed[0].id;

    const res = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(planId), {
      ctx: idCtx(planId),
      sessionId: turn.sessionId,
    });
    expect(res.status).toBe(200);
    const recovered = payload(res);
    expect(recovered.id).toBe(planId);
    expect(recovered.sessionId).toBe(turn.sessionId);
    expect(recovered.goal).toBe('帮我计划一下查询余额');
    // The GREEN DAG ran to completion: a `get_balance` tool node + a `note` node.
    expect(recovered.nodes.map((node) => node.tool)).toEqual(['get_balance', undefined]);
    expect(recovered.status).toBe('success');
    expect(recovered.results.every((result) => result.status === 'success')).toBe(true);
  });

  it('GET /api/tasks lists the session plans newest-first; an absent session yields { plans: [] }', async () => {
    const sessionId = await newPersistedSessionId();
    const older = await createTask({ sessionId, userId: DEMO_USER_ID, goal: '较早的计划' });
    const newer = await createTask({ sessionId, userId: DEMO_USER_ID, goal: '较新的计划' });
    // Pin deterministic `createdAt` so "newest-first" is order-stable regardless of clock resolution.
    const prisma = getTestPrisma();
    await prisma.agentTask.update({
      where: { id: older.id },
      data: { createdAt: new Date(2026, 8, 1, 10, 0, 0) },
    });
    await prisma.agentTask.update({
      where: { id: newer.id },
      data: { createdAt: new Date(2026, 8, 2, 10, 0, 0) },
    });

    const res = await getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, tasksUrl(), { sessionId });
    expect(res.status).toBe(200);
    expect(payload(res).plans.map((plan) => plan.id)).toEqual([newer.id, older.id]);

    // No session resolvable → an empty list (200, never an error).
    const emptyRes = await getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, tasksUrl());
    expect(emptyRes.status).toBe(200);
    expect(payload(emptyRes).plans).toEqual([]);
  });
});

describe('[integration] task endpoints — authorization (cookie-only identity)', () => {
  it('POST /api/tasks/[id] without a session (no cookie) → 403 SECURITY_DENIED', async () => {
    const { taskId } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));

    const res = await postJson<Envelope<unknown>>(
      taskPost,
      taskUrl(taskId), // no cookie → requireIdentity rejects BEFORE the body is parsed
      { action: 'pause' },
      { ctx: idCtx(taskId) },
    );

    expect(res.status).toBe(403);
    expect(failure(res).code).toBe('SECURITY_DENIED');
    // The rejected control changed nothing.
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('waiting_confirmation');
  });

  it('POST /api/tasks/[id] with a valid but FOREIGN session → 403 SECURITY_DENIED (ownership)', async () => {
    const { taskId } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));
    // A REAL persisted session that does NOT own the task: identity passes, ownership fails.
    const foreignSessionId = await newPersistedSessionId();

    const res = await postJson<Envelope<unknown>>(
      taskPost,
      taskUrl(taskId),
      { action: 'cancel' },
      { ctx: idCtx(taskId), sessionId: foreignSessionId },
    );

    expect(res.status).toBe(403);
    expect(failure(res).code).toBe('SECURITY_DENIED');
    // The foreign control changed nothing.
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('waiting_confirmation');
  });

  it('POST /api/tasks/[id] with an unknown id (valid cookie) → 404 NOT_FOUND', async () => {
    const sessionId = await newPersistedSessionId();

    const res = await postJson<Envelope<unknown>>(
      taskPost,
      taskUrl('task_missing'),
      { action: 'pause' },
      { ctx: idCtx('task_missing'), sessionId },
    );

    expect(res.status).toBe(404);
    expect(failure(res).code).toBe('NOT_FOUND');
  });

  it('GET /api/tasks/[id] with an unknown id (valid cookie) → 404 NOT_FOUND', async () => {
    const sessionId = await newPersistedSessionId();
    const res = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl('task_missing'), {
      ctx: idCtx('task_missing'),
      sessionId,
    });

    expect(res.status).toBe(404);
    expect(failure(res).code).toBe('NOT_FOUND');
  });

  it('GET /api/tasks/[id] with no cookie → 403 SECURITY_DENIED (identity is cookie-only)', async () => {
    const { taskId } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));

    const res = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), {
      ctx: idCtx(taskId),
    });

    expect(res.status).toBe(403);
    expect(failure(res).code).toBe('SECURITY_DENIED');
  });

  it('GET /api/tasks/[id] for a task owned by a FOREIGN session → 403 SECURITY_DENIED', async () => {
    const { taskId } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));
    const foreignSessionId = await newPersistedSessionId();

    const res = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), {
      ctx: idCtx(taskId),
      sessionId: foreignSessionId,
    });

    expect(res.status).toBe(403);
    expect(failure(res).code).toBe('SECURITY_DENIED');
  });
});

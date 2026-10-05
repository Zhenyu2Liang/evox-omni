/**
 * tests/app/identity-http.test.ts — REAL-application-entry (HTTP) e2e for COOKIE-ONLY identity.
 *
 * Objective: prove, at the HTTP boundary, that the caller identity of EVERY write/auth route is
 * derived SOLELY from the trusted `banking_session` cookie — a query param can never forge, widen
 * or override it — and that a VALID cookie still may not settle another session's action/task
 * (ownership). Both invariants are the demo's "the agent may decide WHAT, never WHETHER" line
 * expressed at the transport layer.
 *
 * These specs drive the REAL Next.js App Router route handlers: they import the exported
 * `POST`/`GET` functions and call them with REAL `NextRequest` objects (see `./harness.ts`):
 *   • POST /api/actions/[id]/{confirm,verify,cancel}
 *   • POST /api/tasks/[id]   · GET /api/tasks/[id]
 *   • POST /api/security/reset
 *   • GET /api/actions       · GET /api/tasks
 * Underneath, the whole production stack runs (`route → @/agent → banking tools → security gateway
 * beforeToolCall → Banking SDK → SQLite`). Only the MODEL is scripted (`tests/setup.ts` forces
 * `LLM_MODE=mock`). Offline, no API key, no network.
 *
 * SOURCE OBSERVATIONS asserted here (reported, NOT fixed — outside ./tests):
 *   (a) There is NO `POST /api/tasks` route: `app/api/tasks/route.ts` exports ONLY `GET`, so the
 *       task collection is read-only. `POST /api/tasks/[id]` is the control verb.
 *   (b) `GET /api/tasks` (the listing) is the ONE auth surface that does NOT 403: it resolves
 *       identity with `resolveIdentity` (not `requireIdentity`), so a missing/unknown cookie yields
 *       an EMPTY list at 200 — by design (the chat page has no plans to restore yet).
 * Both are asserted (never faked): scenario 1b pins them. The `423 CIRCUIT_OPEN` gap is covered by
 * `./actions-http.test.ts`; it is not re-tested here.
 *
 * DB lifecycle matches the other DB-backed suites: reset + seed before each test, disconnect after.
 * Every parking turn sends NO cookie, so the route MINTS a FRESH session (the in-process breaker
 * is keyed by `sessionId`); that minted id is the PERSISTED owning id we assert on and send back
 * as the `banking_session` COOKIE.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import { GET as tasksGet } from '@/app/api/tasks/route';
import * as tasksRouteModule from '@/app/api/tasks/route';
import { POST as resetPost } from '@/app/api/security/reset/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { executeGatedTool, getOrCreateSession } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import { MFA_CODE } from '@/lib/constants';
import { newId } from '@/lib/ids';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
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
/** Recipient resolved by name from the seeded contacts (the money-moved probe). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The recipient name the transfer trigger / seeded plan resolves. */
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

/* -------------------------------------------------------------------------- envelope helpers */

/** Success protocol helper: assert the envelope and return its payload. */
function payload<T>(res: HttpResult<Envelope<T>>): T {
  expect(res.data?.ok, `expected success envelope, got ${JSON.stringify(res.data)}`).toBe(true);
  return res.data!.data as T;
}

/** Identity/ownership failure protocol: assert 403 + `SECURITY_DENIED`. */
function expectDenied<T>(res: HttpResult<Envelope<T>>): void {
  expect(res.status, `expected 403, got body ${JSON.stringify(res.data)}`).toBe(403);
  expect(res.data?.ok).toBe(false);
  expect(res.data?.error?.code).toBe('SECURITY_DENIED');
}

/** Unknown-resource protocol: assert 404 + `NOT_FOUND` (never 403 for a VALID cookie). */
function expectNotFound<T>(res: HttpResult<Envelope<T>>): void {
  expect(res.status, `expected 404, got body ${JSON.stringify(res.data)}`).toBe(404);
  expect(res.data?.ok).toBe(false);
  expect(res.data?.error?.code).toBe('NOT_FOUND');
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
 * rows + a real `PendingAction` for the gated node. Returns the persisted task id + owning session.
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

/* -------------------------------------------------------------------------------- invokers */

/**
 * Drive ONE JSON-mode chat turn that PARKS a YELLOW transfer, returning the PERSISTED (owning)
 * session id and the parked `PendingAction` id. Sends NO cookie so the route MINTS a FRESH
 * session id (the in-process circuit breaker starts clean); that minted id is what we assert on.
 */
async function parkYellowTransfer(): Promise<{ sessionId: string; actionId: string }> {
  const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
    // COOKIE-ONLY bootstrap: omit sessionId (and send no cookie) so the route MINTS the session.
    message: '给张伟转200元',
  });
  expect(res.status).toBe(200);
  const turn = payload(res);
  const row = await getTestPrisma().pendingAction.findFirstOrThrow({
    where: { sessionId: turn.sessionId, toolName: 'transfer_money' },
  });
  expect(row.riskLevel).toBe('YELLOW');
  expect(row.status).toBe('pending');
  return { sessionId: turn.sessionId, actionId: row.id };
}

/** Per-call identity + an optional RAW query string (to forge `?sessionId=`/`?userId=`). */
interface CallOpts {
  sessionId?: string;
  query?: string;
}

/** Append a raw query string to an action path (`undefined` ⇒ no query). */
function actionPath(id: string, action: 'confirm' | 'verify' | 'cancel', query?: string): string {
  const base = actionUrl(id, action);
  return query ? `${base}?${query}` : base;
}

/** Invoke an action route: the dynamic-route `ctx` is passed explicitly; identity is the cookie. */
function confirmAction(id: string, opts: CallOpts = {}) {
  return postJson<Envelope<ActionResponse>>(
    confirmPost,
    actionPath(id, 'confirm', opts.query),
    {},
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

function verifyAction(id: string, opts: CallOpts = {}) {
  return postJson<Envelope<ActionResponse>>(
    verifyPost,
    actionPath(id, 'verify', opts.query),
    { code: MFA_CODE },
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

function cancelAction(id: string, opts: CallOpts = {}) {
  return postJson<Envelope<ActionResponse>>(
    cancelPost,
    actionPath(id, 'cancel', opts.query),
    {},
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

/** `POST /api/tasks/[id]` — execution control. */
function taskControl(id: string, action: 'pause' | 'cancel', opts: CallOpts = {}) {
  return postJson<Envelope<TaskPlan>>(
    taskPost,
    taskUrl(id),
    { action },
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

/** `GET /api/tasks/[id]` — one plan (ownership-enforced). */
function taskRead(id: string, opts: CallOpts = {}) {
  return getJson<Envelope<TaskPlan>>(taskGet, taskUrl(id), {
    ctx: idCtx(id),
    sessionId: opts.sessionId,
  });
}

/** `GET /api/actions` — the caller session's non-terminal pending actions (read-only auth surface). */
function actionsList(opts: CallOpts = {}) {
  return getJson<Envelope<unknown[]>>(actionsGet, '/api/actions', {
    sessionId: opts.sessionId,
  });
}

/** `GET /api/tasks` — the caller session's plans (the documented unauthenticated exception). */
function tasksList(opts: CallOpts = {}) {
  return getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, tasksUrl(), {
    sessionId: opts.sessionId,
  });
}

/** `POST /api/security/reset` — the audited breaker unlock (single-arg handler, no body). */
function securityReset(opts: CallOpts = {}) {
  return postJson<Envelope<unknown>>(resetPost, '/api/security/reset', {}, {
    sessionId: opts.sessionId,
  });
}

/* ----------------------------------------------------------------------------- DB helpers */

/** Current 活期 balance (¥23,580 seeded). */
async function checkingBalance(): Promise<number> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return account.balance;
}

/** Every ledger row paid to 张伟 (the money-moved probe). */
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

describe('[integration] identity — a MISSING cookie fails closed (403) on every write/auth route', () => {
  it('1 — confirm/verify/cancel + task POST + GET task/[id] + security/reset + GET actions all 403 SECURITY_DENIED, and nothing settles', async () => {
    const parking = await parkYellowTransfer();
    const { taskId } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));

    // NO cookie anywhere → `requireIdentity` rejects (fail-closed) BEFORE any business logic runs.
    expectDenied(await confirmAction(parking.actionId));
    expectDenied(await verifyAction(parking.actionId));
    expectDenied(await cancelAction(parking.actionId));
    expectDenied(await taskControl(taskId, 'pause'));
    expectDenied(await taskRead(taskId));
    expectDenied(await securityReset());
    expectDenied(await actionsList());

    // Nothing settled: the YELLOW action is still pending, no money moved and NO audit row exists.
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({
      where: { id: parking.actionId },
    });
    expect(action.status).toBe('pending');
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count()).toBe(0);

    // The task control changed nothing either — the plan is still parked.
    const taskRow = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(taskRow!.status).toBe('waiting_confirmation');
  });

  it('1b — the documented EXCEPTIONS: GET /api/tasks never 403s (empty list, 200) and there is NO POST /api/tasks route', async () => {
    // (b) `GET /api/tasks` resolves identity with `resolveIdentity` (NOT `requireIdentity`): a
    // missing cookie or an unknown session id yields an EMPTY list at 200 — by design, never 403.
    const noCookie = await tasksList();
    expect(noCookie.status).toBe(200);
    expect(payload(noCookie).plans).toEqual([]);

    const unknownCookie = await tasksList({ sessionId: newId('sess') });
    expect(unknownCookie.status).toBe(200);
    expect(payload(unknownCookie).plans).toEqual([]);

    // (a) `app/api/tasks/route.ts` exports ONLY `GET` — the collection has no POST control verb.
    // Asserted structurally so adding a `POST` handler later trips this test (never fabricated).
    expect('POST' in tasksRouteModule).toBe(false);
    expect(typeof tasksRouteModule.GET).toBe('function');
  });
});

describe('[integration] identity — an UNKNOWN session cookie fails closed (403) on every write/auth route', () => {
  it('2 — an unknown session id cookie (no matching AgentSession row) is 403 SECURITY_DENIED everywhere', async () => {
    const parking = await parkYellowTransfer();
    const { taskId } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));
    // A syntactically valid id that maps to NO persisted session row — it can never resolve to a user.
    const unknownCookieId = newId('sess');

    expectDenied(await confirmAction(parking.actionId, { sessionId: unknownCookieId }));
    expectDenied(await verifyAction(parking.actionId, { sessionId: unknownCookieId }));
    expectDenied(await cancelAction(parking.actionId, { sessionId: unknownCookieId }));
    expectDenied(await taskControl(taskId, 'cancel', { sessionId: unknownCookieId }));
    expectDenied(await taskRead(taskId, { sessionId: unknownCookieId }));
    expectDenied(await securityReset({ sessionId: unknownCookieId }));
    expectDenied(await actionsList({ sessionId: unknownCookieId }));

    // Fail-closed: nothing settled, no money moved, no audit row, the plan untouched.
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({
      where: { id: parking.actionId },
    });
    expect(action.status).toBe('pending');
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count()).toBe(0);
    const taskRow = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(taskRow!.status).toBe('waiting_confirmation');
  });
});

describe('[integration] identity — forged query params can NEVER override the cookie identity', () => {
  it('3a — no cookie + `?sessionId=<owning id>&userId=user_liming` on confirm is still 403 SECURITY_DENIED', async () => {
    const { sessionId, actionId } = await parkYellowTransfer();

    // Both forged params carry the CORRECT owning session id / user id, yet no cookie is sent.
    const forged = `sessionId=${encodeURIComponent(sessionId)}&userId=${encodeURIComponent(DEMO_USER_ID)}`;
    const res = await confirmAction(actionId, { query: forged });

    expectDenied(res);

    // The query param bought nothing: the action is still pending and no money moved.
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.status).toBe('pending');
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
  });

  it('3b — a REAL FOREIGN cookie + `?sessionId=<owning id>` on confirm is still 403 SECURITY_DENIED', async () => {
    const { sessionId, actionId } = await parkYellowTransfer();
    // A REAL persisted session that does NOT own the action: identity passes, ownership fails.
    const foreignSessionId = await newPersistedSessionId();
    expect(foreignSessionId).not.toBe(sessionId);

    const res = await confirmAction(actionId, {
      sessionId: foreignSessionId,
      query: `sessionId=${encodeURIComponent(sessionId)}`,
    });

    // The query param can never widen the FOREIGN cookie's identity to the owning session.
    expectDenied(res);

    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.status).toBe('pending');
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
  });
});

describe('[integration] identity — a VALID cookie that does NOT own the target is denied (ownership)', () => {
  it('4 — a foreign OWNER cookie is 403 on confirm/verify/cancel; the pending action stays pending', async () => {
    const { actionId } = await parkYellowTransfer();
    const foreignSessionId = await newPersistedSessionId();

    expectDenied(await confirmAction(actionId, { sessionId: foreignSessionId }));
    expectDenied(await verifyAction(actionId, { sessionId: foreignSessionId }));
    expectDenied(await cancelAction(actionId, { sessionId: foreignSessionId }));

    // The target is UNTOUCHED: still pending, no money moved, no audit row written.
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.status).toBe('pending');
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count()).toBe(0);
  });

  it('4b — a foreign OWNER cookie is 403 on task control AND task read; the plan stays parked', async () => {
    const { taskId } = await seedPlan('先查余额再给张伟转200元', transferPlanNodes(200));
    const foreignSessionId = await newPersistedSessionId();

    expectDenied(await taskControl(taskId, 'pause', { sessionId: foreignSessionId }));
    expectDenied(await taskRead(taskId, { sessionId: foreignSessionId }));

    // The plan snapshot / row are untouched — the foreign control did not pause or cancel anything.
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
    expect(row!.status).toBe('waiting_confirmation');
    const nodes = await getTestPrisma().agentTaskNode.findMany({
      where: { taskId },
      orderBy: { order: 'asc' },
    });
    expect(nodes.map((node) => node.status)).toEqual(['success', 'waiting_confirmation']);
  });
});

describe('[integration] identity — a truly UNKNOWN id (with a VALID cookie) is 404 NOT_FOUND, never 403', () => {
  it('5 — unknown action id on confirm/verify/cancel and unknown task id on control/read all 404 NOT_FOUND', async () => {
    const sessionId = await newPersistedSessionId();

    const unknownActionId = newId('missing');
    expectNotFound(await confirmAction(unknownActionId, { sessionId }));
    expectNotFound(await verifyAction(unknownActionId, { sessionId }));
    expectNotFound(await cancelAction(unknownActionId, { sessionId }));

    const unknownTaskId = newId('missing');
    expectNotFound(await taskControl(unknownTaskId, 'pause', { sessionId }));
    expectNotFound(await taskRead(unknownTaskId, { sessionId }));
  });
});

/**
 * tests/app/session-takeover-http.test.ts — REAL-application-entry (HTTP) regression specs for
 * SESSION TAKEOVER and CROSS-SESSION ISOLATION.
 *
 * These specs drive the REAL Next.js App Router route handlers — importing their exported
 * `POST`/`GET` functions and calling them with REAL `NextRequest` objects (see `./harness.ts`) — so
 * the whole production stack runs (`route → @/agent runTurn → banking tools → security gateway
 * beforeToolCall → Banking SDK → SQLite`). Only the MODEL is scripted: `tests/setup.ts` forces
 * `LLM_MODE=mock`. Offline, no API key, no network.
 *
 * WHAT IS DISTINCT HERE (vs `./identity-http.test.ts`): identity proves the query params cannot
 * forge the COOKIE identity and that identity is cookie-only. THIS suite pins the concrete ATTACK
 * the cookie-only rule defends against — a caller holding their OWN valid `banking_session` cookie
 * must NOT be able to exchange a VICTIM's session id (sent in the `POST /api/chat` BODY) for the
 * victim's authorization cookie, and must NOT be able to read/settle the victim's parked action or
 * plan. It closes the loop end-to-end at the HTTP boundary:
 *   1. SESSION TAKEOVER — `POST /api/chat` with session B's cookie + session A's id in the body is
 *      `409 CONFLICT` and sets NO cookie (A's identity is never adopted); the same holds with NO
 *      cookie at all (a body id can never mint/select a session).
 *   2. CROSS-SESSION ISOLATION — session B's (valid) cookie can neither settle nor even SEE session
 *      A's parked `PendingAction` / `AgentTask`.
 *   3. MISSING COOKIE — every write/auth route fails closed (`403 SECURITY_DENIED`).
 *   4. FORGED QUERY PARAMS — `?sessionId=`/`?userId=` never authenticate an absent/foreign cookie.
 *
 * COOKIE-ONLY BOOTSTRAP: the route mints the session itself. The FIRST turn is sent with a body that
 * OMITS `sessionId` and NO cookie; the route persists a session and echoes its id in `data.sessionId`
 * AND the `banking_session` `Set-Cookie`. Later requests carry that id as the COOKIE (`sessionId`
 * option). A body `sessionId` is NEVER trusted for identity.
 *
 * DB lifecycle matches the other DB-backed suites: reset + seed before each test, disconnect after.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import { GET as tasksGet } from '@/app/api/tasks/route';
import { POST as resetPost } from '@/app/api/security/reset/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import type { PendingAction } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import { MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  actionUrl,
  chatUrl,
  getJson,
  idCtx,
  postJson,
  sessionIdFromResponse,
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

/** A plain greeting — the cheapest turn that merely MINTs/loads a session (no tool call). */
const GREETING = '你好';
/** Triggers a `search_contact` → YELLOW `transfer_money` call, which PARKS for confirmation. */
const TRANSFER_MESSAGE = '给张伟转200元';
/**
 * The conditional limit-adjustment trigger (verbatim). `mock-responder#handlePlan` turns it into a
 * 3-node DAG (`analyze_spending` → condition → YELLOW `set_card_limit`) whose gated node PARKS, so
 * the turn persists a real `AgentTask` owned by the caller's session.
 */
const CONDITIONAL_PLAN_MESSAGE = '如果这个月娱乐消费超过2000元，就把娱乐消费限额调整为1500元';

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

/** Session-takeover rejection protocol: assert 409 + `CONFLICT`. */
function expectConflict<T>(res: HttpResult<Envelope<T>>): void {
  expect(res.status, `expected 409, got body ${JSON.stringify(res.data)}`).toBe(409);
  expect(res.data?.ok).toBe(false);
  expect(res.data?.error?.code).toBe('CONFLICT');
}

/** A forged query string carrying BOTH the correct owning session id AND the demo user id. */
function forgedOwnershipQuery(sessionId: string): string {
  return `sessionId=${encodeURIComponent(sessionId)}&userId=${encodeURIComponent(DEMO_USER_ID)}`;
}

/* -------------------------------------------------------------------------------- invokers */

/** Per-call cookie identity + an optional RAW query string (to forge `?sessionId=`/`?userId=`). */
interface CallOpts {
  sessionId?: string;
  query?: string;
}

/** Append a raw query string to a path (`undefined` ⇒ no query). */
function withQuery(path: string, query?: string): string {
  return query ? `${path}?${query}` : path;
}

/**
 * Bootstrap a FRESH persisted session via the COOKIE-ONLY path: the first turn OMITS the body
 * `sessionId` and sends NO cookie, so the route MINTS the session. Asserts the returned body id
 * agrees with the `banking_session` `Set-Cookie`, and returns the persisted id.
 */
async function bootstrapSession(): Promise<string> {
  const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
    message: GREETING,
  });
  expect(res.status, `bootstrap turn failed: ${JSON.stringify(res.data)}`).toBe(200);
  const turn = payload(res);
  expect(turn.sessionId.length).toBeGreaterThan(0);
  expect(sessionIdFromResponse(res.res)).toBe(turn.sessionId);
  return turn.sessionId;
}

/** Drive one authenticated JSON-mode chat turn with an existing session's COOKIE. */
async function chatTurn(sessionId: string, message: string): Promise<ChatTurnResponse> {
  const res = await postJson<Envelope<ChatTurnResponse>>(
    chatPost,
    chatUrl({ stream: 0 }),
    { message },
    { sessionId },
  );
  expect(res.status, `chat turn failed: ${JSON.stringify(res.data)}`).toBe(200);
  const turn = payload(res);
  // The turn never mints a new session: it runs in the cookie's session.
  expect(turn.sessionId).toBe(sessionId);
  return turn;
}

/** Park a YELLOW `transfer_money` for the given session and return the persisted action id. */
async function parkTransfer(sessionId: string): Promise<string> {
  await chatTurn(sessionId, TRANSFER_MESSAGE);
  const row = await getTestPrisma().pendingAction.findFirstOrThrow({
    where: { sessionId, toolName: 'transfer_money' },
  });
  expect(row.riskLevel).toBe('YELLOW');
  expect(row.status).toBe('pending');
  return row.id;
}

/** Park a DAG plan for the given session and return the persisted `AgentTask` id. */
async function parkPlanTask(sessionId: string): Promise<string> {
  await chatTurn(sessionId, CONDITIONAL_PLAN_MESSAGE);
  const task = await getTestPrisma().agentTask.findFirstOrThrow({ where: { sessionId } });
  expect(task.status).toBe('waiting_confirmation');
  return task.id;
}

function confirmAction(id: string, opts: CallOpts = {}) {
  return postJson<Envelope<ActionResponse>>(
    confirmPost,
    withQuery(actionUrl(id, 'confirm'), opts.query),
    {},
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

function verifyAction(id: string, opts: CallOpts = {}) {
  return postJson<Envelope<ActionResponse>>(
    verifyPost,
    withQuery(actionUrl(id, 'verify'), opts.query),
    { code: MFA_CODE },
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

function cancelAction(id: string, opts: CallOpts = {}) {
  return postJson<Envelope<ActionResponse>>(
    cancelPost,
    withQuery(actionUrl(id, 'cancel'), opts.query),
    {},
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

/** `POST /api/tasks/[id]` — execution control. */
function taskControl(id: string, action: 'pause' | 'cancel' = 'pause', opts: CallOpts = {}) {
  return postJson<Envelope<TaskPlan>>(
    taskPost,
    withQuery(taskUrl(id), opts.query),
    { action },
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

/** `GET /api/tasks/[id]` — one plan (ownership-enforced). */
function taskRead(id: string, opts: CallOpts = {}) {
  return getJson<Envelope<TaskPlan>>(taskGet, withQuery(taskUrl(id), opts.query), {
    ctx: idCtx(id),
    sessionId: opts.sessionId,
  });
}

/** `GET /api/actions` — the caller session's non-terminal pending actions (read-only auth surface). */
function actionsList(opts: CallOpts = {}) {
  return getJson<Envelope<PendingAction[]>>(actionsGet, withQuery('/api/actions', opts.query), {
    sessionId: opts.sessionId,
  });
}

/** `GET /api/tasks` — the caller session's plans (the documented unauthenticated exception). */
function tasksList(opts: CallOpts = {}) {
  return getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, withQuery(tasksUrl(), opts.query), {
    sessionId: opts.sessionId,
  });
}

/** `POST /api/security/reset` — the audited breaker unlock (single-arg handler, no body). */
function securityReset(opts: CallOpts = {}) {
  return postJson<Envelope<unknown>>(resetPost, withQuery('/api/security/reset', opts.query), {}, {
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

/** Assert NOTHING settled: balance untouched, no money moved, no audit row written. */
async function expectNothingMoved(): Promise<void> {
  expect(await checkingBalance()).toBe(SEEDED_BALANCE);
  expect(await zhangweiTransfers()).toHaveLength(0);
  expect(await getTestPrisma().auditLog.count()).toBe(0);
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] session takeover — POST /api/chat never adopts a body-supplied session id', () => {
  it("1 — [integration] a chat turn with session B's cookie and session A's id in the body is 409 CONFLICT and sets NO cookie", async () => {
    const sessionA = await bootstrapSession();
    const sessionB = await bootstrapSession();
    expect(sessionB).not.toBe(sessionA);

    // A REAL, valid cookie for B, but the BODY tries to exchange it for A's session id.
    const res = await postJson<Envelope<ChatTurnResponse>>(
      chatPost,
      chatUrl({ stream: 0 }),
      { sessionId: sessionA, message: '查一下余额' },
      { sessionId: sessionB },
    );

    expectConflict(res);
    // No `banking_session` cookie is handed back — B is never upgraded to A's identity.
    expect(res.headers.get('set-cookie')).toBeNull();
    // No session was created for the takeover attempt (still exactly A + B).
    expect(await getTestPrisma().agentSession.count()).toBe(2);
  });

  it('2 — [integration] a chat turn with NO cookie and a body sessionId is 409 CONFLICT (a body id can never mint or select a session)', async () => {
    const sessionA = await bootstrapSession();

    const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
      sessionId: sessionA,
      message: '查一下余额',
    });

    expectConflict(res);
    expect(res.headers.get('set-cookie')).toBeNull();
    // The rejected turn minted nothing: only A's bootstrap session exists.
    expect(await getTestPrisma().agentSession.count()).toBe(1);
  });
});

describe('[integration] cross-session isolation — a valid foreign cookie cannot settle or see another session', () => {
  it("3 — [integration] session B cannot confirm/verify/cancel NOR read session A's parked action", async () => {
    const sessionA = await bootstrapSession();
    const sessionB = await bootstrapSession();
    const actionId = await parkTransfer(sessionA);

    // B's cookie is VALID, but B does not own A's action → ownership denial on every verb.
    expectDenied(await confirmAction(actionId, { sessionId: sessionB }));
    expectDenied(await verifyAction(actionId, { sessionId: sessionB }));
    expectDenied(await cancelAction(actionId, { sessionId: sessionB }));

    // The restore endpoint is scoped to the CALLER session: B sees NONE of A's actions...
    const own = await actionsList({ sessionId: sessionB });
    expect(own.status).toBe(200);
    expect(payload(own)).toEqual([]);
    // ...and a forged query carrying A's id/user cannot widen B's view to A's actions either.
    const forged = await actionsList({ sessionId: sessionB, query: forgedOwnershipQuery(sessionA) });
    expect(payload(forged)).toEqual([]);

    // A's action is UNTOUCHED and nothing settled.
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.status).toBe('pending');
    expect(action.sessionId).toBe(sessionA);
    await expectNothingMoved();
  });

  it("4 — [integration] session B cannot control or read session A's parked plan; it stays waiting_confirmation", async () => {
    const sessionA = await bootstrapSession();
    const sessionB = await bootstrapSession();
    const taskId = await parkPlanTask(sessionA);

    expectDenied(await taskControl(taskId, 'pause', { sessionId: sessionB }));
    expectDenied(await taskRead(taskId, { sessionId: sessionB }));
    // A forged query carrying A's id cannot widen B's foreign cookie on the task routes.
    const forged = forgedOwnershipQuery(sessionA);
    expectDenied(await taskControl(taskId, 'pause', { sessionId: sessionB, query: forged }));
    expectDenied(await taskRead(taskId, { sessionId: sessionB, query: forged }));

    // A's plan is UNTOUCHED by the foreign control attempts.
    const row = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe('waiting_confirmation');
    expect(row.sessionId).toBe(sessionA);

    // The OWNER can still read its own plan — proves the 403s above are ownership, not a broken route.
    const own = await taskRead(taskId, { sessionId: sessionA });
    expect(own.status).toBe(200);
    expect(payload(own).id).toBe(taskId);

    // The listing is scoped too: B has no plans of its own.
    const listed = await tasksList({ sessionId: sessionB });
    expect(listed.status).toBe(200);
    expect(payload(listed).plans).toEqual([]);
  });
});

describe('[integration] missing cookie — every write/auth route fails closed (403 SECURITY_DENIED)', () => {
  it('5 — [integration] confirm/verify/cancel + task control/read + security/reset are all 403 with NO cookie, and nothing settles', async () => {
    const sessionA = await bootstrapSession();
    const actionId = await parkTransfer(sessionA);
    const taskId = await parkPlanTask(sessionA);

    // NO cookie anywhere → `requireIdentity` rejects (fail-closed) BEFORE any business logic runs.
    expectDenied(await confirmAction(actionId));
    expectDenied(await verifyAction(actionId));
    expectDenied(await cancelAction(actionId));
    expectDenied(await taskControl(taskId, 'pause'));
    expectDenied(await taskRead(taskId));
    expectDenied(await securityReset());

    // Nothing settled: the YELLOW action is still pending, the plan still parked, no money, no audit.
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.status).toBe('pending');
    const task = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('waiting_confirmation');
    await expectNothingMoved();
  });
});

describe('[integration] forged query params — ?sessionId=/?userId= never authenticate', () => {
  it('6 — [integration] no cookie + forged ?sessionId&userId is 403 on every write/auth route, and nothing settles', async () => {
    const sessionA = await bootstrapSession();
    const actionId = await parkTransfer(sessionA);
    const taskId = await parkPlanTask(sessionA);

    // Both forged params carry the CORRECT owning session id / user id, yet no cookie is sent.
    const forged = forgedOwnershipQuery(sessionA);
    expectDenied(await confirmAction(actionId, { query: forged }));
    expectDenied(await verifyAction(actionId, { query: forged }));
    expectDenied(await cancelAction(actionId, { query: forged }));
    expectDenied(await taskControl(taskId, 'pause', { query: forged }));
    expectDenied(await taskRead(taskId, { query: forged }));
    expectDenied(await securityReset({ query: forged }));

    // The forged params bought nothing: the action is still pending, the plan still parked.
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.status).toBe('pending');
    const task = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('waiting_confirmation');
    await expectNothingMoved();
  });

  it('7 — [integration] a REAL foreign cookie + forged ?sessionId=<owning> is still 403 SECURITY_DENIED', async () => {
    const sessionA = await bootstrapSession();
    const sessionB = await bootstrapSession();
    const actionId = await parkTransfer(sessionA);
    // The query param names the OWNING session, but the cookie is B's — ownership still fails.
    const forged = `sessionId=${encodeURIComponent(sessionA)}`;

    expectDenied(await confirmAction(actionId, { sessionId: sessionB, query: forged }));
    expectDenied(await verifyAction(actionId, { sessionId: sessionB, query: forged }));
    expectDenied(await cancelAction(actionId, { sessionId: sessionB, query: forged }));

    // A query param can never widen the foreign cookie's identity to the owning session.
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.status).toBe('pending');
    await expectNothingMoved();
  });
});

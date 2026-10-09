/**
 * tests/app/security-workflow-http.test.ts — SECURITY WORKFLOWS at the REAL-application-entry
 * (HTTP) layer.
 *
 * Each `describe` captures a regression that a reviewer found in a previously-shipped area and that
 * must never come back. Like every other `tests/app/*` spec, the REAL Next.js App Router route
 * handlers are imported and invoked with real `NextRequest` objects (`./harness.ts`), so the whole
 * production stack runs underneath (route → `@/agent` → banking tools → security gateway
 * `beforeToolCall` → Banking SDK → SQLite). Only the MODEL is scripted: `tests/setup.ts` forces
 * `LLM_MODE=mock`, so `agent/providers/mock-responder.ts` answers. Offline, no API key, no network.
 *
 * ---------------------------------------------------------------------------
 * SCENARIO 1 — TWO YELLOW parks in ONE session: the SECOND confirm escalates to RED (MFA)
 * ---------------------------------------------------------------------------
 * Two distinct ¥600 transfers (to 张伟 and to 王芳) are parked in the SAME session. At PARK time the
 * day's EXECUTED transfer total is ¥0, so each ¥600 ≤ `DAILY_TRANSFER_LIMIT` (¥1000) and BOTH park
 * YELLOW / `pending` / `requiresMfa:false`. Confirming the first one moves ¥600 and raises the day
 * total; confirming the second one must therefore be RE-RISKED at EXECUTION time — ¥600 + ¥600 >
 * ¥1000 ⇒ the parked YELLOW confirmation is refused and ESCALATES to RED with strong verification
 * (`security/risk-engine.ts` + `security/security-gateway.ts#authorizeTransfer`). The escalation is
 * decided ENTIRELY in code, never by the model, and it must not move any money until the mock MFA
 * code is verified. This is the regression: parking two individually-small transfers must NOT let
 * the pair bypass the ¥1000 RED/MFA threshold.
 *
 * Deterministic DB lifecycle: reset + seed before each test, disconnect after. A UNIQUE session id
 * per scenario (the DURABLE breaker is keyed PER OWNER — `user:<userId>`, else `session:<id>` — and
 * cleared by the per-test truncate); NO fake timers — the demo clock `DEMO_NOW` anchors the day-transfer window.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { POST as resetPost, type ResetData } from '@/app/api/security/reset/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { executeGatedTool, getOrCreateSession, readPendingActionId } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { DAILY_TRANSFER_LIMIT, MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { listTasksBySession } from '@/lib/db/repositories/task';
import { security } from '@/security';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  actionUrl,
  chatUrl,
  getJson,
  idCtx,
  postJson,
  postRaw,
  taskUrl,
  type HttpResult,
} from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (seeded ¥23,580) — the account both parked transfers debit. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** Recipient 张伟 — the FIRST parked transfer (the one that executes on confirm). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** Recipient 王芳 — the SECOND parked transfer (the one that must escalate at confirm time). */
const WANGFANG = CONTACTS.find((contact) => contact.name === '王芳')!;
/** The seeded checking balance. */
const SEEDED_BALANCE = CHECKING.balance;

/** Both parked transfers use the same amount: ¥600 each ≤ ¥1000, ¥600 + ¥600 > ¥1000. */
const TRANSFER_AMOUNT = 600;

/**
 * The route's JSON envelope — the app-layer transport shape (NOT a frozen `@/lib/contracts` type).
 * Declared structurally so specs can narrow `ok` / `data` / `error` without importing app privates.
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

/** Identity/ownership failure protocol: assert 403 + `SECURITY_DENIED`. */
function expectDenied<T>(res: HttpResult<Envelope<T>>): void {
  expect(res.status, `expected 403, got body ${JSON.stringify(res.data)}`).toBe(403);
  expect(res.data?.ok).toBe(false);
  expect(res.data?.error?.code).toBe('SECURITY_DENIED');
}

/**
 * Assert the literal mock MFA code never leaks into a response body we captured.
 *
 * `JSON.stringify(undefined)` returns `undefined` (NOT a string), so a captured body with no
 * serializable value (e.g. an optional `data?.data` on an error envelope) would make
 * `expect(...).not.toContain(...)` THROW ("the given combination of arguments (undefined and string)
 * is invalid") instead of actually running the leak check. Coerce the serialization to a real string
 * so the assertion EVALUATES for EVERY captured body — including an absent/`undefined` one — rather
 * than crashing the test or being silently skipped.
 */
function expectNoMfaLeak(label: string, ...bodies: unknown[]): void {
  for (const body of bodies) {
    const serialized = JSON.stringify(body) ?? String(body);
    expect(serialized, `${label}: the MFA code leaked into a response body`).not.toContain(MFA_CODE);
  }
}

/* -------------------------------------------------------------------------- event narrowing */

type MfaEvent = Extract<AgentStreamEvent, { type: 'mfa_required' }>;

/** The `mfa_required` escalation event of an action response, when present. */
function mfaOf(events: readonly AgentStreamEvent[]): MfaEvent | undefined {
  return events.find((event): event is MfaEvent => event.type === 'mfa_required');
}

/* -------------------------------------------------------------------------------- invokers */

/**
 * Drive one JSON-mode chat turn against the real route. `sessionId` is reused for a CONTINUATION
 * turn (parking a second action in the same session) or minted fresh (a unique session per test —
 * the circuit breaker is keyed by it).
 */
async function chatTurn(message: string, sessionId?: string): Promise<ChatTurnResponse> {
  const res = await postJson<Envelope<ChatTurnResponse>>(
    chatPost,
    chatUrl({ stream: 0 }),
    { message },
    sessionId === undefined ? {} : { sessionId },
  );
  expect(res.status).toBe(200);
  return payload(res);
}

/**
 * Invoke the REAL confirm route. The dynamic-route `ctx` MUST be passed explicitly (the harness
 * defaults it to `idCtx('')`) and identity travels as the `banking_session` COOKIE — identity is
 * cookie-only, so a `?sessionId=` query param would be IGNORED.
 */
function confirmAction(id: string, sessionId?: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(confirmPost, actionUrl(id, 'confirm'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

/** Invoke the REAL verify route with an MFA code (cookie-only identity, as above). */
function verifyAction(
  id: string,
  code: string,
  sessionId?: string,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(verifyPost, actionUrl(id, 'verify'), { code }, {
    ctx: idCtx(id),
    sessionId,
  });
}

/* ----------------------------------------------------------------------------- DB helpers */

/** Current 活期 balance (seeded ¥23,580). */
async function checkingBalance(): Promise<number> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return account.balance;
}

/** Every ledger row paid to `contactId` (the money-moved-exactly-once probe). */
function transfersTo(contactId: string) {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: contactId } });
}

/** The recipient a parked transfer targets: `contactId` when resolved, else the raw name. */
function parkedPayee(row: { argsJson: string }): string | undefined {
  const args = JSON.parse(row.argsJson) as { contactId?: string; name?: string };
  return args.contactId ?? args.name;
}

/** Find the parked row addressing a fixture contact (by id OR name — either may be persisted). */
function parkFor<T extends { argsJson: string }>(
  rows: readonly T[],
  contact: { id: string; name: string },
): T | undefined {
  return rows.find((row) => {
    const payee = parkedPayee(row);
    return payee === contact.id || payee === contact.name;
  });
}

/**
 * Park TWO distinct ¥600 transfers in ONE session: A → 张伟, then B → 王芳 (the mock responder routes
 * each "给<name>转600元" to `search_contact` and then to `transfer_money`).
 *
 * At PARK time the day's EXECUTED transfer total is ¥0, so BOTH must park YELLOW / `pending` /
 * `requiresMfa:false` — that is the precondition the escalation regression depends on. Nothing is
 * executed here.
 */
async function parkTwoTransfers() {
  // The two amounts must straddle the ¥1000 confirmation-only limit — assert the arithmetic.
  expect(TRANSFER_AMOUNT).toBeLessThanOrEqual(DAILY_TRANSFER_LIMIT);
  expect(TRANSFER_AMOUNT * 2).toBeGreaterThan(DAILY_TRANSFER_LIMIT);

  // 1) Park the ¥600 transfer to 张伟 (fresh session).
  const first = await chatTurn('给张伟转600元');
  const sessionId = first.sessionId;

  // 2) Park the ¥600 transfer to 王芳 in the SAME session.
  const second = await chatTurn('给王芳转600元', sessionId);
  expect(second.sessionId, 'the continuation turn must reuse the session').toBe(sessionId);

  const rows = await getTestPrisma().pendingAction.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
  expect(rows, 'both ¥600 transfers must be parked in the SAME session').toHaveLength(2);

  const actionA = parkFor(rows, ZHANGWEI);
  const actionB = parkFor(rows, WANGFANG);
  expect(actionA, 'the 张伟 park must exist').toBeDefined();
  expect(actionB, 'the 王芳 park must exist').toBeDefined();
  expect(rows[0].id, 'the 张伟 transfer was parked first').toBe(actionA!.id);

  for (const [label, row] of [
    ['张伟', actionA!],
    ['王芳', actionB!],
  ] as const) {
    expect(row.toolName, `${label}: the gated tool must be transfer_money`).toBe('transfer_money');
    expect(row.riskLevel, `${label}: park-time day total is ¥0, so ¥600 is YELLOW`).toBe('YELLOW');
    expect(row.requiresMfa, `${label}: YELLOW parks without MFA`).toBe(false);
    expect(row.status, `${label}: parked, not executed`).toBe('pending');
  }

  // Nothing moved at park time: two parks, zero ledger rows, balance untouched.
  expect(await transfersTo(ZHANGWEI.id)).toHaveLength(0);
  expect(await transfersTo(WANGFANG.id)).toHaveLength(0);
  expect(await checkingBalance()).toBe(SEEDED_BALANCE);

  return { sessionId, actionA: actionA!, actionB: actionB! };
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ----------------------------------------------------------------------------------- tests */

describe('[integration] POST /api/actions/[id]/confirm — two YELLOW parks in ONE session', () => {
  it('1 — the SECOND ¥600 confirm escalates to RED/MFA and moves NO money', async () => {
    const { sessionId, actionA, actionB } = await parkTwoTransfers();

    // CONFIRM A — the day total is still ¥0, so the parked YELLOW confirmation is accepted.
    const resA = await confirmAction(actionA.id, sessionId);
    expect(resA.status).toBe(200);
    const dataA = payload(resA);
    expect(dataA.ok).toBe(true);
    expect(dataA.status).toBe('executed');
    expect(dataA.tier).toBe('YELLOW');
    expect(await transfersTo(ZHANGWEI.id)).toHaveLength(1);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);

    // CONFIRM B — the day total is now ¥600, so ¥600 + ¥600 > ¥1000 ⇒ strong verification required.
    const resB = await confirmAction(actionB.id, sessionId);
    expect(resB.status).toBe(200);
    const dataB = payload(resB);
    expect(dataB.ok).toBe(false);
    expect(dataB.requiresMfa).toBe(true);
    expect(dataB.tier).toBe('RED');
    expect(mfaOf(dataB.events), 'expected an mfa_required escalation event').toBeDefined();

    // The escalation is PERSISTED on B: awaiting the code, effective RED/MFA.
    const rowB = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionB.id } });
    expect(rowB.status).toBe('awaiting_mfa');
    expect(rowB.riskLevel).toBe('RED');
    expect(rowB.requiresMfa).toBe(true);

    // Fail-closed: the escalated confirm moved NO money (only A's ¥600 is gone).
    expect(await transfersTo(WANGFANG.id)).toHaveLength(0);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);

    expectNoMfaLeak('Scenario 1 / it 1', resA.data, resA.data?.data, resB.data, resB.data?.data);
  });
});

describe('[integration] POST /api/actions/[id]/verify — completing an escalated transfer', () => {
  it('2 — verify(MFA_CODE) on the escalated ¥600 executes exactly once and audits RED/mfaRequired/success', async () => {
    const { sessionId, actionA, actionB } = await parkTwoTransfers();

    // First park executes normally (YELLOW)…
    const resA = await confirmAction(actionA.id, sessionId);
    expect(payload(resA).ok).toBe(true);

    // …which pushes the second confirm over the ¥1000 limit ⇒ escalation.
    const escalated = await confirmAction(actionB.id, sessionId);
    const escalatedData = payload(escalated);
    expect(escalatedData.ok).toBe(false);
    expect(escalatedData.requiresMfa).toBe(true);
    expect(escalatedData.tier).toBe('RED');

    // VERIFY with the mock code completes the strong-verification path.
    const res = await verifyAction(actionB.id, MFA_CODE, sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('RED');
    expect(data.requiresMfa).toBe(true);
    expect(data.mfaResult).toBe('success');

    // Both transfers moved EXACTLY ONCE: ¥23,580 − ¥600 − ¥600.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - 2 * TRANSFER_AMOUNT);
    const wangfang = await transfersTo(WANGFANG.id);
    expect(wangfang).toHaveLength(1);
    expect(wangfang[0].amount).toBe(-TRANSFER_AMOUNT);
    expect(await transfersTo(ZHANGWEI.id)).toHaveLength(1);

    // The escalated decision is audited with the EFFECTIVE RED/MFA flags — never the stale YELLOW
    // park (the YELLOW confirm of A legitimately has `mfaResult:'not_required'`).
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    const redAudit = audits.find((row) => row.mfaResult === 'success');
    expect(redAudit, 'expected a RED/MFA success audit row for the escalated transfer').toBeDefined();
    expect(redAudit!.status).toBe('success');
    expect(redAudit!.toolName).toBe('transfer_money');
    expect(redAudit!.mfaRequired).toBe(true);
    expect(redAudit!.riskLevel).toBe('RED');
    expect(redAudit!.mfaResult).toBe('success');

    expectNoMfaLeak(
      'Scenario 1 / it 2',
      escalated.data,
      escalated.data?.data,
      res.data,
      res.data?.data,
    );
  });
});

describe('[integration] POST /api/actions/[id]/verify — a WRONG code on an escalated transfer', () => {
  it('3 — a wrong code is a normal 200 with ok:false / awaiting_mfa / mfaResult:failed and moves NO money', async () => {
    const { sessionId, actionA, actionB } = await parkTwoTransfers();

    // Confirm A (YELLOW) then escalate B by confirming it.
    expect(payload(await confirmAction(actionA.id, sessionId)).ok).toBe(true);
    const escalated = payload(await confirmAction(actionB.id, sessionId));
    expect(escalated.tier).toBe('RED');

    const res = await verifyAction(actionB.id, '000000', sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(false);
    expect(data.status).toBe('awaiting_mfa');
    expect(data.mfaResult).toBe('failed');
    expect(data.tier).toBe('RED');

    // Fail-closed: only A's ¥600 moved and a failed MFA attempt writes NO audit row
    // (A's single `success` row may exist — only `failed` is forbidden).
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);
    expect(await transfersTo(WANGFANG.id)).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId, mfaResult: 'failed' } })).toBe(0);

    // One failure does not lock the action: it still awaits the correct code as RED/MFA.
    const rowB = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionB.id } });
    expect(rowB.status).toBe('awaiting_mfa');
    expect(rowB.riskLevel).toBe('RED');

    expectNoMfaLeak('Scenario 1 / it 3', escalated, res.data, res.data?.data);
  });
});

/* ============================================================================================== *
 * SCENARIO 2 — a plan CANCEL revokes its parked action; the cancel/confirm RACE
 * ============================================================================================== *
 * A durable plan is seeded through the PRODUCTION `submit_plan` runner (`runSubmitPlan`, exactly as
 * `tests/app/dag-recovery-http.test.ts#seedPlan`): node n1 = GREEN `reserve_budget` (a COUNTABLE
 * probe — exactly ONE `Budget` row per execution) and node n2 = YELLOW `transfer_money` to 张伟
 * (¥200) depending on n1. The seed EXECUTES n1 and PARKS n2 as a `PendingAction`.
 *
 * The regression: cancelling the plan must REVOKE the parked action so a later confirm can never
 * move money out of a plan the user just cancelled — while an EXECUTED transfer is never pretended
 * to be rolled back. Both orderings are exercised (cancel-then-confirm, confirm-then-cancel); the
 * outcome is decided ENTIRELY in code (`agent/task-control.ts#cancelTask` →
 * `security/security-gateway.ts#cancelAction` + `planner/lifecycle.ts#cancelPlan`), never by text.
 * ============================================================================================== */

/** Recipient 张伟 (declared above) — the payee of Scenario 2's parked YELLOW transfer. */
const RECIPIENT = ZHANGWEI;
/** Scenario 2's YELLOW transfers move ¥200 — ≤ `DAILY_TRANSFER_LIMIT`, so they park YELLOW. */
const PARKED_AMOUNT = 200;
/** The COUNTABLE GREEN probe's budget name (exactly ONE row per successful execution). */
const PROBE_BUDGET = '预留预算S2';

/** A plan node as supplied to `runSubmitPlan` (the model-free DAG runner). */
interface SeedNode {
  id: string;
  name: string;
  dependencies: string[];
  kind: 'tool' | 'condition' | 'note';
  tool?: string;
  args?: Record<string, unknown>;
}

/** GREEN probe node — `reserve_budget` writes exactly ONE `Budget` row per run. */
function budgetNode(id: string, budgetName: string, amount: number, deps: string[] = []): SeedNode {
  return {
    id,
    name: budgetName,
    dependencies: deps,
    kind: 'tool',
    tool: 'reserve_budget',
    args: { name: budgetName, amount },
  };
}

/** YELLOW `transfer_money` node — gated, so it PARKS a `PendingAction` instead of executing. */
function transferNode(id: string, amount: number, deps: string[] = []): SeedNode {
  return {
    id,
    name: `给${RECIPIENT.name}转账`,
    dependencies: deps,
    kind: 'tool',
    tool: 'transfer_money',
    args: { name: RECIPIENT.name, amount },
  };
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
 * rows + a real `PendingAction` for a gated node + the matching `AgentSession` row that the control
 * ownership check (`agent/task-control.ts#loadOwnedTask`) requires.
 */
async function seedPlan(
  goal: string,
  nodes: SeedNode[],
): Promise<{ sessionId: string; taskId: string; plan: TaskPlan }> {
  const sessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
  const result = await runSubmitPlan(DEMO_USER_ID, { goal, nodes }, {
    sessionId,
    runTool: gatewayRunTool(sessionId, goal),
  });
  const plan = result.data as TaskPlan | undefined;
  expect(plan, `runSubmitPlan produced no plan: ${result.error}`).toBeDefined();
  return { sessionId, taskId: plan!.id, plan: plan! };
}

/** Count the `Budget` rows with the given name (0 ⇒ that node never executed). */
function countBudgets(name: string): Promise<number> {
  return getTestPrisma().budget.count({ where: { userId: DEMO_USER_ID, name } });
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

/** `POST /api/tasks/[id] { action:'cancel' }` (identity is cookie-only). */
function cancelTaskRequest(taskId: string, sessionId: string): Promise<HttpResult<Envelope<TaskPlan>>> {
  return postJson<Envelope<TaskPlan>>(taskPost, taskUrl(taskId), { action: 'cancel' }, {
    ctx: idCtx(taskId),
    sessionId,
  });
}

/**
 * Seed the Scenario 2 plan and assert its PARKED precondition: n1 = GREEN `reserve_budget` probe
 * (ONE `Budget` row, `success`) and n2 = YELLOW `transfer_money` (¥200 to 张伟, PARKED). Nothing has
 * moved. Returns the persisted plan + the parked `PendingAction` id (read from n2's `output` JSON).
 */
async function seedParkedTransferPlan() {
  const { sessionId, taskId, plan } = await seedPlan('先预留预算S2，再给张伟转200元', [
    budgetNode('n1', PROBE_BUDGET, 1200),
    transferNode('n2', PARKED_AMOUNT, ['n1']),
  ]);

  expect(PARKED_AMOUNT).toBeLessThanOrEqual(DAILY_TRANSFER_LIMIT);

  expect(plan.status).toBe('waiting_confirmation');
  expect(nodeStatusOf(plan, 'n1')).toBe('success');
  expect(nodeStatusOf(plan, 'n2')).toBe('waiting_confirmation');
  expect(await countBudgets(PROBE_BUDGET)).toBe(1);

  const parkedActionId = readPendingActionId(resultOf(plan, 'n2').output);
  expect(typeof parkedActionId).toBe('string');

  // The parked YELLOW transfer has NOT moved any money at seed time.
  expect(await transfersTo(RECIPIENT.id)).toHaveLength(0);
  expect(await checkingBalance()).toBe(SEEDED_BALANCE);

  return { sessionId, taskId, plan, parkedActionId: parkedActionId! };
}

/* --------------------------------------------------------------------------- Scenario 2 specs */

describe('[integration] POST /api/tasks/[id] cancel — revokes the plan parked action; a later confirm is refused', () => {
  it('4 — cancel first: the parked YELLOW action is revoked, the plan is terminal, and a later confirm is refused with NO money moved', async () => {
    const { sessionId, taskId, parkedActionId } = await seedParkedTransferPlan();
    const dayTotalBefore = await security.risk.computeDailyTransferTotal(DEMO_USER_ID);

    // --- CANCEL the plan through the REAL route (cookie-only identity).
    const cancelRes = await cancelTaskRequest(taskId, sessionId);
    expect(cancelRes.status).toBe(200);
    const cancelled = payload(cancelRes);
    expect(cancelled.status).toBe('cancelled');

    // The executed node keeps `success`; the parked node is now `cancelled`.
    expect(nodeStatusOf(cancelled, 'n1')).toBe('success');
    expect(nodeStatusOf(cancelled, 'n2')).toBe('cancelled');

    // Durable: the node rows + the `AgentTask` row agree with the snapshot.
    const nodes = await getTestPrisma().agentTaskNode.findMany({
      where: { taskId },
      orderBy: { order: 'asc' },
    });
    expect(nodes.map((node) => node.status)).toEqual(['success', 'cancelled']);
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('cancelled');

    // The parked action was REVOKED through the gateway: a later confirm can never move money.
    const revoked = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: parkedActionId } });
    expect(revoked.status).toBe('cancelled');

    // The executed node's side effect is NOT rolled back (irreversible) and NOT duplicated.
    expect(await countBudgets(PROBE_BUDGET)).toBe(1);

    // --- CONFIRM the revoked action: refused (the atomic claim finds no `pending` status) + NO move.
    const confirmRes = await confirmAction(parkedActionId, sessionId);
    expect(confirmRes.status).toBe(200);
    const refused = payload(confirmRes);
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe('cancelled');
    expect(await transfersTo(RECIPIENT.id)).toHaveLength(0);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    // The day's outbound transfer total is UNCHANGED — the refused confirm moved nothing.
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(dayTotalBefore);

    expectNoMfaLeak('Scenario 2 / it 4', cancelRes.data, cancelRes.data?.data, confirmRes.data, confirmRes.data?.data);
  });
});

describe('[integration] POST /api/tasks/[id] cancel — an already-completed plan is terminal and the executed transfer is preserved', () => {
  it('5 — confirm first: the executed transfer is preserved truthfully (no rollback) and a later cancel keeps the executed nodes', async () => {
    const { sessionId, taskId, parkedActionId } = await seedParkedTransferPlan();

    // --- CONFIRM the parked YELLOW transfer: it EXECUTES (¥200 out of checking).
    const confirmRes = await confirmAction(parkedActionId, sessionId);
    expect(confirmRes.status).toBe(200);
    const executed = payload(confirmRes);
    expect(executed.ok).toBe(true);
    expect(executed.status).toBe('executed');
    expect(executed.tier).toBe('YELLOW');

    const zhangwei = await transfersTo(RECIPIENT.id);
    expect(zhangwei).toHaveLength(1);
    expect(zhangwei[0].amount).toBe(-PARKED_AMOUNT);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - PARKED_AMOUNT);

    // The plan continued (the executed node's real outcome was written back): both nodes `success`.
    const completedNodes = await getTestPrisma().agentTaskNode.findMany({
      where: { taskId },
      orderBy: { order: 'asc' },
    });
    expect(completedNodes.map((node) => node.status)).toEqual(['success', 'success']);
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('success');

    // --- CANCEL the now-COMPLETED plan. HONEST behaviour (`agent/task-control.ts#cancelTask` →
    // `planner/lifecycle.ts#cancelPlan`): the plan snapshot/row still settles `cancelled`, but a
    // TERMINAL (`success`) node KEEPS its status — no node becomes `cancelled` — and nothing that
    // already executed is rolled back. The already-executed action is terminal, so revoking it is a
    // no-op (`security-gateway.cancelAction` reports it `alreadySettled`, never a failure).
    const cancelRes = await cancelTaskRequest(taskId, sessionId);
    expect(cancelRes.status).toBe(200);
    const after = payload(cancelRes);
    expect(after.status).toBe('cancelled');
    expect(nodeStatusOf(after, 'n1')).toBe('success');
    expect(nodeStatusOf(after, 'n2')).toBe('success');

    // Durable: the node rows agree — NO node became `cancelled` — and the task row settled `cancelled`.
    const nodes = await getTestPrisma().agentTaskNode.findMany({
      where: { taskId },
      orderBy: { order: 'asc' },
    });
    expect(nodes.map((node) => node.status)).toEqual(['success', 'success']);
    expect((await getTestPrisma().agentTask.findUnique({ where: { id: taskId } }))!.status).toBe('cancelled');

    // A refresh read returns the SAME terminal snapshot (no node was undone by the cancel).
    const reloaded = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(taskId), {
      ctx: idCtx(taskId),
      sessionId,
    });
    expect(reloaded.status).toBe(200);
    const refreshed = payload(reloaded);
    expect(refreshed.status).toBe('cancelled');
    expect(refreshed.results.map((result) => result.status)).toEqual(['success', 'success']);

    // The executed transfer is PRESERVED truthfully — exactly ONE ±¥200 row, balance still debited.
    const afterRows = await transfersTo(RECIPIENT.id);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].amount).toBe(-PARKED_AMOUNT);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - PARKED_AMOUNT);
    // The GREEN probe was neither re-run nor rolled back, and the action row is still `executed`.
    expect(await countBudgets(PROBE_BUDGET)).toBe(1);
    expect(
      (await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: parkedActionId } })).status,
    ).toBe('executed');

    expectNoMfaLeak('Scenario 2 / it 5', confirmRes.data, confirmRes.data?.data, cancelRes.data, cancelRes.data?.data);
  });
});

/* ============================================================================================== *
 * SCENARIO 3 — a MID-RUN PAUSE stops the NEXT node; resume re-runs ONLY the not-yet-run node
 * ============================================================================================== *
 * A 2-node GREEN plan is seeded through the PRODUCTION `submit_plan` runner (`runSubmitPlan`): node
 * `a` = `reserve_budget` (a COUNTABLE probe — exactly ONE `Budget` row per execution, no deps) and
 * node `b` = `reserve_budget` depending on `a`. The plan walk is STRICTLY SEQUENTIAL
 * (`planner/executor.ts`): at the TOP of every loop iteration it consults the durable control port
 * (`deps.controls`), and the production port (`agent/task-control.ts#defaultPollControls`) maps a
 * persisted `AgentTask.status === 'paused'` to `{ kind:'pause' }`.
 *
 * The regression: a pause issued THROUGH THE REAL `POST /api/tasks/[id]` WHILE node `a` is executing
 * (i.e. after it ran, before the executor looks at node `b`) must be observed at the NEXT checkpoint,
 * so node `b` NEVER launches. The executor deliberately does NOT re-persist the plan status after
 * node mutations, so the `'paused'` row written out-of-process survives to that checkpoint. Resume
 * then re-runs ONLY node `b` (node `a` is terminal `success` → skipped), proving the pause stopped
 * the plan at exactly the right place and nothing was executed twice.
 * ============================================================================================== */

/** Scenario 3's two COUNTABLE GREEN probes (node `a`, then node `b` depending on it). */
const MIDRUN_BUDGET_A = '预留预算A';
const MIDRUN_BUDGET_B = '预留预算B';

/** `POST /api/tasks/[id] { action:'pause'|'resume' }` (identity is cookie-only). */
function taskControlRequest(
  taskId: string,
  action: 'pause' | 'resume',
  sessionId: string,
): Promise<HttpResult<Envelope<TaskPlan>>> {
  return postJson<Envelope<TaskPlan>>(taskPost, taskUrl(taskId), { action }, {
    ctx: idCtx(taskId),
    sessionId,
  });
}

describe('[integration] POST /api/tasks/[id] pause — a MID-RUN pause stops the NEXT node', () => {
  it('6 — pausing WHILE node a runs halts node b (never executed); resume re-runs ONLY node b', async () => {
    const sessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
    const goal = '先预留预算A，再预留预算B';

    // The just-minted plan id (`runSubmitPlan` adopts the durable `AgentTask.id` as the plan id).
    let taskId: string | undefined;
    // The mid-run pause fires EXACTLY ONCE — during node 'a', after it executed but before the
    // executor considers node 'b' at its next checkpoint.
    let pauseIssued = false;
    let pauseStatus: number | undefined;

    const base = gatewayRunTool(sessionId, goal);
    // A per-node runner that still executes each node through the gateway (exactly like the seed
    // runner) — plus a one-shot, AWAITED mid-run pause so the 'paused' row is committed before the
    // node returns and the executor reaches node 'b'.
    const runTool = async (toolName: string, args: Record<string, unknown>) => {
      const outcome = await base(toolName, args);
      if (!pauseIssued) {
        pauseIssued = true;
        // Resolve the plan id: the FIRST `plan_update` snapshot (emitted for node 'a' before its
        // runner is invoked) carries the adopted id; fall back to the session's durable task row.
        const id = taskId ?? (await listTasksBySession(sessionId))[0]?.id;
        expect(id, 'the plan task id must be resolvable before node a returns').toBeDefined();
        const res = await taskControlRequest(id!, 'pause', sessionId);
        pauseStatus = res.status;
      }
      return outcome;
    };

    const result = await runSubmitPlan(
      DEMO_USER_ID,
      {
        goal,
        nodes: [
          budgetNode('a', MIDRUN_BUDGET_A, 1200),
          budgetNode('b', MIDRUN_BUDGET_B, 800, ['a']),
        ],
      },
      {
        sessionId,
        runTool,
        onPlanUpdate: (plan) => {
          taskId = plan.id;
        },
      },
    );

    const plan = result.data as TaskPlan | undefined;
    expect(plan).toBeDefined();

    // The REAL pause route accepted the out-of-process steering of a RUNNING plan.
    expect(pauseIssued).toBe(true);
    expect(pauseStatus).toBe(200);

    // The walk STOPPED at the pause checkpoint: node 'a' ran, node 'b' NEVER launched.
    expect(plan!.status).toBe('paused');
    expect(nodeStatusOf(plan!, 'a')).toBe('success');
    expect(nodeStatusOf(plan!, 'b')).toBe('pending');
    expect(await countBudgets(MIDRUN_BUDGET_A)).toBe(1);
    expect(await countBudgets(MIDRUN_BUDGET_B)).toBe(0);

    // Durable: the `AgentTask` row holds the pause (the source of truth `defaultPollControls` read).
    expect((await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: plan!.id } })).status).toBe(
      'paused',
    );

    // --- GET refresh: the reloaded plan carries per-node statuses (executed / never-started).
    const reloaded = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(plan!.id), {
      ctx: idCtx(plan!.id),
      sessionId,
    });
    expect(reloaded.status).toBe(200);
    const refreshed = payload(reloaded);
    expect(refreshed.status).toBe('paused');
    expect(nodeStatusOf(refreshed, 'a')).toBe('success');
    expect(nodeStatusOf(refreshed, 'b')).toBe('pending');

    // Capture node 'a's row NOW — resume must skip it (the SAME row, never a second one).
    const budgetABefore = await getTestPrisma().budget.findFirstOrThrow({
      where: { userId: DEMO_USER_ID, name: MIDRUN_BUDGET_A },
    });

    // --- RESUME through the REAL route: it re-runs the plan through the PRODUCTION runner (NOT the
    // pause wrapper), so node 'a' (terminal `success`) is skipped and node 'b' (GREEN) executes.
    const resumedRes = await taskControlRequest(plan!.id, 'resume', sessionId);
    expect(resumedRes.status).toBe(200);
    const resumed = payload(resumedRes);
    expect(resumed.status).toBe('success');
    expect(nodeStatusOf(resumed, 'a')).toBe('success');
    expect(nodeStatusOf(resumed, 'b')).toBe('success');

    // node 'a' was NOT re-executed (exactly ONE Budget A row — and it is the SAME row); node 'b' ran
    // exactly once.
    expect(await countBudgets(MIDRUN_BUDGET_A)).toBe(1);
    const budgetAAfter = await getTestPrisma().budget.findFirstOrThrow({
      where: { userId: DEMO_USER_ID, name: MIDRUN_BUDGET_A },
    });
    expect(budgetAAfter.id).toBe(budgetABefore.id);
    expect(await countBudgets(MIDRUN_BUDGET_B)).toBe(1);

    // Durable: the plan row settled `success`.
    expect((await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: plan!.id } })).status).toBe(
      'success',
    );
  });
});

/* ============================================================================================== *
 * SCENARIO 4 — IDENTITY stays COOKIE-ONLY on the routes `identity-http.test.ts` does not cover
 * ============================================================================================== *
 * `./identity-http.test.ts` already pins the missing / unknown / foreign-COOKIE failures and the
 * forged `?sessionId=`/`?userId=` query on CONFIRM. This scenario closes the remaining hole: on
 * `POST /api/actions/[id]/verify`, `…/cancel`, `POST /api/tasks/[id]` and
 * `POST /api/security/reset` a query param must NEVER authenticate and must NEVER widen a foreign
 * cookie to the owning session.
 *
 * Every route derives identity SOLELY from the trusted `banking_session` cookie
 * (`app/api/_lib/session#requireIdentity`); the query string is never consulted. The VICTIM is a
 * fresh persisted session that OWNS both a chat-parked YELLOW transfer and a durable gated task; a
 * FOREIGN cookie is a DIFFERENT valid session that owns neither. The regression: a forged
 * `?sessionId=<victim>` (with or without a cookie) must leave the victim's action `pending`, its
 * plan `waiting_confirmation` and its breaker LOCKED — never settle or unlock anything.
 * ============================================================================================== */

/** The COUNTABLE GREEN probe of the victim task (one `Budget` row ⇒ the plan walked node v1). */
const VICTIM_BUDGET = '预留预算V';

/** Per-call identity + an optional RAW query string (to forge `?sessionId=` / `?userId=`). */
interface ForgeOpts {
  sessionId?: string;
  query?: string;
  /** MFA code for the verify invoker (defaults to the mock code; the wrong-code probe overrides it). */
  code?: string;
}

/** Append a raw query string to a path (`undefined` ⇒ no query). */
function appendQuery(path: string, query?: string): string {
  return query ? `${path}?${query}` : path;
}

/** `POST /api/actions/[id]/verify` — cookie-only identity + an optional forged query string. */
function verifyCall(id: string, opts: ForgeOpts = {}) {
  return postJson<Envelope<ActionResponse>>(
    verifyPost,
    appendQuery(actionUrl(id, 'verify'), opts.query),
    { code: opts.code ?? MFA_CODE },
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

/** `POST /api/actions/[id]/cancel` — cookie-only identity + an optional forged query string. */
function cancelCall(id: string, opts: ForgeOpts = {}) {
  return postJson<Envelope<ActionResponse>>(
    cancelPost,
    appendQuery(actionUrl(id, 'cancel'), opts.query),
    {},
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

/** `POST /api/tasks/[id]` execution control — cookie-only identity + an optional forged query. */
function taskControlCall(
  id: string,
  action: 'pause' | 'resume' | 'cancel' | 'retry',
  opts: ForgeOpts = {},
) {
  return postJson<Envelope<TaskPlan>>(
    taskPost,
    appendQuery(taskUrl(id), opts.query),
    { action },
    { ctx: idCtx(id), sessionId: opts.sessionId },
  );
}

/** `POST /api/security/reset` (single-arg handler) — cookie-only identity + an optional forged query. */
function resetCall(opts: ForgeOpts = {}) {
  return postJson<Envelope<ResetData>>(resetPost, appendQuery('/api/security/reset', opts.query), {}, {
    sessionId: opts.sessionId,
  });
}

/**
 * `POST /api/security/reset` with NO body at all — the route folds an ABSENT/empty body into `{}`
 * (`app/api/_lib/http.ts#parseOptionalBody`), so this exercises the "no code supplied" unlock gate.
 */
function resetCallNoBody(opts: ForgeOpts = {}) {
  return postRaw<Envelope<ResetData>>(
    resetPost,
    appendQuery('/api/security/reset', opts.query),
    '',
    { sessionId: opts.sessionId },
  );
}

/** `POST /api/security/reset { verificationCode }` — supply an explicit (correct or WRONG) code. */
function resetCallWithCode(code: string, opts: ForgeOpts = {}) {
  return postJson<Envelope<ResetData>>(
    resetPost,
    appendQuery('/api/security/reset', opts.query),
    { verificationCode: code },
    { sessionId: opts.sessionId },
  );
}

/**
 * A fresh VICTIM session that OWNS both a chat-parked YELLOW transfer and a durable GATED task, plus
 * a FOREIGN valid session that owns neither. Both resources belong to the SAME victim session, so a
 * forged query (or cookie) that slipped past identity would be directly observable.
 */
async function seedVictim(): Promise<{
  victim: string;
  foreign: string;
  actionId: string;
  taskId: string;
}> {
  const victim = (await getOrCreateSession(DEMO_USER_ID)).sessionId;

  // 1) Park a YELLOW ¥200 transfer through the REAL chat route — the victim's ONLY parked action yet.
  const turn = await chatTurn('给张伟转200元', victim);
  expect(turn.sessionId, 'the chat turn must reuse the victim session').toBe(victim);
  const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId: victim } });
  expect(action.toolName).toBe('transfer_money');
  expect(action.riskLevel).toBe('YELLOW');
  expect(action.status).toBe('pending');

  // 2) Seed a durable, GATED task owned by the SAME victim session (via the production runner).
  const goal = '先预留预算V，再给张伟转200元';
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    { goal, nodes: [budgetNode('v1', VICTIM_BUDGET, 1200), transferNode('v2', PARKED_AMOUNT, ['v1'])] },
    { sessionId: victim, runTool: gatewayRunTool(victim, goal) },
  );
  const plan = result.data as TaskPlan | undefined;
  expect(plan, `runSubmitPlan produced no plan: ${result.error}`).toBeDefined();
  expect(plan!.status).toBe('waiting_confirmation');
  expect(nodeStatusOf(plan!, 'v1')).toBe('success');
  expect(nodeStatusOf(plan!, 'v2')).toBe('waiting_confirmation');
  expect(await countBudgets(VICTIM_BUDGET)).toBe(1);

  // 3) A DIFFERENT valid session that owns neither the action nor the task.
  const foreign = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
  expect(foreign).not.toBe(victim);

  return { victim, foreign, actionId: action.id, taskId: plan!.id };
}

/** The victim's action / plan / money are UNAFFECTED by a rejected identity. */
async function expectVictimUntouched(before: {
  victim: string;
  actionId: string;
  taskId: string;
}): Promise<void> {
  const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: before.actionId } });
  expect(action.status, 'the victim parked action must stay pending').toBe('pending');
  const task = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: before.taskId } });
  expect(task.status, 'the victim plan must stay parked').toBe('waiting_confirmation');
  expect(await checkingBalance()).toBe(SEEDED_BALANCE);
  expect(await transfersTo(RECIPIENT.id)).toHaveLength(0);
  // Auditing is decided by the SIDE EFFECT, not the permission colour, so the victim's own GREEN
  // `reserve_budget` (task node v1) IS audited. The rejected identity attempts must therefore add
  // NOTHING: that single write audit is the session's entire audit history, and no denied operation
  // is ever audited under the victim's session.
  const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId: before.victim } });
  expect(audits.map((row) => row.toolName), 'a rejected identity attempt must write no audit').toEqual(['reserve_budget']);
}

describe('[integration] identity — a query param NEVER authenticates on verify/cancel/tasks/reset', () => {
  it('7 — NO cookie + a forged ?sessionId=<victim>&userId=<victim> on verify/cancel/tasks/reset is 403 everywhere and leaves the victim untouched', async () => {
    const before = await seedVictim();
    // Both forged params carry the CORRECT owning session id (plus a victim-valued user id), yet NO
    // cookie is sent — every write/auth route must still fail closed.
    const forged = `sessionId=${encodeURIComponent(before.victim)}&userId=${encodeURIComponent(before.victim)}`;

    expectDenied(await verifyCall(before.actionId, { query: forged }));
    expectDenied(await cancelCall(before.actionId, { query: forged }));
    expectDenied(await taskControlCall(before.taskId, 'pause', { query: forged }));
    expectDenied(await resetCall({ query: forged }));

    await expectVictimUntouched(before);
  });

  it('8 — a FOREIGN valid cookie + a forged ?sessionId=<victim> query is 403 on verify/cancel/tasks and leaves the victim untouched', async () => {
    const before = await seedVictim();
    const query = `sessionId=${encodeURIComponent(before.victim)}`;

    // A real cookie authenticates the FOREIGN session, but ownership still rejects settling the
    // victim's action / controlling its task — the forged query can never widen it.
    expectDenied(await verifyCall(before.actionId, { sessionId: before.foreign, query }));
    expectDenied(await cancelCall(before.actionId, { sessionId: before.foreign, query }));
    expectDenied(await taskControlCall(before.taskId, 'cancel', { sessionId: before.foreign, query }));

    await expectVictimUntouched(before);
  });

  it('9 — /api/security/reset: a forged ?sessionId=<victim> query never unlocks the VICTIM session', async () => {
    // The victim owns a RED parked transfer, so its breaker CAN trip.
    const victim = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
    const turn = await chatTurn('给张伟转5000元', victim);
    expect(turn.sessionId).toBe(victim);
    const actionId = (
      await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId: victim } })
    ).id;

    // Trip the VICTIM breaker through the REAL verify route with the victim's OWN cookie.
    for (let attempt = 0; attempt < MFA_MAX_ATTEMPTS; attempt += 1) {
      const res = await verifyCall(actionId, { sessionId: victim, code: '000000' });
      expect(res.status).toBe(200);
    }
    expect((await security.circuitBreaker.getState(victim)).locked, 'the victim breaker must be tripped').toBe(
      true,
    );

    const resetEventsFor = (sessionId: string) =>
      getTestPrisma().securityEvent.count({ where: { sessionId, kind: 'SECURITY_RESET' } });

    // (a) NO cookie + a forged ?sessionId=<victim>: the forged query authenticates NOTHING (403) and
    // the victim stays locked with no reset event.
    const forged = `sessionId=${encodeURIComponent(victim)}`;
    expectDenied(await resetCall({ query: forged }));
    expect((await security.circuitBreaker.getState(victim)).locked).toBe(true);
    expect(await resetEventsFor(victim)).toBe(0);

    // (b) A FOREIGN valid cookie + the same forged query: identity is cookie-only, so the route acts as
    // the CALLER's own session — but that SAME user's breaker is LOCKED, so the gated unlock REFUSES.
    const foreign = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
    expect(foreign).not.toBe(victim);
    const foreignRes = await resetCall({ sessionId: foreign, query: forged });
    expect(foreignRes.status).toBe(423);
    expect(foreignRes.data?.ok).toBe(false);
    expect(foreignRes.data?.error?.code).toBe('CIRCUIT_OPEN');
    expect(await resetEventsFor(foreign)).toBe(0);

    // (b') The VICTIM's OWN valid cookie + the same forged ?sessionId=<victim> query: identity is
    // cookie-only, so the route acts as the locked account and the gated unlock still REFUSES
    // (423 CIRCUIT_OPEN) — the forged query unlocked NOTHING. A lock clears ONLY through a verified
    // security-center code, never via the caller-controlled query string.
    const victimOwnReset = await resetCall({ sessionId: victim, query: forged });
    expect(victimOwnReset.status).toBe(423);
    expect(victimOwnReset.data?.ok).toBe(false);
    expect(victimOwnReset.data?.error?.code).toBe('CIRCUIT_OPEN');

    // The VICTIM session was NEVER unlocked: still locked, still zero reset events, and an end-to-end
    // probe proves the lock still denies even the CORRECT mock MFA code.
    expect((await security.circuitBreaker.getState(victim)).locked).toBe(true);
    expect(await resetEventsFor(victim)).toBe(0);
    const probe = await verifyCall(actionId, { sessionId: victim, code: MFA_CODE });
    expect(probe.status).toBe(200);
    const probeData = payload(probe);
    expect(probeData.ok).toBe(false);
    expect(probeData.status).toBe('locked');

    // Fail-closed: the ¥5000 transfer never moved and no audit row was written for the victim.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await transfersTo(RECIPIENT.id)).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: victim } })).toBe(0);

    // (c) The GATED unlock's POSITIVE path: the deliberate security-center action supplies the mock
    // strong-verification code, so the OWNER finally clears. The REAL HTTP reset route accepts the
    // same OPTIONAL `verificationCode` (pinned end-to-end in the dedicated unlock-gate suite below);
    // here the same `@/security` facade the route delegates to is invoked directly to prove the
    // unlock is PER USER — clearing it releases BOTH of the user's sessions at once.
    const unlocked = await security.circuitBreaker.resetSession(victim, { verificationCode: MFA_CODE });
    expect(unlocked.locked).toBe(false);
    expect(unlocked.failures).toBe(0);
    expect((await security.circuitBreaker.getState(victim)).locked).toBe(false);
    expect((await security.circuitBreaker.getState(foreign)).locked).toBe(false);
    const resets = await getTestPrisma().securityEvent.findMany({ where: { kind: 'SECURITY_RESET' } });
    expect(resets).toHaveLength(1);
    expect(resets[0]!.sessionId).toBe(victim);
    expect(resets[0]!.userId).toBe(DEMO_USER_ID);

    expectNoMfaLeak(
      'Scenario 4 / it 9',
      foreignRes.data,
      foreignRes.data?.data,
      probe.data,
      probe.data?.data,
    );
  });
});

/* ============================================================================================== *
 * SCENARIO 5 — the AUDITED UNLOCK GATE on the REAL `POST /api/security/reset` route (ISSUE 2)
 * ============================================================================================== *
 * An auditor flagged that a bare session cookie must NEVER clear a tripped breaker. This suite pins
 * the gate at the HTTP layer: the `banking_session` cookie authenticates the CALLER, but the unlock
 * itself is decided in code by `security/circuit-breaker.ts#resetSession` — while the OWNER is
 * LOCKED it REQUIRES a correct mock `verificationCode` (`MFA_CODE`) OR an elapsed cooldown, else it
 * THROWS `AppError('CIRCUIT_OPEN')` → HTTP 423 and the lock is LEFT INTACT (no `SECURITY_RESET`
 * event). The route folds an ABSENT/empty body into `{}` (`_lib/http#parseOptionalBody`), so a
 * code-less POST is exactly what a bare cookie can send; when the owner is NOT locked no code is
 * required. The breaker is PER USER, so clearing it releases ALL of the owner's sessions at once.
 * ============================================================================================== */

/** Park a RED (MFA) transfer and trip the owner's breaker with `MFA_MAX_ATTEMPTS` WRONG codes. */
async function lockOwner(): Promise<{ sessionId: string; actionId: string }> {
  const sessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;

  // A ¥5000 transfer exceeds `DAILY_TRANSFER_LIMIT` ⇒ RED at park time, so it awaits the mock code.
  const turn = await chatTurn('给张伟转5000元', sessionId);
  expect(turn.sessionId, 'the chat turn must reuse the session').toBe(sessionId);
  const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId } });
  expect(action.toolName).toBe('transfer_money');
  expect(action.riskLevel, 'a ¥5000 transfer is RED at park time').toBe('RED');

  // Trip the breaker through the REAL verify route with the OWNER's OWN cookie (3 consecutive
  // failures). The demo clock is FIXED, so the cooldown never elapses — a code is REQUIRED to clear.
  for (let attempt = 0; attempt < MFA_MAX_ATTEMPTS; attempt += 1) {
    const res = await verifyCall(action.id, { sessionId, code: '000000' });
    expect(res.status, 'a wrong MFA code returns a normal 200 envelope').toBe(200);
  }
  expect((await security.circuitBreaker.getState(sessionId)).locked, 'the owner must be locked').toBe(true);

  return { sessionId, actionId: action.id };
}

/** Count the `SECURITY_RESET` audit events recorded for a session. */
function countResetEvents(sessionId: string): Promise<number> {
  return getTestPrisma().securityEvent.count({ where: { sessionId, kind: 'SECURITY_RESET' } });
}

describe('[integration] POST /api/security/reset — the AUDITED unlock gate (ISSUE 2)', () => {
  it('10 — while LOCKED, a body-less reset is REFUSED (423 CIRCUIT_OPEN) and leaves the lock intact', async () => {
    const { sessionId } = await lockOwner();

    const res = await resetCallNoBody({ sessionId });
    expect(res.status).toBe(423);
    expect(res.data?.ok).toBe(false);
    expect(res.data?.error?.code).toBe('CIRCUIT_OPEN');

    // Fail-closed: the lock is LEFT INTACT and NO `SECURITY_RESET` event was written.
    expect((await security.circuitBreaker.getState(sessionId)).locked).toBe(true);
    expect(await countResetEvents(sessionId)).toBe(0);

    expectNoMfaLeak('Scenario 5 / it 10', res.data, res.data?.data);
  });

  it('11 — while LOCKED, a WRONG verificationCode is REFUSED (423 CIRCUIT_OPEN) and leaves the lock intact', async () => {
    const { sessionId } = await lockOwner();
    const wrong = '000000';
    expect(wrong).not.toBe(MFA_CODE);

    const res = await resetCallWithCode(wrong, { sessionId });
    expect(res.status).toBe(423);
    expect(res.data?.ok).toBe(false);
    expect(res.data?.error?.code).toBe('CIRCUIT_OPEN');

    expect((await security.circuitBreaker.getState(sessionId)).locked).toBe(true);
    expect(await countResetEvents(sessionId)).toBe(0);

    expectNoMfaLeak('Scenario 5 / it 11', res.data, res.data?.data);
  });

  it('12 — while LOCKED, the CORRECT verificationCode unlocks (200, audited exactly once, per owner)', async () => {
    const { sessionId } = await lockOwner();
    // A SECOND session of the SAME owner proves the breaker (and the unlock) is PER USER.
    const sibling = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
    expect(sibling).not.toBe(sessionId);
    expect(
      (await security.circuitBreaker.getState(sibling)).locked,
      'the lock is shared across the owner’s sessions',
    ).toBe(true);
    expect(await countResetEvents(sessionId)).toBe(0);

    const res = await resetCallWithCode(MFA_CODE, { sessionId });
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.sessionId).toBe(sessionId);
    expect(data.locked).toBe(false);
    expect(data.failures).toBe(0);

    // Unlocked for BOTH of the owner's sessions.
    expect((await security.circuitBreaker.getState(sessionId)).locked).toBe(false);
    expect((await security.circuitBreaker.getState(sibling)).locked).toBe(false);

    // EXACTLY ONE `SECURITY_RESET` event, attributed to the locked owner.
    const resets = await getTestPrisma().securityEvent.findMany({ where: { kind: 'SECURITY_RESET' } });
    expect(resets).toHaveLength(1);
    expect(resets[0]!.sessionId).toBe(sessionId);
    expect(resets[0]!.userId).toBe(DEMO_USER_ID);

    expectNoMfaLeak('Scenario 5 / it 12', res.data, res.data?.data);
  });

  it('13 — while NOT locked, a body-less reset SUCCEEDS (the code is required only while locked)', async () => {
    // A fresh session on a freshly-seeded DB: no breaker state ⇒ nothing to unlock ⇒ no code needed.
    const sessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
    expect((await security.circuitBreaker.getState(sessionId)).locked).toBe(false);

    const res = await resetCallNoBody({ sessionId });
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.locked).toBe(false);
    expect(data.failures).toBe(0);

    expectNoMfaLeak('Scenario 5 / it 13', res.data, res.data?.data);
  });
});

/**
 * tests/app/mfa-terminal-lock-http.test.ts — SERVER/HTTP side of the transfer/MFA "popup-loop" fix.
 *
 * THE BUG: exhausting the MFA attempt limit (or hitting an already-open circuit breaker) used to make
 * the security gateway return the terminal `locked` outcome WITHOUT persisting it, so the
 * `PendingAction` row stayed `pending`/`awaiting_mfa`. `GET /api/actions#attentionFor` therefore kept
 * surfacing the row as a pending decision, and the agent bridge (`nextPlanDecision` / `withPlanUpdate`)
 * re-emitted `mfa_required` for the SAME actionId — the MFA popup reappeared forever on a
 * plan-parked transfer.
 *
 * THE FIX (already at HEAD): `security/security-gateway.ts` now persists `status:'locked'` via a
 * race-safe CAS (`pending`/`awaiting_mfa` → `locked`) on BOTH terminal lock branches — the
 * MFA-attempt-limit path (`authorizeWithMfa`) and the circuit-breaker gate (`authorizeAction`) — and
 * `app/api/actions/[id]/verify` maps a `locked` outcome to `mfaResult:'failed'`.
 *
 * These specs drive the REAL Next.js route handlers (`POST /api/actions/[id]/verify`, `GET
 * /api/actions`) with real `NextRequest` objects (`./harness.ts`) and the real SQLite test DB. The
 * plan-parked RED transfer is seeded through the PRODUCTION `submit_plan` runner (exactly as
 * `./plan-linkage-http.test.ts`) so the action carries its `taskId`/`nodeId` LINK — the precondition
 * for the `nextPlanDecision` re-prompt the fix had to silence. Only the MODEL is scripted
 * (`tests/setup.ts` forces `LLM_MODE=mock`). Offline, no network, no fake timers.
 *
 * Deterministic DB lifecycle: `resetDatabase()` before each test (which also clears the durable,
 * OWNER-scoped breaker state), `disconnectTestPrisma()` after.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as actionsGet } from '@/app/api/actions/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import type { ActionResponse, SurfacedPendingAction } from '@/app/api/_lib/types';
import { executeGatedTool, readPendingActionId } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { TaskNodeResult, TaskPlan } from '@/lib/contracts/task';
import { MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { centsToMoney, normalizeMoney } from '@/lib/money';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, getJson, idCtx, postJson, type HttpResult } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (¥23,580) — the account a parked transfer would debit. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** Recipient 张伟 — resolves unambiguously from the seeded contacts. */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The seeded checking balance (¥23,580) — a refused transfer must never move it. */
const SEEDED_BALANCE = normalizeMoney(CHECKING.balance);

/** The recipient name used to seed the plan's transfer node. */
const RECIPIENT_NAME = '张伟';
/** A transfer ABOVE the ¥1,000 confirmation-only limit ⇒ RED ⇒ parked awaiting strong verification. */
const RED_AMOUNT = '5000';
/** The single node id used by every seeded plan in this spec. */
const NODE_ID = 'n1';
/** A WRONG MFA code (the mock correct code is `MFA_CODE`, imported from `@/lib/constants`). */
const WRONG_CODE = '000000';

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

/** Assert the literal mock MFA code never leaks into a response body we captured. */
function expectNoMfaLeak(label: string, ...bodies: unknown[]): void {
  for (const body of bodies) {
    expect(JSON.stringify(body), `${label}: the MFA code leaked into a response body`).not.toContain(
      MFA_CODE,
    );
  }
}

/* -------------------------------------------------------------------------- event narrowing */

type MfaEvent = Extract<AgentStreamEvent, { type: 'mfa_required' }>;

/**
 * Every re-prompting `mfa_required` event for `actionId` in a continuation-events array.
 *
 * THE POPUP-LOOP PROBE: after the action is locked this MUST stay empty — a non-empty result is
 * exactly the regression the fix closed (the bridge re-asking for a code on a terminal action).
 */
function mfaEventsFor(events: readonly AgentStreamEvent[], actionId: string): MfaEvent[] {
  return events.filter(
    (event): event is MfaEvent => event.type === 'mfa_required' && event.actionId === actionId,
  );
}

/* -------------------------------------------------------------------------------- invokers */

/** Drive the real verify route with the given code and the demo-session cookie. */
function verifyAction(
  id: string,
  code: string,
  sessionId: string,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(verifyPost, actionUrl(id, 'verify'), { code }, {
    ctx: idCtx(id),
    sessionId,
  });
}

/** `GET /api/actions` for the demo session — the actions the UI would surface as pending. */
async function surfaced(sessionId: string): Promise<SurfacedPendingAction[]> {
  const res = await getJson<Envelope<SurfacedPendingAction[]>>(actionsGet, '/api/actions', {
    sessionId,
  });
  expect(res.status).toBe(200);
  return payload(res);
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

/** The RED `transfer_money` node (> ¥1000 ⇒ parks awaiting strong verification, never executes). */
function transferNode(id: string, amount: string): SeedNode {
  return {
    id,
    name: `给${RECIPIENT_NAME}转账`,
    dependencies: [],
    kind: 'tool',
    tool: 'transfer_money',
    args: { name: RECIPIENT_NAME, amount },
  };
}

/** The canonical demo session used by the HTTP entry (also the breaker OWNER key). */
async function demoSessionId(): Promise<string> {
  return (await getDemoSession(DEMO_USER_ID)).sessionId;
}

/**
 * The gateway-authorized per-node runner. It MUST forward the node identity (`ctx.taskId`/
 * `ctx.nodeId`) — that is what scopes the parked action to its node (the plan LINK) and is the
 * precondition for the `nextPlanDecision` re-prompt this spec guards against.
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

/** The model-free `submit_plan` outcome (its persisted plan snapshot lives under `data`). */
type PlanResult = Awaited<ReturnType<typeof runSubmitPlan>>;

/** Assert the runner succeeded and return its persisted plan snapshot. */
function planOf(result: PlanResult): TaskPlan {
  expect(result.ok, `runSubmitPlan produced no plan: ${result.error}`).toBe(true);
  return result.data as TaskPlan;
}

/** The recorded `TaskNodeResult` for a node id (throws when absent — a missing node is a bug). */
function resultOf(plan: TaskPlan, nodeId: string): TaskNodeResult {
  const result = plan.results.find((candidate) => candidate.id === nodeId);
  expect(result, `plan ${plan.id} has no node '${nodeId}'`).toBeDefined();
  return result!;
}

/**
 * Seed a plan whose single `transfer_money` node (> ¥1000) is PARKED awaiting strong verification,
 * through the PRODUCTION `submit_plan` runner. Returns the plan id and the parked action id.
 */
async function parkRedTransfer(
  sessionId: string,
  goal: string,
): Promise<{ taskId: string; actionId: string }> {
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    { goal, nodes: [transferNode(NODE_ID, RED_AMOUNT)] },
    { sessionId, runTool: gatewayRunTool(sessionId, goal) },
  );
  const plan = planOf(result);
  expect(plan.status).toBe('waiting_confirmation');
  const actionId = readPendingActionId(resultOf(plan, NODE_ID).output);
  expect(typeof actionId, 'the RED node must park a PendingAction').toBe('string');
  return { taskId: plan.id, actionId: actionId! };
}

/* ------------------------------------------------------------------------------------ probes */

/** The persisted `PendingAction` row (throws when absent — a missing action is a bug). */
function actionRow(actionId: string) {
  return getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
}

/** The seeded 活期 account's CURRENT balance (a refused transfer must leave it untouched). */
async function checkingBalance(): Promise<string> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return centsToMoney(account.balanceMinor);
}

/** Every ledger row paid to 张伟 (the money-moved-exactly-once probe). */
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

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] the MFA attempt limit makes the terminal lock DURABLE and stops the re-prompt', () => {
  it('[integration] 3 wrong codes on a plan-parked RED transfer persist status:locked, drop the action from GET /api/actions and refuse a further (even correct-code) attempt', async () => {
    const sessionId = await demoSessionId();
    const { taskId, actionId } = await parkRedTransfer(sessionId, `给${RECIPIENT_NAME}转${RED_AMOUNT}元（熔断）`);

    // --- Precondition: the RED transfer is PARKED awaiting strong verification, LINKED to its plan.
    const parkedRow = await actionRow(actionId);
    expect(parkedRow.status).toBe('awaiting_mfa');
    expect(parkedRow.riskLevel).toBe('RED');
    expect(parkedRow.requiresMfa).toBe(true);
    expect(parkedRow.toolName).toBe('transfer_money');
    expect(parkedRow.taskId).toBe(taskId);
    expect(parkedRow.nodeId).toBe(NODE_ID);

    // While undecided, GET /api/actions surfaces it as a DECISION (the popup's data source).
    const before = await surfaced(sessionId);
    expect(before.map((action) => action.id)).toContain(actionId);
    expect(before.find((action) => action.id === actionId)!.attention).toBe('decision');

    // --- Non-terminal failures: each wrong code below the limit keeps the row `awaiting_mfa` and the
    // action surfaced, so the SAME action can be retried.
    for (let attempt = 1; attempt < MFA_MAX_ATTEMPTS; attempt += 1) {
      const res = await verifyAction(actionId, WRONG_CODE, sessionId);
      expect(res.status).toBe(200);
      expect(payload(res).ok).toBe(false);
      expect(payload(res).status).toBe('awaiting_mfa');
      expect(payload(res).mfaResult).toBe('failed');
      expect((await actionRow(actionId)).status).toBe('awaiting_mfa');
      expect((await surfaced(sessionId)).find((action) => action.id === actionId)?.attention).toBe(
        'decision',
      );
    }

    // --- The FINAL wrong code exhausts `MFA_MAX_ATTEMPTS` ⇒ TERMINAL lock.
    const last = await verifyAction(actionId, WRONG_CODE, sessionId);
    expect(last.status).toBe(200);

    // (1) The verify response reports a TERMINAL lock as a FAILED verification, never `not_required`.
    expect(payload(last).ok).toBe(false);
    expect(payload(last).status).toBe('locked');
    expect(payload(last).mfaResult).toBe('failed');
    expect(payload(last).actionId).toBe(actionId);

    // (2) The lock is DURABLE on the row (the whole point of the fix).
    expect((await actionRow(actionId)).status).toBe('locked');

    // (3) NO re-prompting `mfa_required` for THAT actionId anywhere in the continuation events — the
    // plan is still forwarded so /agent refreshes WITHOUT reopening the popup.
    expect(mfaEventsFor(payload(last).events, actionId)).toHaveLength(0);
    expect(payload(last).events.some((event) => event.type === 'plan_update')).toBe(true);

    // (4) The locked row is NO LONGER surfaced as a pending decision.
    expect((await surfaced(sessionId)).map((action) => action.id)).not.toContain(actionId);

    // (5) A FURTHER attempt — even with the CORRECT code — stays refused: no execution, no money.
    const further = await verifyAction(actionId, MFA_CODE, sessionId);
    expect(further.status).toBe(200);
    expect(payload(further).ok).toBe(false);
    expect(payload(further).status).toBe('locked');
    expect(payload(further).mfaResult).toBe('failed');
    expect(mfaEventsFor(payload(further).events, actionId)).toHaveLength(0);
    expect((await actionRow(actionId)).status).toBe('locked');
    expect((await surfaced(sessionId)).map((action) => action.id)).not.toContain(actionId);

    // Fail-closed: no money moved and no terminal audit row was written.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId } })).toBe(0);

    expectNoMfaLeak('terminal-lock', last.data, further.data);
  });

  it('[integration] once the OWNER breaker is tripped, the circuit-breaker GATE persists the lock on a SECOND still-undecided plan action and never re-prompts', async () => {
    const sessionId = await demoSessionId();
    const first = await parkRedTransfer(sessionId, `给${RECIPIENT_NAME}转${RED_AMOUNT}元（计划一）`);
    const second = await parkRedTransfer(sessionId, `给${RECIPIENT_NAME}转${RED_AMOUNT}元（计划二）`);
    expect(second.actionId).not.toBe(first.actionId);
    expect(second.taskId).not.toBe(first.taskId);

    // Trip the OWNER-scoped breaker on action ONE (MFA_MAX_ATTEMPTS wrong codes).
    for (let attempt = 1; attempt <= MFA_MAX_ATTEMPTS; attempt += 1) {
      await verifyAction(first.actionId, WRONG_CODE, sessionId);
    }
    expect((await actionRow(first.actionId)).status).toBe('locked');
    // Action TWO is still undecided — it never consumed an attempt.
    expect((await actionRow(second.actionId)).status).toBe('awaiting_mfa');
    expect((await surfaced(sessionId)).map((action) => action.id)).toContain(second.actionId);

    // The circuit-breaker GATE now persists the lock on the SECOND action too — even with the CORRECT
    // code — because a correct code can never bypass an open breaker.
    const gated = await verifyAction(second.actionId, MFA_CODE, sessionId);
    expect(gated.status).toBe(200);
    expect(payload(gated).ok).toBe(false);
    expect(payload(gated).status).toBe('locked');
    expect(payload(gated).mfaResult).toBe('failed');
    expect((await actionRow(second.actionId)).status).toBe('locked');
    expect(mfaEventsFor(payload(gated).events, second.actionId)).toHaveLength(0);

    // NEITHER locked action is surfaced anymore.
    const ids = (await surfaced(sessionId)).map((action) => action.id);
    expect(ids).not.toContain(first.actionId);
    expect(ids).not.toContain(second.actionId);

    // Fail-closed: no money moved and no terminal audit row was written.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId } })).toBe(0);

    expectNoMfaLeak('gate-branch', gated.data);
  });
});

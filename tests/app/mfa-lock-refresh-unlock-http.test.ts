/**
 * tests/app/mfa-lock-refresh-unlock-http.test.ts — what a TERMINAL MFA lock looks like AFTER the
 * page is refreshed, and what the security-center UNLOCK must never do.
 *
 * TWO questions, ONE durable row state (`PendingAction.status = 'locked'`):
 *
 *  1. REFRESH / RESTORE consistency. The lock lives on the persisted row, so every public read model
 *     a page reload fetches (`GET /api/actions`, `/api/security`, `/api/tasks`, `/api/tasks/[id]`,
 *     `/api/chat/history`) must keep reporting the SAME terminal state and must NEVER re-surface the
 *     locked operation as an open decision, while still distinguishing it from a row that is merely
 *     `awaiting_mfa`. The reads must also be PURE (they may not touch the locked rows or add audits).
 *  2. INERT retries. A locked action refuses even the CORRECT code / a plain confirm, for good: no
 *     verification is reopened, no challenge, attempt, audit, security event, money or ledger row.
 *  3. UNLOCK never auto-executes. `POST /api/security/reset` clears the OWNER breaker (with the mock
 *     verification code) but does NOT reopen, confirm or execute the already-locked operation: the old
 *     row stays `locked`, the old id stays absent from the decision list, nothing moves, and a NEW
 *     request for the same business intent mints a NEW `PendingAction` the user must re-confirm.
 *
 * These specs drive the REAL Next.js route handlers with real `NextRequest` objects (`./harness.ts`)
 * against the real SQLite test DB. Preconditions come from `tests/helpers/locked-action.ts` (plan
 * parking through the production `submit_plan` runner + the gateway MFA ladder), so no fixture is
 * re-derived here. Only the MODEL is scripted (`tests/setup.ts` forces `LLM_MODE=mock`).
 *
 * TWO DELIBERATE DEVIATIONS from a literal reading of the requirement, both PRODUCTION FACTS (the
 * assertions below pin what the server actually returns, and are NOT weakened):
 *
 *  a. `GET /api/security#lock.reason` is the typed constant `'circuit_open'`
 *     (`app/api/security/route.ts#LOCKED_FAILURE`) — the account-level breaker reason. The per-action
 *     `'mfa_attempts_exhausted'` reason exists ONLY on the gateway's terminal lock decision
 *     (`security/security-gateway.ts#authorizeWithMfa`) and is therefore observable only in the
 *     immediate 3rd-wrong-code response, never in a read model. Group 2 pins that reason where it
 *     really is; group 1 pins the security center's actual mapping.
 *  b. The audited unlock records `SECURITY_RESET` as a `SecurityEvent` (NOT an `AuditLog` row):
 *     `AuditStatus` has no reset value and `security/circuit-breaker.ts#commitAuditedReset` writes a
 *     strict `SecurityEvent`. Group 3 asserts the exact `SECURITY_RESET` delta of 1 AND an `AuditLog`
 *     delta of 0 — the same "the unlock is audited exactly once, and it is not a command audit" fact.
 *
 * Deterministic DB lifecycle: `resetDatabase()` before each test (the circuit breaker is OWNER-scoped,
 * so a lock left behind would leak into the next test), `disconnectTestPrisma()` after.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import type { ActionResponse, SurfacedPendingAction } from '@/app/api/_lib/types';
import type { TaskPlanWithDecisionState } from '@/app/api/_lib/task-pending-actions';
import { GET as historyGet } from '@/app/api/chat/history/route';
import { POST as securityResetPost } from '@/app/api/security/reset/route';
import { GET as securityGet } from '@/app/api/security/route';
import { GET as taskGet } from '@/app/api/tasks/[id]/route';
import { GET as tasksGet } from '@/app/api/tasks/route';
import type { ChatCard } from '@/lib/contracts/agent';
import type { ChatHistoryPage } from '@/lib/contracts/chat-history';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import {
  CORRECT_MFA_CODE,
  auditLogCount,
  checkingBalance,
  demoSessionId,
  exhaustMfaAttempts,
  lockAction,
  mfaChallengesFor,
  parkConfirmOnlyTransfer,
  parkRedTransferPlan,
  pendingActionRow,
  securityEventsOfKind,
  submitMfaCode,
  transactionsCount,
} from '@/tests/helpers/locked-action';
import {
  actionUrl,
  getJson,
  idCtx,
  postJson,
  taskUrl,
  tasksUrl,
  type HttpResult,
} from './harness';

/* --------------------------------------------------------------------------------- constants */

/** The single node id every seeded plan uses (`tests/helpers/locked-action.ts`). */
const NODE_ID = 'n1';
/** A distinct plan goal per parked action — the recipient/amount live in the node args. */
const goalFor = (tag: string): string => `转账 5000 元（${tag}）`;

/** The route's JSON envelope (transport shape, declared structurally — not a domain contract). */
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/* ------------------------------------------------------------------------- envelope helpers */

/** Success protocol helper: assert the envelope and return its payload. */
function payload<T>(res: HttpResult<Envelope<T>>): T {
  expect(res.data?.ok, `expected success envelope, got ${JSON.stringify(res.data)}`).toBe(true);
  return res.data!.data as T;
}

/* --------------------------------------------------------------------------------- invokers */

/** `GET /api/actions` — the decisions the UI would surface (open decisions only). */
async function surfaced(sessionId: string): Promise<SurfacedPendingAction[]> {
  const res = await getJson<Envelope<SurfacedPendingAction[]>>(actionsGet, '/api/actions', { sessionId });
  expect(res.status).toBe(200);
  return payload(res);
}

/** `GET /api/security` — the security-center read model (breaker state + terminal locked actions). */
async function securityCenter(sessionId: string): Promise<SecurityCenter> {
  const res = await getJson<Envelope<SecurityCenter>>(securityGet, '/api/security', { sessionId });
  expect(res.status).toBe(200);
  return payload(res);
}

/** `GET /api/tasks` — every plan of the session, newest first, with additive decision state. */
async function taskPlans(sessionId: string): Promise<TaskPlanWithDecisionState[]> {
  const res = await getJson<Envelope<{ plans: TaskPlanWithDecisionState[] }>>(tasksGet, tasksUrl(), {
    sessionId,
  });
  expect(res.status).toBe(200);
  return payload(res).plans;
}

/** `GET /api/tasks/[id]` — ONE plan, with the same additive decision state. */
async function oneTaskPlan(sessionId: string, taskId: string): Promise<TaskPlanWithDecisionState> {
  const res = await getJson<Envelope<TaskPlanWithDecisionState>>(taskGet, taskUrl(taskId), {
    ctx: idCtx(taskId),
    sessionId,
  });
  expect(res.status).toBe(200);
  return payload(res);
}

/** `GET /api/chat/history` — the restored conversation the browser renders after a refresh. */
async function history(sessionId: string): Promise<ChatHistoryPage> {
  const res = await getJson<Envelope<ChatHistoryPage>>(historyGet, '/api/chat/history', { sessionId });
  expect(res.status).toBe(200);
  return payload(res);
}

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

/** Drive the real confirm route (it never submits a code) with the demo-session cookie. */
function confirmAction(id: string, sessionId: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(confirmPost, actionUrl(id, 'confirm'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

/* ------------------------------------------------------------------------ security read model */

/**
 * The `GET /api/security` payload, structurally. Declared locally so the assertions below read as the
 * transport facts they are (the route exports the same shape as `SecurityData`).
 */
interface SecurityCenter {
  circuitBreaker: { failures: number; max: number; locked: boolean };
  lock?: { code: string; reason: string };
  lockedActions: Array<{
    actionId: string;
    toolName: string;
    tier: string;
    requiresMfa: boolean;
    updatedAt: number;
  }>;
}

/* --------------------------------------------------------------------------- card narrowing */

type MfaCard = Extract<ChatCard, { type: 'mfa' }>;
type ConfirmationCard = Extract<ChatCard, { type: 'confirmation' }>;

/** Every card of every restored message. */
function cardsOf(page: ChatHistoryPage): ChatCard[] {
  return page.messages.flatMap((message) => message.cards ?? []);
}

/** The restored VERIFICATION record of an action (`mfa` card, top-level `status`). */
function mfaCardOf(page: ChatHistoryPage, actionId: string): MfaCard | undefined {
  return cardsOf(page).find(
    (card): card is MfaCard => card.type === 'mfa' && card.actionId === actionId,
  );
}

/** The restored plain-APPROVAL record of an action (`confirmation` card, status on `action`). */
function confirmationCardOf(
  page: ChatHistoryPage,
  actionId: string,
): ConfirmationCard | undefined {
  return cardsOf(page).find(
    (card): card is ConfirmationCard =>
      card.type === 'confirmation' && card.action.actionId === actionId,
  );
}

/**
 * The persisted status a `confirmation` card carries. `approvalCard` stamps it onto the summary
 * (`{ ...action, status }`), but `PendingActionSummary` does not declare the field, so read it
 * explicitly instead of widening the domain contract for a display record.
 */
function confirmationStatus(card: ConfirmationCard): string | undefined {
  return (card.action as PendingActionSummary & { status?: string }).status;
}

/* ----------------------------------------------------------------------------------- probes */

/** The durable state of one action row: the persisted status and its last-write instant. */
interface RowSnapshot {
  status: string;
  updatedAt: number;
}

/** Snapshot one `PendingAction` row (throws when the row vanished — that would be a bug). */
async function rowSnapshot(actionId: string): Promise<RowSnapshot> {
  const row = await pendingActionRow(actionId);
  expect(row, `action ${actionId} is not persisted`).not.toBeNull();
  return { status: row!.status, updatedAt: row!.updatedAt.getTime() };
}

/** Every persisted `MfaChallenge` status of one action, in creation order. */
async function mfaChallengeStates(actionId: string): Promise<string[]> {
  return (await mfaChallengesFor(actionId)).map((challenge) => challenge.status);
}

/**
 * The session's fail-closed counters: the shared "nothing moved" probe used by all three groups.
 *
 * Money, ledger, receipts, agent events, command audits, MFA challenges and the total security-event
 * count are the observable surface of ANY execution, reopen or re-prompt. A spec that asserts they
 * are unchanged proves the server refused instead of acting.
 */
interface LedgerSnapshot {
  balance: string;
  transactions: number;
  receipts: number;
  agentRunEvents: number;
  auditLogs: number;
  mfaChallenges: number;
  securityEvents: number;
  securityResets: number;
}

/** Read every fail-closed counter for a session plus the MFA-challenge count of the given actions. */
async function ledgerSnapshot(sessionId: string, actionIds: readonly string[]): Promise<LedgerSnapshot> {
  const challenges = await Promise.all(actionIds.map((id) => mfaChallengesFor(id)));
  const prisma = getTestPrisma();
  return {
    balance: await checkingBalance(),
    transactions: await transactionsCount(),
    receipts: await prisma.executionReceipt.count(),
    agentRunEvents: await prisma.agentRunEvent.count(),
    auditLogs: await auditLogCount(sessionId),
    mfaChallenges: challenges.reduce((total, rows) => total + rows.length, 0),
    securityEvents: (await prisma.securityEvent.findMany({ where: { sessionId } })).length,
    securityResets: (await securityEventsOfKind(sessionId, 'SECURITY_RESET')).length,
  };
}

/**
 * Assert NOTHING was executed, re-prompted or re-opened: no money, no ledger row, no execution
 * receipt, no agent event, no command audit and no new MFA challenge.
 *
 * The security-event count is deliberately NOT part of this probe (an unlock legitimately records
 * exactly one `SECURITY_RESET`); the callers assert that delta themselves.
 */
function expectNoSideEffects(label: string, before: LedgerSnapshot, after: LedgerSnapshot): void {
  expect(after.balance, `${label}: the balance moved`).toBe(before.balance);
  expect(after.transactions, `${label}: a ledger row was written`).toBe(before.transactions);
  expect(after.receipts, `${label}: an execution receipt appeared`).toBe(before.receipts);
  expect(after.agentRunEvents, `${label}: an agent event was written`).toBe(before.agentRunEvents);
  expect(after.auditLogs, `${label}: an audit row was written`).toBe(before.auditLogs);
  expect(after.mfaChallenges, `${label}: an MFA challenge appeared`).toBe(before.mfaChallenges);
}

/** {@link expectNoSideEffects} PLUS "not a single security event was written". */
function expectLedgerFrozen(label: string, before: LedgerSnapshot, after: LedgerSnapshot): void {
  expectNoSideEffects(label, before, after);
  expect(after.securityEvents, `${label}: a security event was written`).toBe(before.securityEvents);
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------- group 1: refresh / restore consistency */

describe('[integration] a terminal MFA lock survives a browser refresh', () => {
  it('[integration] every public read model keeps reporting the SAME lock and never re-surfaces the locked action', async () => {
    const sessionId = await demoSessionId();

    // THREE actions in ONE conversation, parked BEFORE the breaker trips (a tripped breaker denies
    // every later gated call, so ordering is part of the precondition):
    //  • `yellow`    — a confirmation-only transfer  ⇒ `confirmation` history card
    //  • `red`       — a RED transfer               ⇒ `mfa` history card
    //  • `survivor`  — a RED transfer that is NEVER submitted ⇒ stays `awaiting_mfa` (the control)
    const yellow = await parkConfirmOnlyTransfer('500');
    const red = await parkRedTransferPlan(goalFor('刷新-红色'));
    const survivor = await parkRedTransferPlan(goalFor('刷新-未锁定'));
    expect(new Set([yellow.actionId, red.actionId, survivor.actionId]).size).toBe(3);

    // (1) The RED action reaches the TERMINAL lock through the shared gateway ladder (three wrong
    //     codes), which also trips the OWNER-scoped breaker.
    await lockAction(red.actionId, sessionId);

    // (2) With the breaker OPEN, the gateway GATE refuses the still-undecided YELLOW action BEFORE any
    //     code is looked at, and persists the same terminal `locked` status on its row.
    const gated = await submitMfaCode(yellow.actionId, sessionId, CORRECT_MFA_CODE);
    expect(gated.status).toBe('locked');
    expect(gated.code).toBe('CIRCUIT_OPEN');
    expect(gated.failure?.reason).toBe('circuit_open');
    expect((await pendingActionRow(yellow.actionId))?.status).toBe('locked');

    // The control action was never submitted: it stays OPEN (and is the only still-open decision).
    expect((await pendingActionRow(survivor.actionId))?.status).toBe('awaiting_mfa');
    // The exhausted challenge is the durable evidence that the RED lock came from the attempt limit.
    expect(await mfaChallengeStates(red.actionId)).toEqual(['locked']);

    // Baseline for the PURITY check: re-reading must not write anything at all.
    const rows = {
      red: await rowSnapshot(red.actionId),
      yellow: await rowSnapshot(yellow.actionId),
      survivor: await rowSnapshot(survivor.actionId),
    };
    const baseline = await ledgerSnapshot(sessionId, [red.actionId, yellow.actionId, survivor.actionId]);

    /* ---------------------------------------------- refresh #1: exactly what a reload fetches */

    const actionsBefore = await surfaced(sessionId);
    const securityBefore = await securityCenter(sessionId);
    const plansBefore = await taskPlans(sessionId);
    const redPlanBefore = await oneTaskPlan(sessionId, red.taskId);
    const historyBefore = await history(sessionId);

    // --- (a) GET /api/actions: ONLY open decisions. Both locked rows are gone, the control remains.
    const surfacedIds = actionsBefore.map((action) => action.id);
    expect(surfacedIds).not.toContain(red.actionId);
    expect(surfacedIds).not.toContain(yellow.actionId);
    expect(surfacedIds).toContain(survivor.actionId);
    const control = actionsBefore.find((action) => action.id === survivor.actionId)!;
    expect(control.attention).toBe('decision');
    expect(control.status).toBe('awaiting_mfa');

    // --- (b) GET /api/security: the breaker is still open and BOTH terminal rows are facts.
    expect(securityBefore.circuitBreaker).toEqual({
      failures: MFA_MAX_ATTEMPTS,
      max: MFA_MAX_ATTEMPTS,
      locked: true,
    });
    // The security center reports the ACCOUNT-level breaker reason (`app/api/security/route.ts`
    // `LOCKED_FAILURE`), never the per-action attempt reason — see the file header, deviation (a).
    expect(securityBefore.lock).toEqual({ code: 'CIRCUIT_OPEN', reason: 'circuit_open' });
    const lockedActionIds = securityBefore.lockedActions.map((entry) => entry.actionId);
    expect(lockedActionIds).toContain(red.actionId);
    expect(lockedActionIds).toContain(yellow.actionId);
    expect(lockedActionIds).not.toContain(survivor.actionId);
    const redSummary = securityBefore.lockedActions.find((entry) => entry.actionId === red.actionId)!;
    expect(redSummary.toolName).toBe('transfer_money');
    expect(redSummary.tier).toBe('RED');
    expect(redSummary.requiresMfa).toBe(true);
    // The reported instant is the ROW's own last write (the lock), not a fabricated one.
    expect(redSummary.updatedAt).toBe(rows.red.updatedAt);

    // --- (c) GET /api/tasks + GET /api/tasks/[id]: the node keeps its id and reports the real status.
    const nodeOf = (plan: TaskPlanWithDecisionState) => plan.results.find((node) => node.id === NODE_ID)!;

    const redNode = nodeOf(plansBefore.find((plan) => plan.id === red.taskId)!);
    expect(redNode.pendingActionId).toBe(red.actionId);
    expect(redNode.pendingActionStatus).toBe('locked');
    expect(redNode.status).toMatch(/^waiting_/);
    const redPlanStatus = plansBefore.find((plan) => plan.id === red.taskId)!.status;
    expect(redPlanStatus).toBe('waiting_confirmation');

    const yellowNode = nodeOf(plansBefore.find((plan) => plan.id === yellow.taskId)!);
    expect(yellowNode.pendingActionId).toBe(yellow.actionId);
    expect(yellowNode.pendingActionStatus).toBe('locked');

    // The read model DISTINGUISHES the two statuses: the untouched action is still `awaiting_mfa`.
    const survivorNode = nodeOf(plansBefore.find((plan) => plan.id === survivor.taskId)!);
    expect(survivorNode.pendingActionId).toBe(survivor.actionId);
    expect(survivorNode.pendingActionStatus).toBe('awaiting_mfa');

    // The single-plan read model agrees with the list (same annotation, nothing stripped).
    expect(nodeOf(redPlanBefore).pendingActionStatus).toBe('locked');
    expect(nodeOf(redPlanBefore).pendingActionId).toBe(red.actionId);

    // --- (d) GET /api/chat/history: both card SHAPES carry their persisted terminal status.
    // The RED action was rendered as a verification request ⇒ `mfa` card with a TOP-LEVEL status.
    const redCard = mfaCardOf(historyBefore, red.actionId);
    expect(redCard, 'the locked RED action has no restored mfa card').toBeDefined();
    expect(redCard!.status).toBe('locked');
    // The YELLOW action was rendered as a plain approval ⇒ `confirmation` card, status on the action.
    const yellowCard = confirmationCardOf(historyBefore, yellow.actionId);
    expect(yellowCard, 'the locked YELLOW action has no restored confirmation card').toBeDefined();
    expect(confirmationStatus(yellowCard!)).toBe('locked');
    // The untouched action is still an OPEN verification request — verbatim, not downgraded.
    const controlCard = mfaCardOf(historyBefore, survivor.actionId);
    expect(controlCard, 'the awaiting_mfa action has no restored mfa card').toBeDefined();
    expect(controlCard!.status).toBe('awaiting_mfa');

    /* ------------------------------------- refresh #2: the SAME reads must be byte-stable */

    const actionsAgain = await surfaced(sessionId);
    const securityAgain = await securityCenter(sessionId);
    const plansAgain = await taskPlans(sessionId);
    const redPlanAgain = await oneTaskPlan(sessionId, red.taskId);
    const historyAgain = await history(sessionId);

    expect(actionsAgain).toEqual(actionsBefore);
    expect(securityAgain).toEqual(securityBefore);
    expect(plansAgain).toEqual(plansBefore);
    expect(redPlanAgain).toEqual(redPlanBefore);
    expect(historyAgain).toEqual(historyBefore);

    // --- PURITY: no GET wrote a row, an audit or an event; the locked rows were not touched.
    expect(await rowSnapshot(red.actionId)).toEqual(rows.red);
    expect(await rowSnapshot(yellow.actionId)).toEqual(rows.yellow);
    expect(await rowSnapshot(survivor.actionId)).toEqual(rows.survivor);
    expectLedgerFrozen('refresh', baseline, await ledgerSnapshot(sessionId, [
      red.actionId,
      yellow.actionId,
      survivor.actionId,
    ]));
    // Reading the security center did not re-prompt or re-audit the MFA requirement either.
    expect(await securityEventsOfKind(sessionId, 'mfa_required')).toHaveLength(0);
  }, 60000);
});

/* ------------------------------------------------- group 2: repeated submissions after the lock */

describe('[integration] repeated submissions after the lock are inert', () => {
  it('[integration] the correct code and a plain confirm both stay refused 200/ok:false/locked and write nothing', async () => {
    const sessionId = await demoSessionId();
    const red = await parkRedTransferPlan(goalFor('重复提交'));

    // Reach the TERMINAL lock through the shared ladder, keeping the per-attempt decisions so the
    // EXHAUSTION reason (which lives only on the gateway decision, never in a read model) is pinned.
    const ladder = await exhaustMfaAttempts(red.actionId, sessionId);
    expect(ladder.map((attempt) => attempt.status)).toEqual([
      'awaiting_mfa',
      'awaiting_mfa',
      'locked',
    ]);
    const terminal = ladder[ladder.length - 1]!;
    expect(terminal.code).toBe('CIRCUIT_OPEN');
    expect(terminal.failure?.code).toBe('MFA_LOCKED');
    expect(terminal.failure?.reason).toBe('mfa_attempts_exhausted');
    expect(terminal.failure?.attemptsUsed).toBe(MFA_MAX_ATTEMPTS);
    expect(terminal.failure?.attemptsLeft).toBe(0);
    expect((await pendingActionRow(red.actionId))?.status).toBe('locked');
    expect(await mfaChallengeStates(red.actionId)).toEqual(['locked']);

    const baseline = await ledgerSnapshot(sessionId, [red.actionId]);

    // Three CORRECT-code submissions and three plain confirms — all refused, none of them actionable.
    for (let attempt = 1; attempt <= MFA_MAX_ATTEMPTS; attempt += 1) {
      const res = await verifyAction(red.actionId, CORRECT_MFA_CODE, sessionId);
      expect(res.status, `verify #${attempt} must stay a 200 domain refusal`).toBe(200);
      const data = payload(res);
      expect(data.ok).toBe(false);
      expect(data.status).toBe('locked');
      expect(data.code).toBe('CIRCUIT_OPEN');
      expect(data.mfaResult).toBe('failed');
      // A re-attempt on an already-locked row reports the SESSION lock reason, not a fresh attempt.
      expect(data.failure?.reason).toBe('mfa_session_locked');
      expect(data.failure?.attemptsLeft).toBe(0);
      expect(data.attemptsLeft).toBe(0);
      expect(data.maxAttempts).toBe(MFA_MAX_ATTEMPTS);
      // No popup loop: the refusal never re-emits the verification prompt for this action.
      expect(
        data.events.filter((event) => event.type === 'mfa_required' && event.actionId === red.actionId),
      ).toHaveLength(0);
    }

    for (let attempt = 1; attempt <= MFA_MAX_ATTEMPTS; attempt += 1) {
      const res = await confirmAction(red.actionId, sessionId);
      expect(res.status, `confirm #${attempt} must stay a 200 domain refusal`).toBe(200);
      const data = payload(res);
      expect(data.ok).toBe(false);
      expect(data.status).toBe('locked');
      expect(data.code).toBe('CIRCUIT_OPEN');
      // Confirm submits no code, so no verification can fail here.
      expect(data.mfaResult).toBe('not_required');
      expect(data.failure?.reason).toBe('mfa_session_locked');
      expect(data.failure?.attemptsLeft).toBe(0);
      expect(
        data.events.filter((event) => event.type === 'mfa_required' && event.actionId === red.actionId),
      ).toHaveLength(0);
    }

    // Nothing was consumed, re-prompted, re-audited or executed by any of the six refusals.
    expect((await pendingActionRow(red.actionId))?.status).toBe('locked');
    expect(await mfaChallengeStates(red.actionId)).toEqual(['locked']);
    expect(await mfaChallengesFor(red.actionId)).toHaveLength(1);
    expect(await securityEventsOfKind(sessionId, 'mfa_required')).toHaveLength(0);
    expectLedgerFrozen('repeated-submissions', baseline, await ledgerSnapshot(sessionId, [red.actionId]));
  }, 60000);
});

/* ---------------------------------------- group 3: the unlock never auto-executes the old operation */

describe('[integration] the audited unlock never reopens or re-executes the locked operation', () => {
  it('[integration] POST /api/security/reset clears the breaker, keeps the row locked, and a NEW request mints a NEW action', async () => {
    const sessionId = await demoSessionId();
    const red = await parkRedTransferPlan(goalFor('解锁'));
    await lockAction(red.actionId, sessionId);

    const beforeRow = await rowSnapshot(red.actionId);
    const baseline = await ledgerSnapshot(sessionId, [red.actionId]);
    expect((await securityCenter(sessionId)).circuitBreaker.locked).toBe(true);

    // --- The gated, audited unlock. The mock verification code is the only accepted unlock input.
    const res = await postJson<Envelope<ResetPayload>>(securityResetPost, '/api/security/reset', {
      verificationCode: MFA_CODE,
    }, { sessionId });
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.sessionId).toBe(sessionId);
    expect(data.locked).toBe(false);
    expect(data.failures).toBe(0);
    expect(data.max).toBe(MFA_MAX_ATTEMPTS);
    // The route states, as data, that unlocking does not reopen anything (its first assertion here).
    expect(data.lockedActionsReopened).toBe(false);

    // --- Exactly ONE `SECURITY_RESET` audit fact, and NO command audit: the unlock is not a write.
    const afterReset = await ledgerSnapshot(sessionId, [red.actionId]);
    expect(
      afterReset.securityResets - baseline.securityResets,
      'the unlock must record exactly one SECURITY_RESET',
    ).toBe(1);
    expect(afterReset.securityEvents - baseline.securityEvents).toBe(1);
    // Every execution surface is still untouched by the unlock itself.
    expectNoSideEffects('unlock', baseline, afterReset);

    // --- The old operation is STILL terminal: no reopen, no re-prompt, no execution entry point.
    expect((await surfaced(sessionId)).map((action) => action.id)).not.toContain(red.actionId);
    const row = await pendingActionRow(red.actionId);
    expect(row?.status).toBe('locked');
    expect(row?.updatedAt.getTime()).toBe(beforeRow.updatedAt);
    expect(await mfaChallengeStates(red.actionId)).toEqual(['locked']);

    // The security center now reports NO lock reason, yet still lists the row as a locked FACT.
    const securityAfter = await securityCenter(sessionId);
    expect(securityAfter.circuitBreaker).toEqual({
      failures: 0,
      max: MFA_MAX_ATTEMPTS,
      locked: false,
    });
    expect(securityAfter.lock).toBeUndefined();
    expect(securityAfter.lockedActions.map((entry) => entry.actionId)).toContain(red.actionId);

    // The refreshed conversation agrees: the record is still `locked`, never a live panel source.
    const historyAfter = await history(sessionId);
    expect(mfaCardOf(historyAfter, red.actionId)?.status).toBe('locked');

    // --- A NEW request for the SAME business intent must be re-initiated and re-confirmed.
    const retry = await parkRedTransferPlan(goalFor('解锁后重新发起'));
    expect(retry.actionId).not.toBe(red.actionId);
    expect(retry.taskId).not.toBe(red.taskId);
    // The NEW action is OPEN (it needs its own code); the OLD one stays terminal.
    expect((await pendingActionRow(retry.actionId))?.status).toBe('awaiting_mfa');
    expect((await pendingActionRow(red.actionId))?.status).toBe('locked');
    const retryIds = (await surfaced(sessionId)).map((action) => action.id);
    expect(retryIds).toContain(retry.actionId);
    expect(retryIds).not.toContain(red.actionId);
    // Nothing was executed on the user's behalf: no money, ledger row or receipt appeared.
    expect(await checkingBalance()).toBe(baseline.balance);
    expect(await transactionsCount()).toBe(baseline.transactions);
    expect(await getTestPrisma().executionReceipt.count()).toBe(baseline.receipts);
  }, 60000);
});

/** The `POST /api/security/reset` payload (structurally the route's `ResetData`). */
interface ResetPayload {
  sessionId: string;
  locked: boolean;
  failures: number;
  max: number;
  lockedActionsReopened: boolean;
  message: string;
}

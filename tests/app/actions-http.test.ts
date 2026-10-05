/**
 * tests/app/actions-http.test.ts — REAL-application-entry (HTTP) e2e for the human-decision routes.
 *
 * These specs drive the REAL Next.js route handlers: they import the exported `POST` from
 * `@/app/api/actions/[id]/{confirm,verify,cancel}/route` and call it with REAL `NextRequest`
 * objects (see `./harness.ts`). The whole production stack runs underneath — the route →
 * `_lib/agent-bridge` → `@/agent` `confirmAction`/`verifyAction`/`cancelAction` → the security
 * gateway `authorizeAction`/`cancelAction` → the Banking SDK → the test SQLite. Only the MODEL is
 * scripted: `tests/setup.ts` forces `LLM_MODE=mock`, so the deterministic mock responder
 * (`agent/providers/mock-responder.ts`) answers. Offline, no API key, no network.
 *
 * This is deliberately NOT `tests/helpers/scenario.ts` (which re-instantiates the turn logic) — the
 * envelope, the ownership guard, the zod body validation, the exactly-once claim, the audit write
 * and the circuit breaker are all exercised for real here. It is the acceptance test for the
 * action-confirmation part of the demo (Case 12 remainder), complementing `./chat-http.test.ts`.
 *
 * Two-phase execution proof: a gated transfer is PARKED by the chat turn (`beforeToolCall` blocks
 * and persists a `PendingAction`); money moves ONLY when a human hits confirm/verify, and the route
 * executes the ORIGINAL validated args — never model text.
 *
 * DB lifecycle matches the other DB-backed suites: reset + seed before each test, disconnect after.
 * Every parking turn uses a FRESH session id (the in-process circuit breaker is keyed by
 * `sessionId`); the persisted id is the one the route returns, so that is what we assert on.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import { MFA_CODE } from '@/lib/constants';
import { newId } from '@/lib/ids';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS } from '@/tests/helpers/fixtures';
import { actionUrl, chatUrl, idCtx, postJson, type HttpResult } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (¥23,580) — the default funding account money must move out of. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** Recipient 张伟 — resolves unambiguously from the seeded contacts. */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The seeded checking balance (¥23,580). */
const SEEDED_BALANCE = CHECKING.balance;

/** 张伟's transfer amount in the YELLOW scenario (≤ ¥1000 ⇒ confirmation only). */
const YELLOW_AMOUNT = 200;
/** 张伟's transfer amount in the RED scenario (> ¥1000 ⇒ strong verification). */
const RED_AMOUNT = 5000;
/** 张伟's transfer amount that exceeds the ¥23,580 balance (⇒ INSUFFICIENT_FUNDS at execution). */
const OVERDRAFT_AMOUNT = 30000;

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

/** Failure protocol helper: assert the envelope and return its `{ code, message }`. */
function failure(res: HttpResult<Envelope<unknown>>): { code: string; message: string } {
  expect(res.data?.ok).toBe(false);
  return res.data!.error!;
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

type ToolEndEvent = Extract<AgentStreamEvent, { type: 'tool_end' }>;
type ConfirmationEvent = Extract<AgentStreamEvent, { type: 'confirmation_required' }>;
type MfaEvent = Extract<AgentStreamEvent, { type: 'mfa_required' }>;

function lastToolEnd(events: readonly AgentStreamEvent[], name: string): ToolEndEvent['toolEvent'] | undefined {
  const ends = events.filter(
    (event): event is ToolEndEvent => event.type === 'tool_end' && event.toolEvent.toolName === name,
  );
  return ends.length > 0 ? ends[ends.length - 1].toolEvent : undefined;
}

function confirmationOf(events: readonly AgentStreamEvent[]): ConfirmationEvent | undefined {
  return events.find((event): event is ConfirmationEvent => event.type === 'confirmation_required');
}

function mfaOf(events: readonly AgentStreamEvent[]): MfaEvent | undefined {
  return events.find((event): event is MfaEvent => event.type === 'mfa_required');
}

/* -------------------------------------------------------------------------------- invokers */

/** Drive one JSON-mode chat turn against the real route (fresh session). */
async function chatTurn(message: string): Promise<ChatTurnResponse> {
  const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
    sessionId: newId('sess'),
    message,
  });
  expect(res.status).toBe(200);
  return payload(res);
}

/** The single `PendingAction` the parking turn persisted for `sessionId`. */
function parked(sessionId: string) {
  return getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId } });
}

/**
 * Invoke a real action route handler. The dynamic-route `ctx` MUST be passed explicitly (the
 * harness defaults it to `idCtx('')`), and `sessionId` travels as a query param the routes read.
 */
function confirmAction(id: string, sessionId?: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(
    confirmPost,
    actionUrl(id, 'confirm', sessionId),
    {},
    { ctx: idCtx(id) },
  );
}

function verifyAction(
  id: string,
  code: string,
  sessionId?: string,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(
    verifyPost,
    actionUrl(id, 'verify', sessionId),
    { code },
    { ctx: idCtx(id) },
  );
}

function cancelAction(id: string, sessionId?: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(
    cancelPost,
    actionUrl(id, 'cancel', sessionId),
    {},
    { ctx: idCtx(id) },
  );
}

/* ----------------------------------------------------------------------------- DB helpers */

/** Current 活期 balance (¥23,580 seeded). */
async function checkingBalance(): Promise<number> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return account.balance;
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

/* ----------------------------------------------------------------------------------- tests */

describe('POST /api/actions — GREEN reads never park and never confirm', () => {
  it('1 — "查询我的余额" executes get_balance inline: no PendingAction, no confirmation, balance untouched', async () => {
    const turn = await chatTurn('查询我的余额');

    expect(lastToolEnd(turn.events, 'get_balance')?.status).toBe('success');
    expect(confirmationOf(turn.events)).toBeUndefined();
    expect(mfaOf(turn.events)).toBeUndefined();

    // A GREEN read auto-executes but parks nothing and moves no money.
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
  });
});

describe('POST /api/actions/[id]/confirm — YELLOW transfer', () => {
  it('2 — parks, confirm executes the original args exactly once, writes an audit success; a repeat confirm is a no-op', async () => {
    const turn = await chatTurn('给张伟转200元');
    const confirmation = confirmationOf(turn.events);
    expect(confirmation, 'expected a YELLOW confirmation_required event').toBeDefined();

    const row = await parked(turn.sessionId);
    expect(row.status).toBe('pending');
    expect(row.riskLevel).toBe('YELLOW');
    expect(row.toolName).toBe('transfer_money');
    expect(confirmation!.actionId).toBe(row.id);
    // Nothing has moved yet.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);

    const res = await confirmAction(row.id, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('YELLOW');
    expect(data.actionId).toBe(row.id);
    expect(data.sessionId).toBe(turn.sessionId);

    // Exactly once: the balance is debited by the parked amount and ONE ledger row went to 张伟.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - YELLOW_AMOUNT);
    const transfers = await zhangweiTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].amount).toBe(-YELLOW_AMOUNT);

    // The confirmed decision wrote exactly one audit `success` row for this session.
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId: turn.sessionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe('success');
    expect(audits[0].toolName).toBe('transfer_money');
    expect(audits[0].confirmed).toBe(true);

    // A repeat confirm of the SAME action is an idempotency CONFLICT — never a second execution.
    const again = await confirmAction(row.id, turn.sessionId);
    expect(again.status).toBe(200);
    const againData = payload(again);
    expect(againData.ok).toBe(false);
    expect(againData.status).toBe('executed');

    expect(await checkingBalance()).toBe(SEEDED_BALANCE - YELLOW_AMOUNT);
    expect(await zhangweiTransfers()).toHaveLength(1);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: turn.sessionId } })).toBe(1);

    expectNoMfaLeak('Test 2', res.data, again.data);
  });
});

describe('POST /api/actions/[id]/verify — RED transfer', () => {
  it('3 — parks awaiting_mfa, verify(MFA_CODE) executes the original args exactly once and audits MFA success', async () => {
    const turn = await chatTurn('给张伟转5000元');
    const mfa = mfaOf(turn.events);
    expect(mfa, 'expected a RED mfa_required event').toBeDefined();

    const row = await parked(turn.sessionId);
    expect(row.status).toBe('awaiting_mfa');
    expect(row.riskLevel).toBe('RED');
    expect(row.requiresMfa).toBe(true);
    expect(mfa!.actionId).toBe(row.id);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);

    const res = await verifyAction(row.id, MFA_CODE, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('RED');
    expect(data.mfaResult).toBe('success');

    expect(await checkingBalance()).toBe(SEEDED_BALANCE - RED_AMOUNT);
    const transfers = await zhangweiTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].amount).toBe(-RED_AMOUNT);

    const audit = await getTestPrisma().auditLog.findFirstOrThrow({
      where: { sessionId: turn.sessionId, toolName: 'transfer_money' },
    });
    expect(audit.status).toBe('success');
    expect(audit.mfaRequired).toBe(true);
    expect(audit.mfaResult).toBe('success');

    expectNoMfaLeak('Test 3', res.data);
  });

  it('4 — a WRONG code is a normal 200 with ok:false / awaiting_mfa / mfaResult:failed and moves NO money', async () => {
    const turn = await chatTurn('给张伟转5000元');
    const row = await parked(turn.sessionId);

    const res = await verifyAction(row.id, '000000', turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(false);
    expect(data.status).toBe('awaiting_mfa');
    expect(data.mfaResult).toBe('failed');

    // No money moved and no terminal audit row was written.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: turn.sessionId } })).toBe(0);

    // The failed attempt IS recorded as a SecurityEvent.
    const securityRows = await getTestPrisma().securityEvent.findMany({
      where: { sessionId: turn.sessionId },
    });
    expect(securityRows.some((event) => event.kind === 'MFA_FAILURE')).toBe(true);

    // The pending action is still unresolved.
    const after = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('awaiting_mfa');

    expectNoMfaLeak('Test 4', res.data);
  });

  it('5 — HONEST failure: verify("123456") on a ¥30,000 overdraft runs the ORIGINAL args, reports ok:false / failed (INSUFFICIENT_FUNDS), no fabricated success', async () => {
    const turn = await chatTurn('给张伟转30000元');
    const mfa = mfaOf(turn.events);
    expect(mfa, 'a ¥30,000 transfer is RED and must park for verification').toBeDefined();

    const row = await parked(turn.sessionId);
    expect(row.status).toBe('awaiting_mfa');

    const res = await verifyAction(row.id, MFA_CODE, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(false);
    expect(data.status).toBe('failed');

    // Nothing moved; the audit records the REAL failure.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    const audit = await getTestPrisma().auditLog.findFirstOrThrow({
      where: { sessionId: turn.sessionId, toolName: 'transfer_money' },
    });
    expect(audit.status).toBe('failed');

    expectNoMfaLeak('Test 5', res.data);
  });
});

describe('POST /api/actions/[id]/cancel — no execution', () => {
  it('6 — cancel marks the action cancelled, writes an audit `cancelled` row and moves no money', async () => {
    const turn = await chatTurn('给张伟转200元');
    const row = await parked(turn.sessionId);

    const res = await cancelAction(row.id, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    // The route reports a SUCCESSFUL cancel with `ok:true` (the action settled as intended); the
    // meaningful invariants are the `cancelled` status, the audit row and the untouched balance.
    // NOTE: the task wording suggested `ok:false` here, but `agent/confirmation.ts cancelAction`
    // genuinely returns `{ ok:true, status:'cancelled' }` (a cancel is a completed domain intent,
    // not a failure) — asserting the real value, never a fabricated one.
    expect(data.ok).toBe(true);
    expect(data.status).toBe('cancelled');
    expect(data.actionId).toBe(row.id);

    const after = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('cancelled');

    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    const audit = await getTestPrisma().auditLog.findFirstOrThrow({
      where: { sessionId: turn.sessionId },
    });
    expect(audit.status).toBe('cancelled');
    expect(audit.confirmed).toBe(false);

    expectNoMfaLeak('Test 6', res.data);
  });
});

describe('POST /api/actions — ownership guard and unknown ids', () => {
  it('7 — a foreign session gets 403 SECURITY_DENIED (action untouched); an unknown id gets 404 NOT_FOUND on every route', async () => {
    const turn = await chatTurn('给张伟转200元');
    const row = await parked(turn.sessionId);

    // Ownership: a DIFFERENT session may not settle this action.
    const foreign = await confirmAction(row.id, newId('sess'));
    expect(foreign.status).toBe(403);
    expect(failure(foreign).code).toBe('SECURITY_DENIED');

    const untouched = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: row.id } });
    expect(untouched.status).toBe('pending');
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);

    // Unknown action id ⇒ the gateway throws NOT_FOUND (all three routes).
    const unknownId = newId('missing');
    const unknownConfirm = await confirmAction(unknownId, turn.sessionId);
    expect(unknownConfirm.status).toBe(404);
    expect(failure(unknownConfirm).code).toBe('NOT_FOUND');

    const unknownVerify = await verifyAction(unknownId, MFA_CODE, turn.sessionId);
    expect(unknownVerify.status).toBe(404);
    expect(failure(unknownVerify).code).toBe('NOT_FOUND');

    const unknownCancel = await cancelAction(unknownId, turn.sessionId);
    expect(unknownCancel.status).toBe(404);
    expect(failure(unknownCancel).code).toBe('NOT_FOUND');
  });
});

describe('POST /api/actions — MFA secrecy over HTTP', () => {
  it('8 — the literal mock MFA code never appears in the parking turn or any verify response body', async () => {
    const turn = await chatTurn('给张伟转5000元');
    const row = await parked(turn.sessionId);

    const wrong = await verifyAction(row.id, '000000', turn.sessionId);
    expect(payload(wrong).mfaResult).toBe('failed');
    const right = await verifyAction(row.id, MFA_CODE, turn.sessionId);
    expect(payload(right).mfaResult).toBe('success');

    expectNoMfaLeak('Test 8', turn, wrong.data, wrong.data?.data, right.data, right.data?.data);
  });
});

describe('POST /api/actions — circuit breaker over HTTP', () => {
  /**
   * REACHABLE INVARIANT ONLY — the documented `423 CIRCUIT_OPEN` is UNREACHABLE here.
   *
   * `confirm/route.ts` documents a `423 CIRCUIT_OPEN` when the breaker is open, and `_lib/http.ts`
   * maps that code — but NO code in `security/` ever throws `AppError('CIRCUIT_OPEN')`. On a tripped
   * breaker `security-gateway.authorizeAction` returns the lock as a DOMAIN outcome
   * (`{ ok:false, status:'locked' }`), which `@/agent` surfaces as a normal 200 with `data.ok:false`
   * — see `agent/confirmation.ts` (`status:'locked'` path) and `security/mfa.ts` ("locked wins").
   * We therefore assert the REAL reachable invariants (200 / `ok:false` / `status:'locked'`, a
   * `CIRCUIT_BREAKER_TRIPPED` SecurityEvent, and a denied follow-up action call) instead of
   * fabricating a 423. See the task report for the full finding.
   */
  it('9 — 3 consecutive wrong verifies lock the session; a following action call on the SAME session is denied', async () => {
    const turn = await chatTurn('给张伟转5000元');
    const row = await parked(turn.sessionId);

    const first = await verifyAction(row.id, '000000', turn.sessionId);
    expect(first.status).toBe(200);
    expect(payload(first).status).toBe('awaiting_mfa');

    const second = await verifyAction(row.id, '000000', turn.sessionId);
    expect(second.status).toBe(200);
    expect(payload(second).status).toBe('awaiting_mfa');

    // The 3rd failure trips the breaker.
    const third = await verifyAction(row.id, '000000', turn.sessionId);
    expect(third.status).toBe(200);
    expect(payload(third).ok).toBe(false);
    expect(payload(third).status).toBe('locked');

    // The trip was recorded as a high-severity SecurityEvent.
    const securityRows = await getTestPrisma().securityEvent.findMany({
      where: { sessionId: turn.sessionId },
    });
    expect(securityRows.filter((event) => event.kind === 'CIRCUIT_BREAKER_TRIPPED')).toHaveLength(1);
    expect(
      securityRows.find((event) => event.kind === 'CIRCUIT_BREAKER_TRIPPED')?.severity,
    ).toBe('high');

    // A subsequent action call on the SAME (now locked) session is denied — even with the CORRECT code.
    const after = await verifyAction(row.id, MFA_CODE, turn.sessionId);
    expect(after.status).toBe(200);
    expect(payload(after).ok).toBe(false);
    expect(payload(after).status).toBe('locked');

    const afterConfirm = await confirmAction(row.id, turn.sessionId);
    expect(afterConfirm.status).toBe(200);
    expect(payload(afterConfirm).ok).toBe(false);
    expect(payload(afterConfirm).status).toBe('locked');

    // Fail-closed: no money moved and no audit row was written.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: turn.sessionId } })).toBe(0);

    expectNoMfaLeak('Test 9', first.data, third.data, after.data, afterConfirm.data);
  });
});

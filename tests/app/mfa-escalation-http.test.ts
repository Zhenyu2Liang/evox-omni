/**
 * tests/app/mfa-escalation-http.test.ts — REAL-application-entry (HTTP) e2e for the
 * EXECUTION-TIME YELLOW→RED transfer escalation.
 *
 * THE SCENARIO THIS PROVES: a small (¥200) transfer to 张伟 is parked as YELLOW (confirmation-only,
 * no MFA) at PARK time — the day's transfer total is ¥0 then. Afterwards the day's EXECUTED outbound
 * transfer total is raised (a same-day ¥900 transfer to 王芳 executed through the Banking SDK), so
 * when the human hits CONFIRM the gateway recomputes the EFFECTIVE day total (today's executed
 * transfer debits PLUS in-flight parked transfers, excluding the one being confirmed) = ¥900, and
 * ¥900 + ¥200 = ¥1,100 > the ¥1,000 confirmation-only limit ⇒ the parked YELLOW transfer ESCALATES
 * to RED and REFUSES the confirmation-only path: strong verification (the mock MFA code) is now
 * required. This is the anti "park N small transfers and bypass the MFA threshold" control, decided
 * ENTIRELY in code (`security/risk-engine.ts` + `security/security-gateway.ts#authorizeTransfer`),
 * never by the model.
 *
 * These specs drive the REAL Next.js route handlers (`POST /api/chat`, `POST /api/actions/[id]/
 * {confirm,verify}`) with real `NextRequest` objects (`./harness.ts`). The whole production stack runs
 * underneath (route → `@/agent` → tools → security gateway → Banking SDK → SQLite); only the MODEL is
 * scripted (`tests/setup.ts` forces `LLM_MODE=mock`). Offline, no API key, no network.
 *
 * Deterministic DB lifecycle: reset + seed before each test, disconnect after; a UNIQUE sessionId per
 * parking turn (the in-process circuit breaker is keyed by `sessionId`); NO fake timers (the demo
 * clock `DEMO_NOW = 2026-09-25 12:00` anchors the day-transfer window).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { banking } from '@/banking-sdk';
import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import { DAILY_TRANSFER_LIMIT, MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, chatUrl, idCtx, postJson, type HttpResult } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (¥23,580) — the account the parked transfer and the injected ¥900 debit. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** Recipient 张伟 — the parked transfer's payee (the money-moved-exactly-once probe). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** Recipient 王芳 — the injected same-day transfer that raises the day total. */
const WANGFANG = CONTACTS.find((contact) => contact.name === '王芳')!;
/** The seeded checking balance (¥23,580). */
import { centsToMoney, moneyToCents, normalizeMoney, subtractMoney } from '@/lib/money';
const SEEDED_BALANCE = normalizeMoney(CHECKING.balance);

/** The parked transfer amount (≤ ¥1000 ⇒ confirmation-only at PARK time). */
const PARKED_AMOUNT = '200';
/** The same-day outbound transfer injected AFTER parking (raises the executed day total to ¥900). */
const INJECTED_AMOUNT = '900';

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

function mfaOf(events: readonly AgentStreamEvent[]): MfaEvent | undefined {
  return events.find((event): event is MfaEvent => event.type === 'mfa_required');
}

/* -------------------------------------------------------------------------------- invokers */

/** Drive one JSON-mode chat turn against the real route (fresh session id). */
async function chatTurn(message: string): Promise<ChatTurnResponse> {
  const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
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
 * Invoke a real action route handler. The dynamic-route `ctx` MUST be passed explicitly (the harness
 * defaults it to `idCtx('')`), and `sessionId` travels as the `banking_session` COOKIE — identity is
 * cookie-only, so a `?sessionId=` query param would be IGNORED.
 */
function confirmAction(id: string, sessionId?: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(confirmPost, actionUrl(id, 'confirm'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

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

/** Current 活期 balance (¥23,580 seeded). */
async function checkingBalance(): Promise<string> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return centsToMoney(account.balanceMinor);
}

/** Every ledger row paid to 张伟 (the parked-transfer money-moved-exactly-once probe). */
function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/** Every ledger row paid to 王芳 (the injected same-day transfer that raises the day total). */
function wangfangTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: WANGFANG.id } });
}

/**
 * Park a YELLOW ¥200 transfer to 张伟, THEN raise the day's EXECUTED outbound transfer total by
 * injecting a same-day ¥900 transfer to 王芳 through the Banking SDK. The injection happens AFTER the
 * park on purpose: at park time the day total is ¥0 so the transfer is YELLOW; at confirm time the
 * effective day total is ¥900 so ¥900 + ¥200 = ¥1,100 > ¥1,000 and the confirm must escalate to RED.
 */
async function parkThenRaiseDayTotal() {
  // The two amounts must straddle the ¥1000 confirmation-only limit — assert the arithmetic.
  expect(moneyToCents(PARKED_AMOUNT)).toBeLessThanOrEqual(moneyToCents(DAILY_TRANSFER_LIMIT));
  expect(moneyToCents(INJECTED_AMOUNT)).toBeLessThanOrEqual(moneyToCents(DAILY_TRANSFER_LIMIT));
  expect(moneyToCents(INJECTED_AMOUNT) + moneyToCents(PARKED_AMOUNT)).toBeGreaterThan(moneyToCents(DAILY_TRANSFER_LIMIT));

  // 1) Park the ¥200 transfer (day total is ¥0 at PARK time ⇒ confirmation-only / YELLOW).
  const turn = await chatTurn('给张伟转200元');
  const row = await parked(turn.sessionId);
  expect(row.toolName).toBe('transfer_money');
  expect(row.riskLevel).toBe('YELLOW');
  expect(row.requiresMfa).toBe(false);
  expect(row.status).toBe('pending');

  // 2) AFTER parking, inject a SAME-DAY ¥900 outbound transfer to 王芳 (SDK-level execution) so the
  //    day's EXECUTED transfer total becomes ¥900 while the parked ¥200 is still unresolved.
  const injected = await banking.transfer.createTransfer({
    userId: DEMO_USER_ID,
    contactId: WANGFANG.id,
    amount: INJECTED_AMOUNT,
  });
  expect(injected.success).toBe(true);

  return { turn, row };
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ----------------------------------------------------------------------------------- tests */

describe('[integration] POST /api/actions/[id]/confirm — YELLOW→RED execution-time escalation', () => {
  it('1 — a ¥900 same-day total tips the parked ¥200 transfer over ¥1000: confirm is refused as RED/MFA and moves NO money', async () => {
    const { turn, row } = await parkThenRaiseDayTotal();

    // Precondition: the injected ¥900 is the ONLY same-day transfer; the parked action is unresolved.
    expect(await wangfangTransfers()).toHaveLength(1);
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, INJECTED_AMOUNT));

    // CONFIRM (owning cookie) → the gateway re-risks at EXECUTION time and refuses the MFA-less path.
    const res = await confirmAction(row.id, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(false);
    expect(data.requiresMfa).toBe(true);
    expect(data.tier).toBe('RED');
    expect(mfaOf(data.events), 'expected an mfa_required escalation event').toBeDefined();

    // NO money moved by the parked action — 张伟 still has nothing, the balance is only down by the
    // injected ¥900 (never by the parked ¥200).
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, INJECTED_AMOUNT));

    // The escalation is PERSISTED on the action: now RED / MFA / awaiting_mfa.
    const after = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('awaiting_mfa');
    expect(after.riskLevel).toBe('RED');
    expect(after.requiresMfa).toBe(true);

    // The escalation-blocked confirm writes NO audit row (audit is written only on an executed/settled
    // decision) — asserted as the REAL invariant, never fabricated.
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: turn.sessionId } })).toBe(0);

    // The execution-time escalation IS recorded as a SecurityEvent (auditable risk control).
    const securityRows = await getTestPrisma().securityEvent.findMany({
      where: { sessionId: turn.sessionId },
    });
    expect(securityRows.some((event) => event.kind === 'LIMIT_EXCEEDED')).toBe(true);

    expectNoMfaLeak('Test 1', turn, res.data, res.data?.data);
  });
});

describe('[integration] POST /api/actions/[id]/verify — completing an escalated transfer', () => {
  it('2 — verify(MFA_CODE) on the escalated action executes the parked ¥200 exactly once and audits RED/mfaRequired/success', async () => {
    const { turn, row } = await parkThenRaiseDayTotal();

    // The confirm escalates (no code ⇒ refused, RED).
    const escalated = await confirmAction(row.id, turn.sessionId);
    const escalatedData = payload(escalated);
    expect(escalatedData.ok).toBe(false);
    expect(escalatedData.requiresMfa).toBe(true);
    expect(escalatedData.tier).toBe('RED');

    // VERIFY with the mock code completes the strong-verification path.
    const res = await verifyAction(row.id, MFA_CODE, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('RED');
    expect(data.requiresMfa).toBe(true);
    expect(data.mfaResult).toBe('success');

    // Money moved EXACTLY ONCE: 张伟 −200 (plus the injected −900), no double execution.
    expect(await checkingBalance()).toBe(subtractMoney(subtractMoney(SEEDED_BALANCE, INJECTED_AMOUNT), PARKED_AMOUNT));
    const transfers = await zhangweiTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].amountMinor).toBe(-moneyToCents(PARKED_AMOUNT));
    expect(await wangfangTransfers()).toHaveLength(1);

    // The FINAL audit row is consistent: mfaRequired === true AND riskLevel === 'RED' (the EFFECTIVE
    // tier of the escalation, not the stale parked YELLOW flags) and it is a `success`.
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId: turn.sessionId } });
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect(audit.status).toBe('success');
    expect(audit.toolName).toBe('transfer_money');
    expect(audit.mfaRequired).toBe(true);
    expect(audit.riskLevel).toBe('RED');
    expect(audit.mfaResult).toBe('success');

    expectNoMfaLeak('Test 2', turn, escalated.data, escalated.data?.data, res.data, res.data?.data);
  });
});

describe('[integration] POST /api/actions/[id]/verify — a WRONG code on an escalated transfer', () => {
  it('3 — a wrong code is a normal 200 with ok:false / awaiting_mfa / mfaResult:failed, moves NO money and writes NO audit row', async () => {
    const { turn, row } = await parkThenRaiseDayTotal();

    // Escalate the parked YELLOW transfer first.
    const escalated = await confirmAction(row.id, turn.sessionId);
    expect(payload(escalated).tier).toBe('RED');

    const res = await verifyAction(row.id, '000000', turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(false);
    expect(data.status).toBe('awaiting_mfa');
    expect(data.mfaResult).toBe('failed');
    expect(data.tier).toBe('RED');
    expect(data.requiresMfa).toBe(true);

    // Fail-closed: NO money moved and NO audit row was written.
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, INJECTED_AMOUNT));
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: turn.sessionId } })).toBe(0);

    // The failed attempt IS recorded as a SecurityEvent.
    const securityRows = await getTestPrisma().securityEvent.findMany({
      where: { sessionId: turn.sessionId },
    });
    expect(securityRows.some((event) => event.kind === 'MFA_FAILURE')).toBe(true);

    // The action is still unresolved (awaiting the correct code — not locked after a single failure).
    const after = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('awaiting_mfa');
    expect(after.riskLevel).toBe('RED');

    expectNoMfaLeak('Test 3', turn, escalated.data, res.data, res.data?.data);
  });
});

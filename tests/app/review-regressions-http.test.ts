/**
 * tests/app/review-regressions-http.test.ts — REVIEW REGRESSIONS at the REAL-application-entry
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
 * per scenario (the in-process circuit breaker is keyed by `sessionId`); NO fake timers — the demo
 * clock `DEMO_NOW = 2026-09-25 12:00` anchors the day-transfer window.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import { DAILY_TRANSFER_LIMIT, MFA_CODE } from '@/lib/constants';
import { newId } from '@/lib/ids';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS } from '@/tests/helpers/fixtures';
import { actionUrl, chatUrl, idCtx, postJson, type HttpResult } from './harness';

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
  const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
    sessionId: sessionId ?? newId('sess'),
    message,
  });
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

/**
 * tests/app/mfa-escalation-upgrade-http.test.ts — REAL-application-entry (HTTP) REGRESSION for the
 * EXECUTION-TIME YELLOW→RED UPGRADE of a parked transfer.
 *
 * THE REGRESSION THIS LOCKS DOWN: two individually-small (¥600) transfers are parked in ONE session.
 * Confirming the FIRST (day total ¥0) legitimately executes as YELLOW; confirming the SECOND must be
 * RE-RISKED at EXECUTION time — ¥600 (already executed today) + ¥600 (this one) = ¥1,200 > the ¥1,000
 * confirmation-only limit — so the parked YELLOW confirmation must be UPGRADED to RED, and the RED
 * MFA control must hold. The confirm response MUST surface the EFFECTIVE decision (`requiresMfa:true`,
 * tier `RED`, status `awaiting_mfa`) and emit an `mfa_required` stream event, and the final `AuditLog`
 * row MUST be consistent with that EFFECTIVE tier (`RED` / `mfaRequired:true` / `mfaResult:'success'`)
 * — never the stale park flags. The upgrade is decided ENTIRELY in code
 * (`security/risk-engine.ts` + `security/security-gateway.ts`), never by the model; the anti "park N
 * small transfers and bypass the MFA threshold" control must not regress.
 *
 * Like every other `tests/app/*` spec, the REAL Next.js App Router route handlers are imported and
 * invoked with real `NextRequest` objects (`./harness.ts`), so the whole production stack runs
 * underneath (route → `@/agent` → banking tools → security gateway `beforeToolCall` → Banking SDK →
 * SQLite). Only the MODEL is scripted: `tests/setup.ts` forces `LLM_MODE=mock`, so
 * `agent/providers/mock-responder.ts` answers. Offline, no API key, no network.
 *
 * IDENTITY IS COOKIE-ONLY: the FIRST chat turn OMITS `sessionId` and sends NO cookie, so the route
 * MINTS the session and sets the `banking_session` cookie; later turns/actions carry that id as the
 * cookie (never as a body/query param, which the route rejects with `409 CONFLICT`).
 *
 * Deterministic DB lifecycle: reset + seed before each test, disconnect after. A unique session id is
 * minted per scenario (the in-process circuit breaker is keyed by `sessionId`); NO fake timers — the
 * demo clock `DEMO_NOW = 2026-09-25 12:00` anchors the day-transfer window.
 *
 * KNOWN AUDIT GOTCHA (asserted as the REAL invariant): GREEN auto-executed reads write NO `AuditLog`
 * row — only GATED confirm/verify/cancel decisions do. A FAILED MFA attempt likewise writes no audit
 * row (only a settled `success`/`failed` execution does).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import { DAILY_TRANSFER_LIMIT, MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS } from '@/tests/helpers/fixtures';
import {
  actionUrl,
  chatUrl,
  idCtx,
  postJson,
  type HttpResult,
} from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (seeded ¥23,580) — the account both parked transfers debit. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** Recipient 张伟 — the FIRST parked transfer (the one that executes on confirm). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** Recipient 王芳 — the SECOND parked transfer (the one that must UPGRADE at confirm time). */
const WANGFANG = CONTACTS.find((contact) => contact.name === '王芳')!;
/** The seeded checking balance (¥23,580). */
import { addMoney, centsToMoney, moneyToCents, normalizeMoney, subtractMoney } from '@/lib/money';
const SEEDED_BALANCE = normalizeMoney(CHECKING.balance);

/** Both parked transfers use the same amount: ¥600 each ≤ ¥1000, ¥600 + ¥600 > ¥1000. */
const TRANSFER_AMOUNT = '600';

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

/** The `mfa_required` upgrade event of an action response, when present. */
function mfaOf(events: readonly AgentStreamEvent[]): MfaEvent | undefined {
  return events.find((event): event is MfaEvent => event.type === 'mfa_required');
}

/* -------------------------------------------------------------------------------- invokers */

/**
 * Drive one JSON-mode chat turn against the real route.
 *
 * COOKIE-ONLY BOOTSTRAP: the body NEVER carries a `sessionId` (the route rejects a body id that
 * disagrees with the cookie — including "no cookie" — with `409 CONFLICT`). With no `sessionId`
 * argument the FIRST turn sends NO cookie: the route MINTS a fresh session and sets the cookie.
 * A continuation turn passes `sessionId` as the `banking_session` COOKIE.
 */
async function chatTurn(message: string, sessionId?: string): Promise<ChatTurnResponse> {
  const opts = sessionId !== undefined ? { sessionId } : {};
  const res = await postJson<Envelope<ChatTurnResponse>>(
    chatPost,
    chatUrl({ stream: 0 }),
    { message },
    opts,
  );
  expect(res.status, `chat turn "${message}" failed: ${JSON.stringify(res.data)}`).toBe(200);
  const turn = payload(res);

  // Identity belongs to the shared demo, independent of browser cookies.
  expect(res.headers.get('set-cookie')).toBeNull();
  if (sessionId === undefined) {
    expect(turn.sessionId).toBe('demo:user_liming');
  } else {
    expect(turn.sessionId, 'the continuation turn must reuse the session').toBe(sessionId);
  }
  return turn;
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
async function checkingBalance(): Promise<string> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return centsToMoney(account.balanceMinor);
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
 * `requiresMfa:false` — that is the precondition the upgrade regression depends on. Nothing executes
 * here.
 */
async function parkTwoTransfers() {
  // The two amounts must straddle the ¥1000 confirmation-only limit — assert the arithmetic.
  expect(moneyToCents(TRANSFER_AMOUNT)).toBeLessThanOrEqual(moneyToCents(DAILY_TRANSFER_LIMIT));
  expect(moneyToCents(TRANSFER_AMOUNT) * 2n).toBeGreaterThan(moneyToCents(DAILY_TRANSFER_LIMIT));

  // 1) Park the ¥600 transfer to 张伟 (fresh session — no cookie ⇒ the route mints + sets the cookie).
  const first = await chatTurn('给张伟转600元');
  const sessionId = first.sessionId;

  // 2) Park the ¥600 transfer to 王芳 in the SAME session (via the banking_session cookie).
  const second = await chatTurn('给王芳转600元', sessionId);

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

  return { sessionId, actionA: actionA!, actionB: actionB!, first, second };
}

/**
 * Park both ¥600 transfers, then CONFIRM A — the day total is still ¥0, so A's YELLOW confirmation is
 * legitimately accepted (¥600 moves). B remains parked YELLOW; the NEXT confirm of B must UPGRADE.
 */
async function parkBothThenConfirmFirst() {
  const parked = await parkTwoTransfers();

  const resA = await confirmAction(parked.actionA.id, parked.sessionId);
  expect(resA.status).toBe(200);
  const dataA = payload(resA);
  expect(dataA.ok, 'the first ¥600 confirm (day total ¥0) must execute as YELLOW').toBe(true);
  expect(dataA.status).toBe('executed');
  expect(dataA.tier).toBe('YELLOW');
  expect(dataA.requiresMfa).toBe(false);
  expect(await transfersTo(ZHANGWEI.id)).toHaveLength(1);
  expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, TRANSFER_AMOUNT));

  return { ...parked, resA };
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ----------------------------------------------------------------------------------- tests */

describe('[integration] POST /api/actions/[id]/confirm — execution-time YELLOW→RED upgrade', () => {
  it('[integration] 1 — confirming the SECOND ¥600 transfer upgrades it to RED/MFA: requiresMfa + tier RED + status awaiting_mfa + an `mfa_required` event, and moves NO money', async () => {
    const { sessionId, actionA, actionB, first, second, resA } = await parkBothThenConfirmFirst();
    expect(actionA.id).not.toBe(actionB.id);

    // CONFIRM B — the day total is now ¥600, so ¥600 + ¥600 > ¥1000 ⇒ strong verification is required.
    const resB = await confirmAction(actionB.id, sessionId);
    expect(resB.status).toBe(200);
    const dataB = payload(resB);

    // The confirm response SURFACES the EFFECTIVE (upgraded) decision, not the stale YELLOW park.
    expect(dataB.ok, 'the upgraded confirm is not authorized').toBe(false);
    expect(dataB.status).toBe('awaiting_mfa');
    expect(dataB.tier).toBe('RED');
    expect(dataB.requiresMfa).toBe(true);

    // The confirm EMITS an `mfa_required` stream event (the SAME `AgentStreamEvent` kind an SSE frame
    // carries) addressed to THIS action — assert the event kind + actionId.
    const mfa = mfaOf(dataB.events);
    expect(mfa, 'expected an mfa_required upgrade event').toBeDefined();
    expect(mfa!.type).toBe('mfa_required');
    expect(mfa!.actionId).toBe(actionB.id);

    // The upgrade is PERSISTED: B now awaits the code as effective RED/MFA (the row is upgraded).
    const rowB = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionB.id } });
    expect(rowB.status).toBe('awaiting_mfa');
    expect(rowB.riskLevel).toBe('RED');
    expect(rowB.requiresMfa).toBe(true);

    // Fail-closed: the upgraded confirm moved NO money — only A's ¥600 is gone, 王芳 got nothing.
    expect(await transfersTo(WANGFANG.id)).toHaveLength(0);
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, TRANSFER_AMOUNT));

    // The upgrade-blocked confirm settles nothing ⇒ it writes NO audit row (audit is gated-only, and
    // only a settled execution writes one). A's single YELLOW success row is the only one present.
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].riskLevel).toBe('YELLOW');
    expect(audits[0].status).toBe('success');

    expectNoMfaLeak('Test 1', first, second, resA.data, resA.data?.data, resB.data, resB.data?.data);
  });
});

describe('[integration] POST /api/actions/[id]/verify — completing the upgraded transfer', () => {
  it('[integration] 2 — verify(MFA_CODE) executes the upgraded ¥600 exactly once and the audit row is CONSISTENT with the effective RED/MFA decision', async () => {
    const { sessionId, actionA, actionB, first, second, resA } = await parkBothThenConfirmFirst();
    expect(actionA.id).not.toBe(actionB.id);

    // Upgrade B by confirming it (no code ⇒ refused, RED/awaiting_mfa).
    const escalated = await confirmAction(actionB.id, sessionId);
    const escalatedData = payload(escalated);
    expect(escalatedData.ok).toBe(false);
    expect(escalatedData.tier).toBe('RED');
    expect(escalatedData.requiresMfa).toBe(true);
    expect(escalatedData.status).toBe('awaiting_mfa');

    // VERIFY with the mock code completes the strong-verification path.
    const res = await verifyAction(actionB.id, MFA_CODE, sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('RED');
    expect(data.requiresMfa).toBe(true);
    expect(data.mfaResult).toBe('success');

    // Money moved EXACTLY ONCE for B: ¥23,580 − ¥600 (A) − ¥600 (B); 王芳 got exactly one ¥600 debit.
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, addMoney(TRANSFER_AMOUNT, TRANSFER_AMOUNT)));
    const wangfang = await transfersTo(WANGFANG.id);
    expect(wangfang).toHaveLength(1);
    expect(wangfang[0].amountMinor).toBe(-moneyToCents(TRANSFER_AMOUNT));
    expect(await transfersTo(ZHANGWEI.id)).toHaveLength(1);

    // AUDIT CONSISTENCY: exactly the two gated decisions are audited — the plain YELLOW confirm (A)
    // and the UPGRADED RED verify (B). The upgraded row reflects the EFFECTIVE decision, never the
    // stale YELLOW park flags.
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits, 'one audit row per settled gated decision').toHaveLength(2);

    const redAudit = audits.find((row) => row.riskLevel === 'RED');
    expect(redAudit, 'expected a RED audit row for the upgraded transfer').toBeDefined();
    expect(redAudit!.status).toBe('success');
    expect(redAudit!.toolName).toBe('transfer_money');
    expect(redAudit!.riskLevel).toBe('RED');
    expect(redAudit!.mfaRequired).toBe(true);
    expect(redAudit!.mfaResult).toBe('success');
    expect(redAudit!.confirmationRequired).toBe(true);
    expect(redAudit!.confirmed).toBe(true);

    const yellowAudit = audits.find((row) => row.riskLevel === 'YELLOW');
    expect(yellowAudit, 'expected a YELLOW audit row for the first plain confirm').toBeDefined();
    expect(yellowAudit!.status).toBe('success');
    expect(yellowAudit!.toolName).toBe('transfer_money');
    expect(yellowAudit!.mfaRequired).toBe(false);
    expect(yellowAudit!.mfaResult).toBe('not_required');

    expectNoMfaLeak(
      'Test 2',
      first,
      second,
      resA.data,
      escalated.data,
      escalated.data?.data,
      res.data,
      res.data?.data,
    );
  });

  it('[integration] 3 — a WRONG code on the upgraded transfer is a normal 200 ok:false / awaiting_mfa / mfaResult:failed, moves NO money and writes NO audit row', async () => {
    const { sessionId, actionA, actionB, first, second, resA } = await parkBothThenConfirmFirst();
    expect(actionA.id).not.toBe(actionB.id);

    // Upgrade B first (no code ⇒ RED/awaiting_mfa).
    const escalated = await confirmAction(actionB.id, sessionId);
    const escalatedData = payload(escalated);
    expect(escalatedData.tier).toBe('RED');
    expect(escalatedData.requiresMfa).toBe(true);
    expect(escalatedData.status).toBe('awaiting_mfa');

    const res = await verifyAction(actionB.id, '000000', sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(false);
    expect(data.status).toBe('awaiting_mfa');
    expect(data.mfaResult).toBe('failed');
    expect(data.tier).toBe('RED');
    expect(data.requiresMfa).toBe(true);

    // Fail-closed: only A's ¥600 moved; B never executed and the failed attempt is NOT audited.
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, TRANSFER_AMOUNT));
    expect(await transfersTo(WANGFANG.id)).toHaveLength(0);
    expect(await transfersTo(ZHANGWEI.id)).toHaveLength(1);
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits, 'a failed MFA attempt writes NO audit row').toHaveLength(1);
    expect(audits[0].status).toBe('success');
    expect(audits[0].riskLevel).toBe('YELLOW');
    expect(await getTestPrisma().auditLog.count({ where: { sessionId, mfaResult: 'failed' } })).toBe(0);

    // One failure does not lock the action: it still awaits the correct code as effective RED/MFA.
    const rowB = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionB.id } });
    expect(rowB.status).toBe('awaiting_mfa');
    expect(rowB.riskLevel).toBe('RED');
    expect(rowB.requiresMfa).toBe(true);

    expectNoMfaLeak(
      'Test 3',
      first,
      second,
      resA.data,
      escalated.data,
      escalated.data?.data,
      res.data,
      res.data?.data,
    );
  });
});

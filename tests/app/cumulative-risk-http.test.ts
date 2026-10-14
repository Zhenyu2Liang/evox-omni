/**
 * tests/app/cumulative-risk-http.test.ts — REAL-application-entry (HTTP) e2e for the CUMULATIVE
 * daily-transfer risk (the ¥1,000/day rule) and its exactly-once accounting.
 *
 * WHAT THIS PROVES: the dynamic transfer tier is decided by CODE (`security/risk-engine.ts` +
 * `security/security-gateway.ts#authorizeTransfer`) against the day's OUTBOUND transfer total — never
 * by the model. Three invariants:
 *
 *  1. EXACTLY-ONCE COUNTING. A ¥600 transfer that has been authorized (`confirmed`) and already
 *     debited (ledgered) but is NOT yet terminal (`executed`) must be counted EXACTLY ONCE in the
 *     cumulative day total. While it sits in that "authorized-but-not-yet-terminal" window, a
 *     subsequent ¥100 transfer must still be confirmation-only (YELLOW, no MFA): ¥600 + ¥100 =
 *     ¥700 ≤ ¥1,000. A naive implementation that counts the ledger debit AND the in-flight parked
 *     action would read ¥1,200 and wrongly force MFA — the exact double-count regression guarded here.
 *
 *  2. CONCURRENCY. Two ¥600 transfers parked while the day total is ¥0 are each YELLOW at PARK time
 *     (¥600 ≤ ¥1,000). Confirmed CONCURRENTLY they must serialize so that the SECOND re-risks at
 *     EXECUTION time against the first (now in-flight): ¥600 + ¥600 = ¥1,200 > ¥1,000 ⇒ the second
 *     ESCALATES to RED/MFA. Only ONE ¥600 may proceed without MFA; money must not silently double-move.
 *
 *  3. BOUNDARIES. STRICT `>` comparison: a transfer of EXACTLY ¥1,000 is YELLOW (no MFA); a transfer
 *     of ¥1,000.01 is RED (strong verification required).
 *
 * These specs park actions through the SECURITY GATEWAY SEAM (`security.gateway.securityGateway`,
 * `import { security } from '@/security'`) — the same chokepoint the runtime uses — and drive the
 * human decision through the REAL Next.js route handlers (`POST /api/actions/[id]/{confirm,verify}`)
 * with real `NextRequest` objects (`./harness.ts`). Identity is COOKIE-ONLY: the parked action's
 * owning session travels as the `banking_session` cookie. The whole production stack runs underneath
 * (route → `@/agent` → tools → security gateway → Banking SDK → SQLite); only the MODEL is scripted
 * (`tests/setup.ts` forces `LLM_MODE=mock`, so the narration continuation is deterministic). Offline,
 * no API key, no network.
 *
 * Deterministic DB lifecycle: reset + seed before each test, disconnect after; a UNIQUE sessionId per
 * test (the in-process circuit breaker is keyed by `sessionId`); NO fake timers (the demo clock
 * `DEMO_NOW = 2026-09-25 12:00` anchors the day-transfer window). The assertion surface for the
 * cumulative rule is `security.risk.computeDailyTransferTotal(userId)` — the public day-total reader.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { getDemoSession } from '@/agent/session';
import { security } from '@/security';
import { DAILY_TRANSFER_LIMIT, MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, idCtx, postJson, type HttpResult } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (¥23,580) — the funding account for every parked transfer. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** Recipient 张伟 — the payee of every transfer in this spec (the money-moved probe). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The seeded checking balance (¥23,580). */
import { addMoney, centsToMoney, normalizeMoney, subtractMoney } from '@/lib/money';
const SEEDED_BALANCE = normalizeMoney(CHECKING.balance);

/** The singleton gateway object every runtime call routes through (the security chokepoint). */
const gateway = security.gateway.securityGateway;

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

/* -------------------------------------------------------------------------------- invokers */

/** Create a real persisted `AgentSession` for the demo user (owns the parked actions). */
async function ensureSession(): Promise<string> {
  return (await getDemoSession(DEMO_USER_ID)).sessionId;
}

/**
 * Park a `transfer_money` to 张伟 through the SECURITY GATEWAY chokepoint — the runtime's own gating
 * path (`beforeToolCall`) — and return the persisted `PendingAction` id. The day total is not touched
 * here; parking only EVALUATES risk at park time.
 */
async function park(sessionId: string, amount: string): Promise<string> {
  const auth = await gateway.handleToolCall({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { name: '张伟', amount },
    userRequest: `给张伟转${amount}元`,
  });
  const id = auth.action?.id;
  expect(id, 'expected the transfer to be gated (parked)').toBeTruthy();
  return id!;
}

/**
 * Invoke the REAL `POST /api/actions/[id]/confirm` handler. The dynamic-route `ctx` MUST be passed
 * explicitly (the harness defaults it to `idCtx('')`), and identity travels as the `banking_session`
 * COOKIE — cookie-only, so a `?sessionId=` query param would be IGNORED.
 */
function confirmHttp(
  id: string,
  sessionId: string,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(confirmPost, actionUrl(id, 'confirm'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

/** Invoke the REAL `POST /api/actions/[id]/verify` handler with the mock MFA code. */
function verifyHttp(
  id: string,
  code: string,
  sessionId: string,
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

/** Every ledger row paid to 张伟 (the money-moved-exactly-once probe). */
function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/** The persisted pending action row (tier / MFA / terminal status probes). */
function pendingRow(id: string) {
  return getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id } });
}

/** The public cumulative day-transfer reader — the assertion surface for the ¥1,000/day rule. */
function dailyTotal(): Promise<string> {
  return security.risk.computeDailyTransferTotal(DEMO_USER_ID);
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ----------------------------------------------------------------------------------- tests */

describe('[integration] POST /api/actions/[id]/confirm — cumulative day total counts an in-flight transfer exactly once', () => {
  it('1 — a ¥600 transfer confirmed (ledgered but not yet terminal) is counted ONCE, so a subsequent ¥100 confirm stays YELLOW (no MFA)', async () => {
    const sessionId = await ensureSession();

    // Park both transfers while the day total is ¥0 ⇒ both are confirmation-only (YELLOW).
    const six = await park(sessionId, '600');
    const one = await park(sessionId, '100');
    for (const id of [six, one]) {
      const row = await pendingRow(id);
      expect(row.riskLevel).toBe('YELLOW');
      expect(row.requiresMfa).toBe(false);
      expect(row.status).toBe('pending');
    }

    // BARRIER: pause the FIRST confirm at the moment its debit has been written but before the action
    // is marked terminal (`executed`) — the precise "ledgered but not yet terminal" window in which a
    // naive day total would count the ¥600 TWICE (once as a ledger debit, once as in-flight).
    const original = gateway.recordActionResult.bind(gateway);
    let reached!: () => void;
    const atBoundary = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi
      .spyOn(gateway, 'recordActionResult')
      .mockImplementation(async (id: string, status: 'executed' | 'failed') => {
        if (id === six) {
          reached();
          await gate;
        }
        await original(id, status);
      });

    const first = confirmHttp(six, sessionId);
    let second!: HttpResult<Envelope<ActionResponse>>;
    try {
      await atBoundary;
      // The ¥600 is authorized + debited but NOT yet terminal — confirm the ¥100 inside this window.
      second = await confirmHttp(one, sessionId);
    } finally {
      release();
      await first;
      spy.mockRestore();
    }

    // The ¥100 confirm stays confirmation-only — the ¥600 was counted exactly ONCE, not twice.
    expect(second.status).toBe(200);
    const data = payload(second);
    expect(data.ok).toBe(true);
    expect(data.requiresMfa).toBe(false);
    expect(data.tier).toBe('YELLOW');

    // Both actions settled terminally (`executed`).
    expect((await pendingRow(six)).status).toBe('executed');
    expect((await pendingRow(one)).status).toBe('executed');

    // The assertion surface: the day's transfer total counts the ¥600 EXACTLY ONCE (700 = 600 + 100),
    // never twice (1,300) and never zero.
    expect(await dailyTotal()).toBe('700.00');

    // Money moved exactly once per action: the balance is down by exactly ¥700.
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, '700.00'));
    expect(await zhangweiTransfers()).toHaveLength(2);
  });
});

describe('[integration] POST /api/actions/[id]/confirm — concurrent ¥600 + ¥600 escalate the second to RED/MFA at execution time', () => {
  it('2 — two concurrent ¥600 confirms: only ONE proceeds without MFA, the other escalates to RED/MFA and completes only after verification', async () => {
    const sessionId = await ensureSession();

    // Park both while the day total is ¥0 ⇒ both are confirmation-only (YELLOW) at PARK time.
    const a = await park(sessionId, '600');
    const b = await park(sessionId, '600');
    for (const id of [a, b]) {
      const row = await pendingRow(id);
      expect(row.riskLevel).toBe('YELLOW');
      expect(row.status).toBe('pending');
    }

    // Confirm BOTH concurrently — the gateway's claim-first transaction must serialize them so the
    // second reads the first as in-flight and re-risks over the ¥1,000 limit.
    const [r1, r2] = await Promise.all([confirmHttp(a, sessionId), confirmHttp(b, sessionId)]);
    const results = [payload(r1), payload(r2)];
    const cleared = results.filter((outcome) => outcome.ok);
    const escalated = results.filter((outcome) => !outcome.ok);

    // EXACTLY one cleared without MFA (YELLOW); the other escalated to RED requiring MFA.
    expect(cleared).toHaveLength(1);
    expect(escalated).toHaveLength(1);
    expect(cleared[0].requiresMfa).toBe(false);
    expect(cleared[0].tier).toBe('YELLOW');
    expect(escalated[0].requiresMfa).toBe(true);
    expect(escalated[0].tier).toBe('RED');
    expect(escalated[0].status).toBe('awaiting_mfa');

    // Money moved EXACTLY ONCE: the cleared ¥600 only; the escalated one is parked, not debited.
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, '600.00'));
    expect(await zhangweiTransfers()).toHaveLength(1);

    // The escalated action is PERSISTED as RED / MFA / awaiting_mfa (never silently dropped).
    const escalatedRow = await pendingRow(escalated[0].actionId);
    expect(escalatedRow.status).toBe('awaiting_mfa');
    expect(escalatedRow.riskLevel).toBe('RED');
    expect(escalatedRow.requiresMfa).toBe(true);

    // The escalated transfer can still be completed WITH strong verification (the mock MFA code).
    const done = await verifyHttp(escalated[0].actionId, MFA_CODE, sessionId);
    expect(done.status).toBe(200);
    const doneData = payload(done);
    expect(doneData.ok).toBe(true);
    expect(doneData.status).toBe('executed');

    // Now BOTH ¥600s have moved: the balance is down by exactly ¥1,200 and the day total is ¥1,200.
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, '1200.00'));
    expect(await zhangweiTransfers()).toHaveLength(2);
    expect(await dailyTotal()).toBe('1200.00');
  });
});

describe('[integration] transfer risk boundaries — ¥1,000 stays YELLOW, ¥1,000.01 escalates to RED', () => {
  it('3a — a transfer of EXACTLY ¥1,000 (the limit) is YELLOW: confirm clears without MFA and moves the money', async () => {
    const sessionId = await ensureSession();
    const id = await park(sessionId, DAILY_TRANSFER_LIMIT);

    // Amount ≤ the single-transfer limit and projected total == the limit ⇒ still confirmation-only.
    const row = await pendingRow(id);
    expect(row.riskLevel).toBe('YELLOW');
    expect(row.requiresMfa).toBe(false);
    expect(row.status).toBe('pending');

    const res = await confirmHttp(id, sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.tier).toBe('YELLOW');
    expect(data.requiresMfa).toBe(false);

    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, DAILY_TRANSFER_LIMIT));
    expect(await dailyTotal()).toBe(DAILY_TRANSFER_LIMIT);
    expect(await zhangweiTransfers()).toHaveLength(1);
  });

  it('3b — a transfer of ¥1,000.01 (one cent over the limit) is RED: confirm refuses without MFA, verify completes it', async () => {
    const sessionId = await ensureSession();
    const overLimit = addMoney(DAILY_TRANSFER_LIMIT, '0.01');
    const id = await park(sessionId, overLimit);

    // Amount > the single-transfer limit ⇒ RED and strong verification required at PARK time.
    const row = await pendingRow(id);
    expect(row.riskLevel).toBe('RED');
    expect(row.requiresMfa).toBe(true);
    expect(row.status).toBe('awaiting_mfa');

    // A confirm without a code is refused (RED/MFA) and moves NO money.
    const res = await confirmHttp(id, sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(false);
    expect(data.tier).toBe('RED');
    expect(data.requiresMfa).toBe(true);
    expect(data.status).toBe('awaiting_mfa');
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);

    // Strong verification (the mock code) completes it exactly once.
    const done = await verifyHttp(id, MFA_CODE, sessionId);
    expect(done.status).toBe(200);
    const doneData = payload(done);
    expect(doneData.ok).toBe(true);
    expect(doneData.status).toBe('executed');
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, overLimit));
    expect(await dailyTotal()).toBe(overLimit);
    expect(await zhangweiTransfers()).toHaveLength(1);
  });
});

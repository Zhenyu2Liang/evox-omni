/**
 * tests/app/ledger-consistency-http.test.ts — REAL-application-entry (HTTP) e2e for LEDGER /
 * BALANCE CONSISTENCY.
 *
 * THE INVARIANTS THIS PROVES (all decided in CODE, never by the model):
 *  1. a HUMAN-CONFIRMED transfer debits the checking balance by EXACTLY the transfer amount AND
 *     writes exactly ONE matching ledger row (negative debit, `channel:'TRANSFER'`, the recipient as
 *     `counterpartyId`) — so the balance delta and the sum of ledger deltas AGREE;
 *  2. a REFUSED / FAILED action (wrong-MFA verify, user cancel, foreign-owner denial, or an honest
 *     INSUFFICIENT_FUNDS failure) moves NO money: balance unchanged, NO new transfer row, NO audit
 *     `success` row;
 *  3. N confirmed transfers accumulate consistently: the balance drops by the EXACT sum and exactly
 *     N transfer ledger rows exist.
 *
 * These specs drive the REAL Next.js App Router route handlers — importing the exported `POST` from
 * `@/app/api/chat/route`, `@/app/api/actions/[id]/{confirm,verify,cancel}/route` and invoking them with
 * REAL `NextRequest` objects (see `./harness.ts`). The whole production stack runs underneath
 * (route → `@/agent` runTurn/confirm → banking tools → security gateway `beforeToolCall` →
 * Banking SDK → the test SQLite); only the MODEL is scripted (`tests/setup.ts` forces `LLM_MODE=mock`).
 * Offline, no API key, no network.
 *
 * BOOTSTRAP (cookie-only): identity comes SOLELY from the `banking_session` cookie. A body `sessionId`
 * that disagrees with the cookie (INCLUDING "no cookie") is rejected with `409 CONFLICT`, so the FIRST
 * turn OMITS `sessionId` and sends NO cookie — the route MINTS the session and sets the cookie — and
 * every later request carries `Cookie: banking_session=<id>` (the harness `sessionId` option). A
 * `?sessionId=`/`?userId=` query param NEVER authenticates.
 *
 * DB lifecycle matches the other DB-backed suites: reset + seed before each test, disconnect after.
 * Every parking turn uses a FRESH session id (the in-process circuit breaker is keyed by
 * `sessionId`); NO fake timers (the demo clock `DEMO_NOW = 2026-09-25 12:00` anchors the day window).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { getOrCreateSession } from '@/agent';
import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import { MFA_CODE } from '@/lib/constants';
import { addMoney, centsToMoney, moneyToCents, normalizeMoney, subtractMoney } from '@/lib/money';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  actionUrl,
  chatUrl,
  idCtx,
  postJson,
  type HttpResult,
} from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (¥23,580) — the funding account money must move out of. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** Recipient 张伟 — resolves unambiguously from the seeded contacts. */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The seeded checking balance (¥23,580). */
const SEEDED_BALANCE = normalizeMoney(CHECKING.balance);

/** The confirmed-transfer amount in Test 1 (≤ ¥1000 ⇒ YELLOW, confirmation only). */
const CONFIRMED_AMOUNT = '200';
/** The RED amount in the wrong-MFA refusal (Test 2) (> ¥1000 ⇒ strong verification). */
const RED_AMOUNT = '5000';
/** The cancel amount in the cancel refusal (Test 2) (≤ ¥1000 ⇒ YELLOW). */
const CANCEL_AMOUNT = '200';
/** The overdraft amount whose execution fails honestly (INSUFFICIENT_FUNDS) (Test 3). */
const OVERDRAFT_AMOUNT = '30000';

/**
 * The amounts of the N transfers Test 4 confirms. Each is ≤ ¥1000 AND the running total stays
 * ≤ ¥1000 (200 + 300 + 150 = 650), so EVERY transfer is a plain YELLOW confirmation — no
 * execution-time escalation to RED/MFA.
 */
const ACCUMULATED_AMOUNTS = ['200', '300', '150'] as const;

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

/* -------------------------------------------------------------------------- event narrowing */

type ConfirmationEvent = Extract<AgentStreamEvent, { type: 'confirmation_required' }>;

function confirmationOf(events: readonly AgentStreamEvent[]): ConfirmationEvent | undefined {
  return events.find((event): event is ConfirmationEvent => event.type === 'confirmation_required');
}

/* -------------------------------------------------------------------------------- invokers */

/**
 * Bootstrap a session via the COOKIE-ONLY recipe: NO cookie and a body that OMITS `sessionId`.
 * The route mints the session, returns the id in the body and sets the `banking_session` cookie to
 * that SAME id — asserted here, because every later request trusts only that cookie.
 */
async function startSession(message: string): Promise<ChatTurnResponse> {
  const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), { message });
  expect(res.status, `chat turn failed: ${JSON.stringify(res.data)}`).toBe(200);
  const data = payload(res);
  expect(data.sessionId).toBe(`demo:${DEMO_USER_ID}`);
  expect(res.headers.get('set-cookie')).toBeNull();
  return data;
}

/** The single un-settled `PendingAction` the parking turn persisted for `sessionId`. */
function parked(sessionId: string) {
  return getTestPrisma().pendingAction.findFirstOrThrow({
    where: { sessionId, status: { in: ['pending', 'awaiting_mfa'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * Invoke a real action route handler. The dynamic-route `ctx` MUST be passed explicitly (the harness
 * defaults it to `idCtx('')`), and identity travels as the `banking_session` COOKIE — a
 * `?sessionId=` query param would be IGNORED.
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

function cancelAction(id: string, sessionId?: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(cancelPost, actionUrl(id, 'cancel'), {}, {
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

/**
 * The SUM of EVERY ledger delta on the checking account (cent-safe) — the "sum of ledger deltas"
 * the balance must agree with. The seeded rows are NOT expected to sum to the seeded balance (the
 * seed is a snapshot, not a replay of history), so the invariant asserted is on the DELTAS.
 */
async function checkingLedgerSum(): Promise<string> {
  const rows = await getTestPrisma().transaction.findMany({ where: { accountId: CHECKING.id } });
  return centsToMoney(rows.reduce((sum, transaction) => sum + transaction.amountMinor, 0n));
}

/** Every ledger row paid to 张伟 (the money-moved-exactly-once probe; the seed pays 妈妈 instead). */
function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/** A cheap immutable snapshot of the checking ledger state (balance + ledger sum + 张伟 rows). */
interface LedgerSnapshot {
  balance: string;
  ledgerSum: string;
  transferCount: number;
}

async function snapshotLedger(): Promise<LedgerSnapshot> {
  const [balance, ledgerSum, transfers] = await Promise.all([
    checkingBalance(),
    checkingLedgerSum(),
    zhangweiTransfers(),
  ]);
  return { balance, ledgerSum, transferCount: transfers.length };
}

/** Count of audit `success` rows for a session (the "no authorized movement was audited" probe). */
function successAuditCount(sessionId: string): Promise<number> {
  return getTestPrisma().auditLog.count({ where: { sessionId, status: 'success' } });
}

/**
 * Assert a REFUSED / FAILED action moved NO money: balance, ledger sum and 张伟's transfer-row count
 * are byte-identical to the pre-action snapshot AND no audit `success` row was written.
 */
async function expectNoMovement(
  before: LedgerSnapshot,
  sessionId: string,
  label: string,
): Promise<void> {
  const after = await snapshotLedger();
  expect(after.balance, `${label}: the balance changed`).toBe(before.balance);
  expect(after.ledgerSum, `${label}: the ledger sum changed`).toBe(before.ledgerSum);
  expect(after.transferCount, `${label}: a transfer ledger row appeared`).toBe(before.transferCount);
  expect(await successAuditCount(sessionId), `${label}: an audit 'success' row was written`).toBe(0);
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ----------------------------------------------------------------------------------- tests */

describe('[integration] POST /api/actions/[id]/confirm — confirmed transfer ledger consistency', () => {
  it('[integration] 1 — a confirmed ¥200 YELLOW transfer debits the balance by exactly ¥200, writes ONE matching transfer row, and balance delta === ledger delta', async () => {
    const turn = await startSession(`给张伟转${CONFIRMED_AMOUNT}元`);

    // The turn PARKS the transfer (YELLOW) — nothing has moved yet.
    const confirmation = confirmationOf(turn.events);
    expect(confirmation, 'expected a YELLOW confirmation_required event').toBeDefined();
    const row = await parked(turn.sessionId);
    expect(row.toolName).toBe('transfer_money');
    expect(row.riskLevel).toBe('YELLOW');
    expect(confirmation!.actionId).toBe(row.id);

    const before = await snapshotLedger();
    expect(before.balance).toBe(SEEDED_BALANCE);
    expect(before.transferCount).toBe(0);

    // A human CONFIRM executes the ORIGINAL validated args exactly once.
    const res = await confirmAction(row.id, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('YELLOW');

    const after = await snapshotLedger();

    // 1a. The balance decrement EQUALS the transfer amount (cent-safe).
    expect(subtractMoney(before.balance, after.balance)).toBe(normalizeMoney(CONFIRMED_AMOUNT));
    expect(after.balance).toBe(subtractMoney(SEEDED_BALANCE, CONFIRMED_AMOUNT));

    // 1b. Exactly ONE new ledger row exists, matching amount / direction / recipient / account.
    const transfers = await zhangweiTransfers();
    expect(transfers).toHaveLength(1);
    const tx = transfers[0];
    expect(tx.userId).toBe(DEMO_USER_ID);
    expect(tx.accountId).toBe(CHECKING.id);
    expect(tx.amountMinor).toBe(-moneyToCents(CONFIRMED_AMOUNT));
    expect(tx.direction).toBe('DEBIT');
    expect(tx.category).toBe('转账');
    expect(tx.channel).toBe('TRANSFER');
    expect(tx.counterpartyId).toBe(ZHANGWEI.id);
    expect(tx.merchant).toBe('转账给张伟');
    expect(tx.currency).toBe('CNY');

    // 1c. The balance delta and the sum of ledger deltas AGREE — both equal the amount.
    const balanceDelta = subtractMoney(before.balance, after.balance);
    const ledgerDelta = subtractMoney(before.ledgerSum, after.ledgerSum);
    expect(ledgerDelta).toBe(normalizeMoney(CONFIRMED_AMOUNT));
    expect(balanceDelta).toBe(ledgerDelta);

    // 1d. Exactly one audit `success` row records the single confirmed decision.
    expect(await successAuditCount(turn.sessionId)).toBe(1);
  });
});

describe('[integration] POST /api/actions — refused actions move NO money', () => {
  it('[integration] 2 — a wrong-MFA verify, a user cancel and a foreign-owner denial each leave the balance, the ledger and the audit log untouched', async () => {
    // (a) A RED transfer whose verify carries a WRONG code is refused — no movement.
    const redTurn = await startSession(`给张伟转${RED_AMOUNT}元`);
    const redRow = await parked(redTurn.sessionId);
    expect(redRow.riskLevel).toBe('RED');
    expect(redRow.status).toBe('awaiting_mfa');

    const redBefore = await snapshotLedger();
    const wrongCode = await verifyAction(redRow.id, '000000', redTurn.sessionId);
    expect(wrongCode.status).toBe(200);
    const wrongData = payload(wrongCode);
    expect(wrongData.ok).toBe(false);
    expect(wrongData.mfaResult).toBe('failed');
    expect(wrongData.status).toBe('awaiting_mfa');
    await expectNoMovement(redBefore, redTurn.sessionId, 'wrong-MFA verify');

    // (b) A YELLOW transfer the human CANCELS is never executed — no movement.
    const cancelTurn = await startSession(`给张伟转${CANCEL_AMOUNT}元`);
    const cancelRow = await parked(cancelTurn.sessionId);
    expect(cancelRow.riskLevel).toBe('YELLOW');

    const cancelBefore = await snapshotLedger();
    const cancelled = await cancelAction(cancelRow.id, cancelTurn.sessionId);
    expect(cancelled.status).toBe(200);
    const cancelData = payload(cancelled);
    expect(cancelData.status).toBe('cancelled');
    await expectNoMovement(cancelBefore, cancelTurn.sessionId, 'cancel');

    // (c) A FOREIGN OWNER (a different but REAL persisted session) is denied with 403 — no movement.
    const ownerTurn = await startSession(`给张伟转${CANCEL_AMOUNT}元`);
    const ownerRow = await parked(ownerTurn.sessionId);
    const foreignSessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
    expect(foreignSessionId).not.toBe(ownerTurn.sessionId);
    await getTestPrisma().pendingAction.update({ where: { id: ownerRow.id }, data: { sessionId: foreignSessionId } });

    const ownerBefore = await snapshotLedger();
    const denied = await confirmAction(ownerRow.id, foreignSessionId);
    expect(denied.status).toBe(403);
    expect(failure(denied).code).toBe('SECURITY_DENIED');
    await expectNoMovement(ownerBefore, ownerTurn.sessionId, 'foreign-owner denial');

    // Across all three refusals the checking balance is still the seeded one and 张伟 got nothing.
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);
  });
});

describe('[integration] POST /api/actions/[id]/verify — honest failure moves NO money', () => {
  it('[integration] 3 — an INSUFFICIENT_FUNDS execution refuses with ok:false/failed, moves NO money and audits as failed (never success)', async () => {
    const turn = await startSession(`给张伟转${OVERDRAFT_AMOUNT}元`);

    const row = await parked(turn.sessionId);
    expect(row.toolName).toBe('transfer_money');
    expect(row.status).toBe('awaiting_mfa');

    const before = await snapshotLedger();

    const res = await verifyAction(row.id, MFA_CODE, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(false);
    expect(data.status).toBe('failed');

    // The failed execution moved NO money and wrote NO audit `success` (it recorded the real failure).
    await expectNoMovement(before, turn.sessionId, 'INSUFFICIENT_FUNDS failure');
    const audit = await getTestPrisma().auditLog.findFirstOrThrow({
      where: { sessionId: turn.sessionId, toolName: 'transfer_money' },
    });
    expect(audit.status).toBe('failed');
    expect(audit.confirmed).toBe(true);
  });
});

describe('[integration] POST /api/actions/[id]/confirm — N confirmed transfers accumulate', () => {
  it('[integration] 4 — three confirmed YELLOW transfers reduce the balance by the EXACT sum and leave exactly three transfer ledger rows', async () => {
    const total = ACCUMULATED_AMOUNTS.reduce((sum, amount) => addMoney(sum, amount), '0.00');
    // The running total must stay within the ¥1000 confirmation-only limit so every transfer is YELLOW.
    expect(moneyToCents(total)).toBeLessThanOrEqual(moneyToCents('1000.00'));

    const before = await snapshotLedger();
    expect(before.balance).toBe(SEEDED_BALANCE);

    // Each transfer parks + confirms in its OWN fresh session (the breaker is keyed by sessionId);
    // the day's transfer total is per-USER, so the accumulation is still exercised.
    for (const amount of ACCUMULATED_AMOUNTS) {
      const turn = await startSession(`给张伟转${amount}元`);
      const row = await parked(turn.sessionId);
      expect(row.riskLevel, `a ¥${amount} transfer must be YELLOW`).toBe('YELLOW');

      const res = await confirmAction(row.id, turn.sessionId);
      expect(res.status).toBe(200);
      const data = payload(res);
      expect(data.ok).toBe(true);
      expect(data.status).toBe('executed');
      // No execution-time escalation: the running total never crosses ¥1000.
      expect(data.tier).toBe('YELLOW');
    }

    const after = await snapshotLedger();

    // The balance is reduced by the EXACT sum; the ledger delta agrees.
    expect(subtractMoney(before.balance, after.balance)).toBe(normalizeMoney(total));
    expect(subtractMoney(before.ledgerSum, after.ledgerSum)).toBe(normalizeMoney(total));
    expect(after.balance).toBe(subtractMoney(SEEDED_BALANCE, total));

    // Exactly N transfer ledger rows exist, one per transfer amount, each a DEBIT to 张伟.
    const transfers = await zhangweiTransfers();
    expect(transfers).toHaveLength(ACCUMULATED_AMOUNTS.length);
    const orderMinorUnits = (left: bigint, right: bigint) => left < right ? -1 : left > right ? 1 : 0;
    const ledgerAmounts = transfers.map(transaction => transaction.amountMinor).sort(orderMinorUnits);
    const expectedAmounts = ACCUMULATED_AMOUNTS.map(amount => -moneyToCents(amount)).sort(orderMinorUnits);
    expect(ledgerAmounts).toEqual(expectedAmounts);
    for (const tx of transfers) {
      expect(tx.direction).toBe('DEBIT');
      expect(tx.channel).toBe('TRANSFER');
      expect(tx.category).toBe('转账');
      expect(tx.counterpartyId).toBe(ZHANGWEI.id);
      expect(tx.accountId).toBe(CHECKING.id);
    }

    // One audit `success` row per confirmed transfer (each executed exactly once).
    expect(await getTestPrisma().auditLog.count({ where: { toolName: 'transfer_money', status: 'success' } })).toBe(
      ACCUMULATED_AMOUNTS.length,
    );
  });
});

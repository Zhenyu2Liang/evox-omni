/**
 * terminal-state-settle.test.ts — TERMINAL-STATE settlement regression.
 *
 * LOCKS IN the merged behavior that a confirm / verify / cancel on an ALREADY-TERMINAL action is a
 * STABLE, NON-DESTRUCTIVE domain outcome:
 *   - `agent/confirmation.ts#cancelAction` wraps a gateway `CONFLICT` (cancelling an already-settled
 *     `executed`/`failed` action) into a stable `ok:false` outcome that carries the action's CURRENT
 *     persisted status via `conflictOutcome` — it is NOT a 409 and it NEVER mutates the terminal row.
 *     The API maps that outcome to HTTP 200 (a domain outcome, not an HTTP error).
 *   - A repeat confirm / cancel can never roll back a committed side effect or double-charge: the
 *     exactly-once gateway CAS refuses the transition while the ledger/money stay byte-for-byte.
 *
 * Driven through the REAL public facades ONLY — the real `@/app/api/actions/[id]/{confirm,cancel}`
 * route handlers + the real `@/agent` runtime + the real Banking SDK over real SQLite. No model.
 * DB-backed: `prisma/test.db`, `resetDatabase()` per test, a UNIQUE session per test (the in-process
 * circuit breaker is keyed by `sessionId`). No production code, helpers/ or sibling suites are touched.
 */
import { afterAll, beforeEach, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { executeGatedTool, getOrCreateSession } from '@/agent';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import type { PendingActionStatus } from '@/lib/contracts/security';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

// The seeded demo user + checking account (see `tests/helpers/fixtures.ts`). 张伟 is a real seeded
// contact — the gateway resolves the recipient SERVER-SIDE at park time, so a resolvable name is REQUIRED.
const userId = 'user_liming';
const CHECKING_ACCOUNT_ID = 'acct_checking';
const OPENING_BALANCE = 23580;
const RECIPIENT = '张伟';
const AMOUNT = 200;

beforeEach(() => resetDatabase());
afterAll(() => disconnectTestPrisma());

// --- inline helpers (route call convention mirrors `confirmation-policy.test.ts`) ----------------
type Route = typeof confirmPost;

function request(id: string, sessionId: string, body: object = {}): NextRequest {
  return new NextRequest(`http://localhost/api/actions/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` },
    body: JSON.stringify(body),
  });
}

async function call(handler: Route, id: string, sessionId: string, body: object = {}) {
  const response = await handler(request(id, sessionId, body), { params: Promise.resolve({ id }) });
  return { http: response.status, body: await response.json() };
}

/** Park a standalone YELLOW `transfer_money` (¥200 ≤ ¥1000 and daily ≤ ¥1000) on a UNIQUE session. */
async function parkTransfer(amount = AMOUNT) {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const action = await executeGatedTool({
    userId,
    sessionId,
    toolName: 'transfer_money',
    args: { name: RECIPIENT, amount },
    userRequest: '终态结算回归',
  });
  expect(action.pendingActionId).toBeTruthy();
  return { id: action.pendingActionId!, sessionId };
}

const balance = async () =>
  (await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING_ACCOUNT_ID } })).balance;

/** Count the transfer DEBIT ledger rows for the demo user at a given magnitude. */
const transferDebits = (amount: number) =>
  getTestPrisma().transaction.count({ where: { userId, amount: -amount, channel: 'TRANSFER' } });

const actionRow = (id: string) =>
  getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id } });

/**
 * Assert a stable TERMINAL domain outcome: HTTP 200, `ok:false`, and the status equals the action's
 * CURRENT persisted status (never a fabricated `cancelled`, never a raw HTTP error).
 */
function expectTerminalSettle(body: unknown, status: PendingActionStatus) {
  const data = (body as { data: { ok: boolean; status: PendingActionStatus; events: unknown[] } }).data;
  expect(data.ok).toBe(false);
  expect(data.status).toBe(status);
  expect(data.events).toEqual([]);
  return data;
}

it('cancelling an EXECUTED action is a stable 200 domain outcome that never rolls back the committed side effect', async () => {
  const p = getTestPrisma();
  const action = await parkTransfer(AMOUNT);

  // Confirm executes the transfer: the debit + ledger row commit and the action is terminal `executed`.
  const confirmed = await call(confirmPost, action.id, action.sessionId);
  expect(confirmed.http).toBe(200);
  expect(confirmed.body.data).toMatchObject({ ok: true, status: 'executed', tier: 'YELLOW' });
  expect(await balance()).toBe(OPENING_BALANCE - AMOUNT);
  expect(await transferDebits(AMOUNT)).toBe(1);
  const settled = await actionRow(action.id);
  expect(settled.status).toBe('executed');
  expect(settled.resultJson).toBeTruthy();

  // Cancel an ALREADY-EXECUTED action: a DOMAIN outcome (HTTP 200), NOT a 409/throw, carrying the
  // CURRENT persisted status — never the fabricated `cancelled`.
  const cancelled = await call(cancelPost, action.id, action.sessionId);
  expect(cancelled.http).toBe(200);
  const outcome = expectTerminalSettle(cancelled.body, 'executed');
  expect(outcome).toMatchObject({ actionId: action.id, tier: 'YELLOW', requiresMfa: false });
  expect((cancelled.body.data as { message: string }).message).toBeTruthy();

  // NON-DESTRUCTIVE: money, ledger and the terminal row are all unchanged (no rollback, no re-charge).
  expect(await balance()).toBe(OPENING_BALANCE - AMOUNT);
  expect(await transferDebits(AMOUNT)).toBe(1);
  expect(await actionRow(action.id)).toMatchObject({ status: 'executed', resultJson: settled.resultJson });
  expect(await p.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } })).toBe(1);
});

it('cancelling a FAILED action keeps the terminal status and mutates nothing', async () => {
  const p = getTestPrisma();
  const action = await parkTransfer(AMOUNT);

  // Produce the terminal `failed` state the human decision would settle to (a settled, never-executed
  // action); the exact same convention used across the confirmation suites.
  await p.pendingAction.update({ where: { id: action.id }, data: { status: 'failed' } });

  const cancelled = await call(cancelPost, action.id, action.sessionId);
  expect(cancelled.http).toBe(200);
  const outcome = expectTerminalSettle(cancelled.body, 'failed');
  expect(outcome).toMatchObject({ actionId: action.id, tier: 'YELLOW' });

  // A failed action never moved money; cancelling it changes neither the balance nor the ledger.
  expect(await balance()).toBe(OPENING_BALANCE);
  expect(await transferDebits(AMOUNT)).toBe(0);
  expect(await actionRow(action.id)).toMatchObject({ status: 'failed', resultJson: null });
  expect(await p.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } })).toBe(0);
  expect(await p.executionReceipt.count()).toBe(0);
});

it('a REPEAT confirm of an executed transfer is idempotent and never double-charges', async () => {
  const p = getTestPrisma();
  const action = await parkTransfer(AMOUNT);

  const first = await call(confirmPost, action.id, action.sessionId);
  expect(first.http).toBe(200);
  expect(first.body.data).toMatchObject({ ok: true, status: 'executed' });
  expect(await balance()).toBe(OPENING_BALANCE - AMOUNT);
  expect(await transferDebits(AMOUNT)).toBe(1);

  // The SECOND confirm of the SAME action is refused by the exactly-once CAS: a stable 200 `ok:false`
  // reporting the ALREADY-EXECUTED status — never a second execution, never an HTTP error.
  const second = await call(confirmPost, action.id, action.sessionId);
  expect(second.http).toBe(200);
  const outcome = expectTerminalSettle(second.body, 'executed');
  expect(outcome).toMatchObject({ actionId: action.id, tier: 'YELLOW' });

  // EXACTLY ONE debit/ledger row and a single-debit balance: the repeat confirm is a factual no-op.
  expect(await p.transaction.count({ where: { userId, amount: -AMOUNT, channel: 'TRANSFER' } })).toBe(1);
  expect(await balance()).toBe(OPENING_BALANCE - AMOUNT);
  expect(await p.executionReceipt.count()).toBe(1);
  expect(await actionRow(action.id)).toMatchObject({ status: 'executed' });
});

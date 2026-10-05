/**
 * tests/app/cancel-during-authorization-http.test.ts — REAL-application-entry (HTTP) e2e for
 * CANCEL-DURING-AUTHORIZATION, driven through a CONTROLLED BARRIER.
 *
 * THE INVARIANT THIS PROVES: a human cancel that lands WHILE a gated transfer's park/authorization
 * is still in flight can never be bypassed by a later confirm, and a confirm that lands FIRST can
 * never be rolled back by a later cancel. Either way the ledger and the day-transfer total reflect
 * ONLY the movement that was actually authorized, and after a cancel NO newly-executable
 * `PendingAction` survives for the session. The decision is made ENTIRELY in code (the gateway's
 * exactly-once CAS claim in `security/security-gateway.ts`), never by the model.
 *
 * THE BARRIER TECHNIQUE (this is the point of the spec):
 *   The real plan runner (`runSubmitPlan`) executes each node through an injected `runTool` port.
 *   This spec wraps that port (`parkingBarrier(sessionId).runTool`) so it:
 *     1. routes the node through the REAL gate (`executeGatedTool` from `@/agent`) — which PERSISTS
 *        the `PendingAction` on the blocked path (the park) — then
 *     2. resolves `park` (handing the persisted action id back to the test) and
 *     3. AWAITS a deferred `gate` promise — the barrier — holding the whole plan run open.
 *   While the run is held at the barrier the test issues REAL HTTP calls (`POST /api/actions/[id]/
 *   cancel` then `/confirm`, or the reverse) against the already-persisted action, so the human
 *   decision genuinely INTERLEAVES with the in-flight park/authorization instead of running after it.
 *   `release()` then lets the held node settle (`waiting_confirmation`).
 *
 * Only the MODEL is scripted (`tests/setup.ts` forces `LLM_MODE=mock`); the route handlers, the
 * gateway chokepoint, the Banking SDK and SQLite are all real. Offline, no API key, no network.
 *
 * IDENTITY IS COOKIE-ONLY: the session is minted via `getOrCreateSession(userId)` and carried to the
 * real action routes as the `banking_session` cookie (the harness `sessionId` option); a
 * `?sessionId=` query param is IGNORED. Deterministic DB lifecycle (reset + seed per test) and NO
 * fake timers.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { executeGatedTool, getOrCreateSession } from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import type { PendingActionStatus } from '@/lib/contracts/security';
import { security } from '@/security';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, idCtx, postJson, type HttpResult } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (¥23,580) — the account the parked transfer would draw from. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** Recipient 张伟 — the parked transfer's payee (the money-moved-at-most-once probe). */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The seeded checking balance (¥23,580). */
const SEEDED_BALANCE = CHECKING.balance;

/** The parked transfer amount (≤ ¥1000 ⇒ confirmation-only / YELLOW at PARK time). */
const TRANSFER_AMOUNT = 200;
/** The natural-language request the parked transfer is attributed to (audit + gate context). */
const TRANSFER_REQUEST = `给张伟转${TRANSFER_AMOUNT}元`;

/** The single-node DAG whose only node is a gated `transfer_money` call. */
const transferNode = {
  id: 'transfer',
  name: `转${TRANSFER_AMOUNT}给张伟`,
  kind: 'tool',
  tool: 'transfer_money',
  args: { name: '张伟', amount: TRANSFER_AMOUNT },
  dependencies: [],
};

/**
 * `PendingAction` statuses that an action could still be executed from. A settled action (`executed`
 * / `failed` / `cancelled`) is NOT here — the "no newly-executable action survives" probe.
 */
const EXECUTABLE_STATUSES: PendingActionStatus[] = ['pending', 'awaiting_mfa', 'confirmed'];

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

/**
 * A cancel of an ALREADY-SETTLED action must be REFUSED — never reported as a success. The real
 * route surfaces the gateway's `CONFLICT` either as the error envelope (`409`,
 * `{ ok:false, error.code:'CONFLICT' }`) or as an honest domain refusal (`200`, `data.ok:false`);
 * both mean "already settled, nothing cancelled". Neither may ever be `ok:true`/`cancelled`.
 */
function expectCancelOfSettledRefused(res: HttpResult<Envelope<ActionResponse>>): void {
  const refusedAsError =
    res.status === 409 && res.data?.ok === false && res.data?.error?.code === 'CONFLICT';
  const refusedAsDomain = res.status === 200 && res.data?.ok === true && res.data?.data?.ok === false;
  expect(
    refusedAsError || refusedAsDomain,
    `a cancel of a settled action must be refused, got ${res.status} ${JSON.stringify(res.data)}`,
  ).toBe(true);
}

/* -------------------------------------------------------------------------------- invokers */

/**
 * Invoke the REAL cancel/confirm route handlers. The dynamic-route `ctx` MUST be passed explicitly
 * (the harness defaults to `idCtx('')`) and `sessionId` travels as the `banking_session` COOKIE —
 * identity is cookie-only, so a `?sessionId=` query param would be IGNORED.
 */
function cancelHttp(id: string, sessionId: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(cancelPost, actionUrl(id, 'cancel'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

function confirmHttp(id: string, sessionId: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(confirmPost, actionUrl(id, 'confirm'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

/* ------------------------------------------------------------------------- the barrier seam */

/** The controlled barrier exposed to a spec (see the module doc). */
interface ParkingBarrier {
  /** Resolves with the parked `PendingAction` id ONCE the gate has persisted it (and is held). */
  park: Promise<string | undefined>;
  /** Releases the held `runTool` so the plan's node settles. */
  release: () => void;
  /** The gateway-routed per-node runner to hand to `runSubmitPlan`. */
  runTool: PlanRunTool;
}

/**
 * Build the barrier-wrapped, gateway-routed `runTool` for `sessionId`.
 *
 * Each node call is routed through the REAL gate (`executeGatedTool`), which persists the
 * `PendingAction` on the blocked (parked) path; the runner then signals `park` with that id and
 * AWAITS a deferred `gate` promise, holding the whole plan run open until `release()`.
 */
function parkingBarrier(sessionId: string): ParkingBarrier {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalParked!: (id: string | undefined) => void;
  const park = new Promise<string | undefined>((resolve) => {
    signalParked = resolve;
  });

  const runTool: PlanRunTool = async (toolName, args) => {
    // Route through the REAL security chokepoint: a gated call is BLOCKED and its PendingAction
    // persisted here (never executed), a GREEN call would execute inline.
    const outcome = await executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName,
      args,
      userRequest: TRANSFER_REQUEST,
    });
    signalParked(outcome.pendingActionId);
    // THE BARRIER: hold the in-flight park here so the spec's HTTP cancel/confirm can interleave.
    await gate;
    return outcome;
  };

  return { park, release, runTool };
}

/* ----------------------------------------------------------------------------- DB helpers */

/** Current 活期 balance (¥23,580 seeded). */
async function checkingBalance(): Promise<number> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return account.balance;
}

/** Every ledger row paid to 张伟 (the money-moved-at-most-once probe). */
function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/** The session's `PendingAction`s that could still be EXECUTED (settled ones are excluded). */
function executableActions(sessionId: string) {
  return getTestPrisma().pendingAction.findMany({
    where: { sessionId, status: { in: EXECUTABLE_STATUSES } },
  });
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ----------------------------------------------------------------------------------- tests */

describe('[integration] cancel during authorization — the cancel WINS (lands, then a confirm arrives)', () => {
  it('(a) a cancel landing while the park is in flight revokes the action: a later confirm is refused as cancelled, moves NO money, the day total stays ¥0, and NO executable PendingAction survives', async () => {
    const sessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;

    // Start the real plan run (NOT awaited): its only node routes through the barrier.
    const barrier = parkingBarrier(sessionId);
    const planRun = runSubmitPlan(
      DEMO_USER_ID,
      { goal: TRANSFER_REQUEST, nodes: [transferNode] },
      { sessionId, runTool: barrier.runTool },
    );

    // The gate has persisted the ¥200 transfer's PendingAction and is now HELD at the barrier.
    const parkedId = await barrier.park;
    expect(parkedId, 'the gated ¥200 transfer must PARK (persist a PendingAction)').toBeDefined();
    const actionId = parkedId as string;

    const parkedRow = await getTestPrisma().pendingAction.findUniqueOrThrow({
      where: { id: actionId },
    });
    expect(parkedRow.toolName).toBe('transfer_money');
    expect(parkedRow.status).toBe('pending');
    expect(parkedRow.riskLevel).toBe('YELLOW');

    // (1) THE CANCEL LANDS WHILE THE PARK IS IN FLIGHT — a real HTTP request interleaved at the gate.
    const cancelled = await cancelHttp(actionId, sessionId);
    expect(cancelled.status).toBe(200);
    const cancelData = payload(cancelled);
    expect(cancelData.status).toBe('cancelled');
    expect(cancelData.actionId).toBe(actionId);

    // Release the barrier: the held node settles as a park (`waiting_confirmation`).
    barrier.release();
    const plan = await planRun;
    expect(plan.ok).toBe(true);
    expect((plan.data as { status?: string } | undefined)?.status).toBe('waiting_confirmation');

    // (2) THE CONFIRM LANDS AFTER — the action was revoked, so it must be refused as `cancelled`.
    const confirmed = await confirmHttp(actionId, sessionId);
    expect(confirmed.status).toBe(200);
    const confirmData = payload(confirmed);
    expect(confirmData.ok).toBe(false);
    expect(confirmData.status).toBe('cancelled');
    expect(confirmData.actionId).toBe(actionId);

    // NOTHING moved: no 张伟 debit, the balance is untouched and the day total is still ¥0.
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(0);

    // NO newly-executable PendingAction survives for the session (the revoked one is `cancelled`).
    expect(await executableActions(sessionId)).toHaveLength(0);
    const after = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(after.status).toBe('cancelled');

    // The cancel is a GATED human decision ⇒ exactly ONE audit row (`cancelled`); the refused
    // confirm must not write an audit row (audit is written only for a settled decision).
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].toolName).toBe('transfer_money');
    expect(audits[0].confirmed).toBe(false);
    expect(audits[0].status).toBe('cancelled');
  });
});

describe('[integration] cancel during authorization — the CONFIRM WINS (lands, then a cancel arrives)', () => {
  it('(b) a confirm landing while the park is in flight executes ¥200 exactly once; a later cancel is refused and cannot roll the ledger/daily total back', async () => {
    const sessionId = (await getOrCreateSession(DEMO_USER_ID)).sessionId;

    const barrier = parkingBarrier(sessionId);
    const planRun = runSubmitPlan(
      DEMO_USER_ID,
      { goal: TRANSFER_REQUEST, nodes: [transferNode] },
      { sessionId, runTool: barrier.runTool },
    );

    const parkedId = await barrier.park;
    expect(parkedId, 'the gated ¥200 transfer must PARK (persist a PendingAction)').toBeDefined();
    const actionId = parkedId as string;

    // (1) THE CONFIRM LANDS FIRST — still inside the barrier window, so the human decision
    //     interleaves with the in-flight park. The original validated args execute exactly once.
    const confirmed = await confirmHttp(actionId, sessionId);
    expect(confirmed.status).toBe(200);
    const confirmData = payload(confirmed);
    expect(confirmData.ok).toBe(true);
    expect(confirmData.status).toBe('executed');
    expect(confirmData.tier).toBe('YELLOW');
    expect(confirmData.requiresMfa).toBe(false);

    // (2) THE CANCEL LANDS AFTER — the action is already settled, so it must be refused (never a
    //     rollback, never a success).
    const cancelled = await cancelHttp(actionId, sessionId);
    expectCancelOfSettledRefused(cancelled);

    // Release the barrier: the plan run settles (its node was parked).
    barrier.release();
    const plan = await planRun;
    expect(plan.ok).toBe(true);

    // The ledger reflects ONLY the authorized movement: exactly ONE ¥200 debit to 张伟.
    const transfers = await zhangweiTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].amount).toBe(-TRANSFER_AMOUNT);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE - TRANSFER_AMOUNT);
    expect(await security.risk.computeDailyTransferTotal(DEMO_USER_ID)).toBe(TRANSFER_AMOUNT);

    // The action is TERMINAL (`executed`): the refused cancel left NO re-executable action behind.
    expect(await executableActions(sessionId)).toHaveLength(0);
    const after = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(after.status).toBe('executed');

    // The refused cancel rolled nothing back and wrote nothing: exactly ONE audit row, from the
    // executed confirm (`success` / `confirmed:true`) — never a `cancelled` entry.
    const audits = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].toolName).toBe('transfer_money');
    expect(audits[0].status).toBe('success');
    expect(audits[0].confirmed).toBe(true);
  });
});

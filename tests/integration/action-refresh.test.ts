/**
 * integration/action-refresh.test.ts — STATE-CONVERGENCE / REFRESH regression suite.
 *
 * WHY this suite exists: the failure mode that matters for the demo is never "the model said
 * something wrong" — it is a USER REFRESH (or a process RESTART) observing a state that does not
 * match the persisted truth. `GET /api/actions` IS the page-refresh read model and
 * `POST /api/actions/[id]/recover` is the entry point a refreshed user can reach WITHOUT knowing the
 * hidden action id. This spec pins the three convergence guarantees the refresh path must keep:
 *
 *  (1) `processing` — a confirm that is STILL IN FLIGHT is surfaced by a plain refresh with
 *      `attention:'processing'` and is NEVER mis-finalized by a concurrent duplicate confirm (which
 *      must be refused with NO second side effect). The window is PERSISTED, not in-process: the row
 *      is `confirmed` while `agent/confirmation.ts#withLiveConfirmation` holds a NON-EXPIRED
 *      execution lease (`PendingAction.executionLeaseOwner`/`executionLeaseExpiresAt`), which
 *      `agent/confirmation-recovery.ts#classifyConfirmedAction` reads. Once the continuation lands,
 *      the row is terminal `executed` and stops being surfaced.
 *  (2) `recoverable` — a WEDGE (the SDK side effect committed but the result+status transaction
 *      rolled back: `confirmed` with `resultJson === null`) stays VISIBLE after a refresh AND after a
 *      full module-graph reload (a simulated service restart with an EMPTY in-process liveness
 *      registry). It is recoverable through the FRESHLY imported recovery route, discovered from the
 *      refresh payload alone — never from a remembered action id.
 *  (3) IDEMPOTENT — recovering a success never DOWNGRADES it: a repeat recovery leaves the terminal
 *      status `executed`, adds no second side effect, no second execution audit row and no ledger
 *      movement.
 *
 * Real app-entry layer: REAL Next.js route handlers, the REAL confirmation continuation, the REAL
 * Banking SDK and the REAL isolated test SQLite (`prisma/test.db`) run in-process; no model/LLM is
 * on this path. The ONLY mock is REAL fault injection (`setPendingActionStatus` rejects, so the
 * result+status transaction genuinely rolls back) plus ONE REAL barrier
 * (`securityGateway.authorizeAction` holds a request mid-flight) — never a fabricated return value.
 * Every assertion re-reads persisted DB state.
 */
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import type { ToolName } from '@/lib/contracts/tools';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { securityGateway } from '@/security/security-gateway';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { centsToMoney, moneyToCents, subtractMoney } from '@/lib/money';

const userId = 'user_liming';
/** Seeded 活期 balance (fixtures ACCOUNTS) — debited by the transferred amount. */
const CHECKING_BALANCE = '23580.00';

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

/** A real route handler's `POST` for `/…/[id]` (app-layer `IdRouteContext`). */
type RoutePost = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
/** A real route handler's `GET` (no params). */
type RouteGet = (req: NextRequest) => Promise<Response>;

/** A one-shot barrier a test can await and then release. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
/** Bound a barrier wait so a never-engaging injection FAILS LOUD instead of hanging the suite. */
async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * REAL barrier #1: hold the NEXT successful gateway authorization of a gated action AFTER the row has
 * been claimed (`confirmed`) and its persisted lease written, but BEFORE the side effect executes —
 * exactly the in-flight window a page refresh can land in.
 */
function holdNextAuthorizeAction() {
  const reached = deferred();
  const release = deferred();
  const original = securityGateway.authorizeAction.bind(securityGateway);
  let held = false;
  const spy = vi.spyOn(securityGateway, 'authorizeAction').mockImplementation(async (actionId, opts) => {
    const value = await original(actionId, opts);
    if (value.ok && !held) {
      held = true;
      reached.release();
      await release.promise;
    }
    return value;
  });
  return {
    spy,
    reached,
    release,
    isHeld: () => held,
    calls: () => spy.mock.calls.length,
    restore: () => spy.mockRestore(),
  };
}

/** The REAL fault injection: make the NEXT result+status transaction genuinely roll back. */
function wedgeResultTransaction() {
  return vi
    .spyOn(pendingActionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('review: convergence result transaction failed'));
}

/** POST `/api/actions/[id]/<path>` through a specific (possibly freshly imported) handler. */
async function postAction(handler: RoutePost, path: string, id: string, sessionId: string, body = '{}') {
  const res = await handler(
    new NextRequest(`http://localhost/api/actions/${id}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${sessionId}` },
      body,
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}
const confirmRaw = (id: string, s: string) => postAction(confirmPost, 'confirm', id, s);
const verifyRaw = (id: string, s: string, code = '123456') =>
  postAction(verifyPost, 'verify', id, s, JSON.stringify({ code }));
const recoverRaw = (id: string, s: string) => postAction(recoverPost, 'recover', id, s);

/** `GET /api/actions` — the page-refresh path the UI uses to restore pending entries. */
async function listActions(sessionId: string, handler: RouteGet = actionsGet) {
  const res = await handler(
    new NextRequest('http://localhost/api/actions', {
      headers: { cookie: `banking_session=${sessionId}` },
    }),
  );
  const body = await res.json();
  const actions: Array<{ id: string; status: string; attention: string; toolName: string }> =
    body.data ?? [];
  return {
    status: res.status,
    actions,
    ids: actions.map((a) => a.id),
    row: (id: string) => actions.find((a) => a.id === id),
  };
}

/** Park a standalone (no plan link) gated action and return its `PendingAction` id. */
async function parkStandalone(
  sessionId: string,
  toolName: ToolName,
  args: Record<string, unknown>,
  userRequest: string,
): Promise<string> {
  const gated = await executeGatedTool({ sessionId, userId, toolName, args, userRequest });
  expect(gated.ok).toBe(false);
  expect(gated.requiresConfirmation).toBe(true);
  const id = gated.pendingActionId;
  expect(id).toBeTruthy();
  return id!;
}

const debitCount = (amount: string) =>
  getTestPrisma().transaction.count({
    where: { userId, amountMinor: -moneyToCents(amount), counterpartyId: 'contact_zhangwei' },
  });
const checkingBalance = async () =>
  centsToMoney((await getTestPrisma().account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor);

describe('[integration] state convergence across a refresh / restart', () => {
  it('an IN-FLIGHT confirm is surfaced as `processing` and a concurrent duplicate is refused without a second side effect', async () => {
    const s = (await getOrCreateSession(userId)).sessionId;
    const p = getTestPrisma();
    const id = await parkStandalone(s, 'transfer_money', { name: '张伟', amount: '200.00' }, '给张伟转200元');
    expect(await debitCount('200.00')).toBe(0);

    const barrier = holdNextAuthorizeAction();
    const firstRun = confirmRaw(id, s);
    let during: {
      status: string;
      resultJson: string | null;
      executionLeaseOwner: string | null;
      executionLeaseExpiresAt: Date | null;
    } | null = null;
    let duringExpiryMs: number | null = null;
    let listedDuring: Awaited<ReturnType<typeof listActions>> | undefined;
    let duplicate: Awaited<ReturnType<typeof confirmRaw>> | undefined;
    let leaseAfterDuplicate: string | null | undefined;
    let listedAfterDuplicate: Awaited<ReturnType<typeof listActions>> | undefined;
    let debitsWhileInFlight = -1;
    let barrierCalls = 0;
    let first: Awaited<ReturnType<typeof confirmRaw>> | undefined;
    try {
      await bounded(barrier.reached.promise);
      barrierCalls = barrier.calls(); // read BEFORE the restore below clears the spy's call record
      during = await p.pendingAction.findUnique({ where: { id } });
      duringExpiryMs = during?.executionLeaseExpiresAt?.getTime() ?? null;
      // (1) The page refresh lands INSIDE the in-flight window.
      listedDuring = await listActions(s);
      debitsWhileInFlight = await debitCount('200.00');
      // (2) A CONCURRENT duplicate confirm for the SAME action, while the first still holds it.
      duplicate = await confirmRaw(id, s);
      leaseAfterDuplicate = (await p.pendingAction.findUnique({ where: { id } }))?.executionLeaseOwner;
      listedAfterDuplicate = await listActions(s);
    } finally {
      barrier.release.release();
      first = await firstRun;
      barrier.restore();
    }

    const stored = await p.pendingAction.findUnique({ where: { id } });
    const listedAfter = await listActions(s);
    const debitsFinal = await debitCount('200.00');
    const balanceFinal = await checkingBalance();

    console.log(
      'REVIEW_CONVERGENCE_PROCESSING_REFRESH',
      JSON.stringify({
        barrierEngaged: barrier.isHeld(),
        barrierCalls,
        inFlightStatus: during?.status,
        inFlightResult: during?.resultJson,
        inFlightLease: during?.executionLeaseOwner,
        inFlightLeaseFuture: duringExpiryMs !== null && duringExpiryMs > Date.now(),
        refreshHttp: listedDuring?.status,
        refreshAttention: listedDuring?.row(id)?.attention,
        refreshStatus: listedDuring?.row(id)?.status,
        debitsWhileInFlight,
        duplicateHttp: duplicate?.status,
        duplicateOk: duplicate?.body?.data?.ok,
        duplicateStatus: duplicate?.body?.data?.status,
        leaseSurvivedDuplicate: leaseAfterDuplicate === during?.executionLeaseOwner,
        refreshAttentionAfterDuplicate: listedAfterDuplicate?.row(id)?.attention,
        finalHttp: first?.status,
        finalOk: first?.body?.data?.ok,
        finalResponseStatus: first?.body?.data?.status,
        storedStatus: stored?.status,
        storedResult: stored?.resultJson,
        storedLease: stored?.executionLeaseOwner,
        debitsFinal,
        balanceFinal,
        surfacedAfter: listedAfter.ids.includes(id),
      }),
    );

    // The barrier REALLY engaged and the row really is mid-flight (nothing fabricated).
    expect(barrier.isHeld()).toBe(true);
    expect(barrierCalls).toBeGreaterThanOrEqual(1);
    expect(during?.status).toBe('confirmed');
    expect(during?.resultJson).toBeNull();
    expect(during?.executionLeaseOwner).toBeTruthy();
    expect(duringExpiryMs).not.toBeNull();
    expect(duringExpiryMs!).toBeGreaterThan(Date.now()); // the lease is ACTIVE, not expired

    // (1) The refresh surfaces the IN-FLIGHT row as `processing` — never as a wedge to finalize.
    expect(listedDuring?.status).toBe(200);
    expect(listedDuring?.row(id)?.status).toBe('confirmed');
    expect(listedDuring?.row(id)?.attention).toBe('processing');
    // Nothing has executed yet: the continuation is held BEFORE its side effect.
    expect(debitsWhileInFlight).toBe(0);

    // (2) The duplicate is REFUSED as an honest domain outcome, and its cleanup does NOT evict the
    // still-live continuation's persisted lease (so the row keeps reading `processing`).
    expect(duplicate?.status).toBe(200);
    expect(duplicate?.body?.data?.ok).toBe(false);
    expect(duplicate?.body?.data?.status).toBe('confirmed');
    expect(leaseAfterDuplicate).toBe(during?.executionLeaseOwner);
    expect(listedAfterDuplicate?.row(id)?.attention).toBe('processing');

    // (3) Released: the ORIGINAL continuation completes normally, exactly once, and converges.
    expect(first?.status).toBe(200);
    expect(first?.body?.data?.ok).toBe(true);
    expect(first?.body?.data?.status).toBe('executed');
    expect(stored?.status).toBe('executed');
    expect(stored?.resultJson).not.toBeNull();
    expect(stored?.executionLeaseOwner).toBeNull(); // released in the `finally`
    expect(debitsFinal).toBe(1); // the duplicate produced NO second debit
    expect(balanceFinal).toBe(subtractMoney(CHECKING_BALANCE, '200.00'));
    expect(listedAfter.ids).not.toContain(id); // terminal `executed` is no longer surfaced
    expect(listedAfter.row(id)).toBeUndefined();
  });

  it('an IN-FLIGHT MFA verify is surfaced as `processing` too (verify variant)', async () => {
    const s = (await getOrCreateSession(userId)).sessionId;
    const p = getTestPrisma();
    // ¥5000 ⇒ RED ⇒ parked `awaiting_mfa`.
    const id = await parkStandalone(s, 'transfer_money', { name: '张伟', amount: '5000.00' }, '给张伟转5000元');
    const parked = await p.pendingAction.findUnique({ where: { id } });
    expect(parked?.status).toBe('awaiting_mfa');
    expect(parked?.requiresMfa).toBe(true);

    const barrier = holdNextAuthorizeAction();
    const firstRun = verifyRaw(id, s, '123456');
    let during: { status: string; resultJson: string | null; executionLeaseOwner: string | null } | null = null;
    let listedDuring: Awaited<ReturnType<typeof listActions>> | undefined;
    let barrierCalls = 0;
    let first: Awaited<ReturnType<typeof verifyRaw>> | undefined;
    try {
      await bounded(barrier.reached.promise);
      barrierCalls = barrier.calls(); // read BEFORE the restore below clears the spy's call record
      during = await p.pendingAction.findUnique({ where: { id } });
      listedDuring = await listActions(s);
    } finally {
      barrier.release.release();
      first = await firstRun;
      barrier.restore();
    }

    const stored = await p.pendingAction.findUnique({ where: { id } });
    const listedAfter = await listActions(s);

    console.log(
      'REVIEW_CONVERGENCE_PROCESSING_VERIFY',
      JSON.stringify({
        barrierEngaged: barrier.isHeld(),
        barrierCalls,
        inFlightStatus: during?.status,
        inFlightResult: during?.resultJson,
        inFlightLease: during?.executionLeaseOwner,
        refreshAttention: listedDuring?.row(id)?.attention,
        refreshStatus: listedDuring?.row(id)?.status,
        finalOk: first?.body?.data?.ok,
        finalResponseStatus: first?.body?.data?.status,
        mfaResult: first?.body?.data?.mfaResult,
        storedStatus: stored?.status,
        storedLease: stored?.executionLeaseOwner,
        debitFinal: await debitCount('5000.00'),
        balanceFinal: await checkingBalance(),
        surfacedAfter: listedAfter.ids.includes(id),
      }),
    );

    expect(barrier.isHeld()).toBe(true);
    expect(barrierCalls).toBeGreaterThanOrEqual(1);
    expect(during?.status).toBe('confirmed');
    expect(during?.executionLeaseOwner).toBeTruthy();

    // A refresh during the in-flight MFA continuation reads `processing` — same durable rule.
    expect(listedDuring?.row(id)?.status).toBe('confirmed');
    expect(listedDuring?.row(id)?.attention).toBe('processing');

    // It converges to a real success: exactly one debit, lease released, terminal ⇒ not surfaced.
    expect(first?.status).toBe(200);
    expect(first?.body?.data?.ok).toBe(true);
    expect(first?.body?.data?.status).toBe('executed');
    expect(stored?.status).toBe('executed');
    expect(stored?.executionLeaseOwner).toBeNull();
    expect(await debitCount('5000.00')).toBe(1);
    expect(await checkingBalance()).toBe(subtractMoney(CHECKING_BALANCE, '5000.00'));
    expect(listedAfter.ids).not.toContain(id);
  });

  it('a no-result wedge stays VISIBLE after a refresh AND after a module reload, and is recoverable from the refreshed entry', async () => {
    const s = (await getOrCreateSession(userId)).sessionId;
    const p = getTestPrisma();
    const id = await parkStandalone(s, 'transfer_money', { name: '张伟', amount: '300.00' }, '给张伟转300元');

    const wedge = wedgeResultTransaction();
    const first = await confirmRaw(id, s);
    expect(wedge.mock.calls.length).toBe(1); // the injection HIT the target
    wedge.mockRestore();

    const wedged = await p.pendingAction.findUnique({ where: { id } });
    expect(first.status).toBe(500); // the result+status transaction really rolled back
    expect(wedged?.status).toBe('confirmed');
    expect(wedged?.resultJson).toBeNull();
    expect(wedged?.executionLeaseOwner).toBeNull(); // released by the `finally` — a genuine WEDGE
    expect(await debitCount('300.00')).toBe(1); // the side effect DID commit

    // (1) Plain refresh, SAME process: the wedge is visible and recovery-capable.
    const listedBefore = await listActions(s);
    const beforeRow = listedBefore.row(id);

    // (2) Simulated RESTART: reset the module registry so the freshly imported routes/recovery module
    // build a NEW, EMPTY in-process liveness registry — only PERSISTED state survives.
    vi.resetModules();
    const freshRecovery = await import('@/agent/confirmation-recovery');
    const freshList = await import('@/app/api/actions/route');
    const freshRecover = await import('@/app/api/actions/[id]/recover/route');
    const liveAfterReload = freshRecovery.liveCount(id);
    const listedAfterReload = await listActions(s, freshList.GET as RouteGet);

    // The recovery entry is DISCOVERED from the refreshed payload alone (no remembered id).
    const discovered = listedAfterReload.actions.find((a) => a.toolName === 'transfer_money');
    if (discovered === undefined) {
      throw new Error('review: the refreshed list did not surface the wedged standalone action');
    }
    const recovered = await postAction(freshRecover.POST as RoutePost, 'recover', discovered.id, s);

    const stored = await p.pendingAction.findUnique({ where: { id } });
    const listedAfterRecovery = await listActions(s, freshList.GET as RouteGet);

    console.log(
      'REVIEW_CONVERGENCE_WEDGE_AFTER_REFRESH',
      JSON.stringify({
        wedgeCalls: 1,
        firstHttp: first.status,
        wedgedStatus: wedged?.status,
        wedgedResult: wedged?.resultJson,
        wedgedLease: wedged?.executionLeaseOwner,
        refreshHttp: listedBefore.status,
        refreshVisible: listedBefore.ids.includes(id),
        refreshAttention: beforeRow?.attention,
        refreshStatus: beforeRow?.status,
        liveAfterReload,
        reloadHttp: listedAfterReload.status,
        reloadVisible: listedAfterReload.ids.includes(id),
        reloadAttention: listedAfterReload.row(id)?.attention,
        reloadStatus: listedAfterReload.row(id)?.status,
        discoveredIdMatches: discovered.id === id,
        recoveredHttp: recovered.status,
        recoveredOk: recovered.body.data?.ok,
        recoveredActionId: recovered.body.data?.actionId,
        recoveredStatus: recovered.body.data?.status,
        storedStatus: stored?.status,
        storedResult: stored?.resultJson,
        debitFinal: await debitCount('300.00'),
        balanceFinal: await checkingBalance(),
        surfacedAfter: listedAfterRecovery.ids.includes(id),
      }),
    );

    // Pre-reload convergence: visible + recovery-capable, NOT a settled row.
    expect(listedBefore.status).toBe(200);
    expect(listedBefore.ids).toContain(id);
    expect(beforeRow?.status).toBe('confirmed');
    expect(beforeRow?.attention).toBe('recoverable');

    // The "restart" really produced an EMPTY in-process registry (only persisted state remains).
    expect(liveAfterReload).toBe(0);

    // Post-reload convergence: STILL visible with the SAME recovery-capable classification.
    expect(listedAfterReload.status).toBe(200);
    expect(listedAfterReload.ids).toContain(id);
    expect(listedAfterReload.row(id)?.status).toBe('confirmed');
    expect(listedAfterReload.row(id)?.attention).toBe('recoverable');

    // Recovering from the refreshed entry alone settles the TRUE outcome: the debit had committed,
    // so the receipt-first recovery lands `executed` — the tool is never re-run.
    expect(discovered.id).toBe(id);
    expect(recovered.status).toBe(200);
    expect(recovered.body.data?.ok).toBe(true);
    expect(recovered.body.data?.actionId).toBe(id);
    expect(recovered.body.data?.status).toBe('executed');
    expect(stored?.status).toBe('executed');
    expect(stored?.resultJson).not.toBeNull();
    expect(await debitCount('300.00')).toBe(1); // exactly one side effect across the whole saga
    expect(await checkingBalance()).toBe(subtractMoney(CHECKING_BALANCE, '300.00'));
    expect(listedAfterRecovery.ids).not.toContain(id); // terminal ⇒ no longer surfaced
  });

  it('recovery does NOT downgrade a success and is idempotent on a repeat recovery + refresh', async () => {
    const s = (await getOrCreateSession(userId)).sessionId;
    const p = getTestPrisma();
    const id = await parkStandalone(s, 'transfer_money', { name: '张伟', amount: '250.00' }, '给张伟转250元');

    const wedge = wedgeResultTransaction();
    const first = await confirmRaw(id, s);
    expect(wedge.mock.calls.length).toBe(1); // the injection HIT the target
    wedge.mockRestore();

    const wedged = await p.pendingAction.findUnique({ where: { id } });
    expect(first.status).toBe(500);
    expect(wedged?.status).toBe('confirmed');
    expect(wedged?.resultJson).toBeNull();

    // Recovery #1 — the legitimate settlement of the wedge.
    const rec1 = await recoverRaw(id, s);
    const stored1 = await p.pendingAction.findUnique({ where: { id } });
    const audit1 = await p.auditLog.count({ where: { dedupeKey: `exec:${id}` } });
    const debit1 = await debitCount('250.00');
    const balance1 = await checkingBalance();

    // Recovery #2 — the SAME entry point again (a repeat click / a second refresh-driven recovery).
    const rec2 = await recoverRaw(id, s);
    const stored2 = await p.pendingAction.findUnique({ where: { id } });
    const audit2 = await p.auditLog.count({ where: { dedupeKey: `exec:${id}` } });
    const debit2 = await debitCount('250.00');
    const balance2 = await checkingBalance();

    // And the refresh path after the repeat.
    const listedAfter = await listActions(s);

    console.log(
      'REVIEW_CONVERGENCE_RECOVERY_IDEMPOTENT',
      JSON.stringify({
        firstHttp: first.status,
        rec1Http: rec1.status,
        rec1Ok: rec1.body.data?.ok,
        rec1Message: rec1.body.data?.message,
        statusAfterRecovery: stored1?.status,
        resultAfterRecovery: stored1?.resultJson ? JSON.parse(stored1.resultJson).ok : null,
        auditAfterRecovery: audit1,
        debitAfterRecovery: debit1,
        balanceAfterRecovery: balance1,
        rec2Http: rec2.status,
        rec2Ok: rec2.body.data?.ok,
        rec2Status: rec2.body.data?.status,
        rec2Message: rec2.body.data?.message,
        statusAfterRepeat: stored2?.status,
        auditAfterRepeat: audit2,
        debitAfterRepeat: debit2,
        balanceAfterRepeat: balance2,
        surfacedAfter: listedAfter.ids.includes(id),
      }),
    );

    // Recovery #1 lands the TRUE success (the debit had committed) exactly once.
    expect(rec1.status).toBe(200);
    expect(rec1.body.data?.ok).toBe(true);
    expect(rec1.body.data?.status).toBe('executed');
    expect(stored1?.status).toBe('executed');
    expect(stored1?.resultJson ? JSON.parse(stored1.resultJson).ok : null).toBe(true);
    expect(audit1).toBe(1); // ONE execution audit row for this action
    expect(debit1).toBe(1);
    expect(balance1).toBe(subtractMoney(CHECKING_BALANCE, '250.00'));

    // Recovery #2 must NOT downgrade the success, must NOT re-run the tool and must NOT re-audit.
    expect(rec2.status).toBe(200);
    expect(rec2.body.data?.ok).toBe(false); // honest "nothing left to recover"
    expect(rec2.body.data?.status).toBe('executed'); // reports the CURRENT persisted status
    expect(stored2?.status).toBe('executed'); // unchanged — never downgraded
    expect(stored2?.status).toBe(stored1?.status);
    expect(audit2).toBe(audit1); // no second execution audit (dedupe key `exec:<id>`)
    expect(debit2).toBe(debit1); // no second ledger movement
    expect(balance2).toBe(balance1); // no second debit
    expect(listedAfter.ids).not.toContain(id); // terminal `executed` stays unsurfaced
  });
});

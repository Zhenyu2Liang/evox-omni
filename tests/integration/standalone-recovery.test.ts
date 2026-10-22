/**
 * integration/standalone-recovery.test.ts — DEFECT 3: STANDALONE gated-action wedge recovery.
 *
 * A STANDALONE (non-plan) YELLOW/RED gated action that parks a `PendingAction` and whose SDK side
 * effect COMMITS but whose result+status transaction ROLLS BACK is left `confirmed` with
 * `resultJson === null` — a WEDGE. A repeat confirm/verify is rejected by the gateway's exactly-once
 * CAS with `CONFLICT`, and `agent/confirmation-recovery.ts#recoverStandaloneWedge` is the ONLY place
 * that row can settle:
 *  - a verified command receipt reconstructs the original successful result without another write;
 *  - absent a receipt, only proven idempotent transfer recovery may re-enter authorization;
 *  - other unknown writes require reconciliation without a blind retry or fabricated failure.
 * `GET /api/actions` SURFACES every row that still needs the user or still needs settling:
 * `pending`/`awaiting_mfa` (attention `decision`) and `needs_reconciliation` (attention
 * `reconciliation`) — PLUS, under the NEW contract, a `confirmed` row that is NOT SETTLED (no
 * persisted result): attention `processing` while it still holds a non-expired persisted execution
 * lease, `recoverable` when it is a proven-idempotent standalone tool, else `reconciliation`. So a
 * standalone wedge stranded at `confirmed` IS VISIBLE after a plain refresh (the user can find the
 * recovery entry), while a SETTLED `executed`/`failed` row is NOT surfaced — the `not.toContain`
 * assertions further down stay correct.
 *
 * Real app-entry layer: the REAL Next.js route handlers, the REAL confirmation continuation, the REAL
 * Banking SDK and the REAL isolated test SQLite (`prisma/test.db`) run in-process; only the MODEL is
 * absent (no LLM in this path). The ONLY mock is REAL fault injection
 * (`vi.spyOn(pendingActionRepo,'claimPendingAction')` failing ONLY the settlement CAS) that makes the
 * result+status transaction genuinely roll back — every assertion re-reads persisted DB state.
 */
import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { centsToMoney } from '@/lib/money';
import { getDemoSession, executeGatedTool } from '@/agent';
import type { ToolName } from '@/lib/contracts/tools';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
/** Seeded 活期 balance (fixtures ACCOUNTS) — unchanged by a card action, −amount after a transfer. */
const CHECKING_BALANCE = '23580.00';

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

/** A real route handler's `POST` for `/…/[id]` (app-layer `IdRouteContext`). */
type RoutePost = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** Confirm under the server-owned demo session through a possibly freshly imported route. */
async function confirmWith(handler: RoutePost, id: string, _sessionId: string) {
  const res = await handler(
    new NextRequest(`http://localhost/api/actions/${id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}

/** The default confirm route (top-level import). */
const confirmRaw = (id: string, sessionId: string) => confirmWith(confirmPost, id, sessionId);

/** `GET /api/actions` — the page-refresh path the UI uses to restore pending entries. */
async function listActions(_sessionId: string) {
  const res = await actionsGet(
    new NextRequest('http://localhost/api/actions'),
  );
  const body = await res.json();
  const actions: Array<{ id: string; status: string }> = body.data ?? [];
  return { status: res.status, actions, ids: actions.map((a) => a.id) };
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

/** The REAL fault injection: make the NEXT result+status transaction genuinely roll back. */
function wedgeResultTransaction() {
  // Settlement persists the decision state through `claimPendingAction` INSIDE the same
  // `prisma.$transaction` that writes `resultJson` and the execution audit, so failing that one
  // CAS rolls the whole transaction back and leaves the row `confirmed` with `resultJson: null`
  // AFTER the SDK side effect committed — the real wedge. The authorization CAS also goes through
  // `claimPendingAction`, so filter by argument: only the settlement transition
  // (`from: ['confirmed']` -> a terminal status) is failed, and only on its first call.
  const original = pendingActionRepo.claimPendingAction;
  let hits = 0;
  const spy = vi
    .spyOn(pendingActionRepo, 'claimPendingAction')
    .mockImplementation(async (input, client) => {
      const isSettlement = input.to !== 'confirmed' && input.from.includes('confirmed');
      if (isSettlement && hits === 0) {
        hits += 1;
        throw new Error(review: standalone result transaction failed);
      }
      return client === undefined ? original(input) : original(input, client);
    });
  return { spy, hits: () => hits, restore: () => spy.mockRestore() };
}

it('a STANDALONE transfer wedge is replayed idempotently to executed (side effect exactly once)', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(s, 'transfer_money', { name: '张伟', amount: '200' }, '给张伟转200元');

  const debitWhere = { userId, amountMinor: -20000n, counterpartyId: 'contact_zhangwei' };
  expect(await p.transaction.count({ where: debitWhere })).toBe(0);

  const wedge = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(wedge.hits()).toBe(1); // the injection HIT the settlement transition

  // WEDGED, pre-recovery: side effect COMMITTED, row left `confirmed` with NO persisted result.
  const wedged = await p.pendingAction.findUnique({ where: { id } });
  const listedWhileWedged = await listActions(s);
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();
  expect(await p.transaction.count({ where: debitWhere })).toBe(1);
  expect((await p.account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor).toBe(2338000n);
  // NEW CONTRACT (`GET /api/actions` classifies a NON-SETTLED `confirmed` row): a standalone wedge
  // stranded at `confirmed` with NO active execution lease is SURFACED — `attention` `recoverable`
  // (a safely recoverable tool) or `reconciliation` (one that must be settled manually) — so the
  // user can find the recovery entry AFTER a plain refresh. It is no longer the old "invisible
  // `confirmed` row" defect. (A `confirmed` row WITH a non-expired persisted lease is `processing`;
  // a settled `executed`/`failed` row is still hidden.)
  expect(listedWhileWedged.ids).toContain(id);

  // REPEAT confirm → proven-idempotent replay on the SAME ledger key → terminal `executed`.
  wedge.restore();
  const repeated = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const listed = await listActions(s);
  const debitFinal = await p.transaction.count({ where: debitWhere });
  const balanceFinal = centsToMoney((await p.account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor);

  console.log(
    'REVIEW_STANDALONE_TRANSFER_REPLAY',
    JSON.stringify({
      firstHttp: first.status,
      repeatedHttp: repeated.status,
      repeatedOk: repeated.body.data?.ok,
      actionStatus: stored?.status,
      storedResultOk: stored?.resultJson ? JSON.parse(stored.resultJson).ok : null,
      debitFinal,
      balanceFinal,
      visibleAfter: listed.ids.includes(id),
    }),
  );

  expect(repeated.status).toBe(200);
  expect(repeated.body.data?.ok).toBe(true);
  expect(stored?.status).toBe('executed');
  expect(debitFinal).toBe(1); // no second debit
  expect(balanceFinal).toBe('23380.00');
  expect(listed.ids).not.toContain(id); // `executed` is terminal & NOT surfaced
});

it('a standalone limit wedge recovers its original receipt without repeating a card mutation', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(s, 'set_card_limit', { cardId: 'card_credit', category: '\u5a31\u4e50', amount: '1500' }, 'Set the card limit');

  const limitWhere = { cardId: 'card_credit', category: '\u5a31\u4e50' };
  const limitBefore = await p.cardLimit.findMany({ where: limitWhere });
  const txBefore = await p.transaction.count({ where: { userId } });
  expect(limitBefore).toHaveLength(1); expect(limitBefore[0].amountMinor).toBe(300000n);

  const wedge = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(wedge.hits()).toBe(1); // the injection HIT the settlement transition

  // The limit write committed while the separate action status transaction rolled back.
  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();
  expect((await p.cardLimit.findFirstOrThrow({ where: limitWhere })).amountMinor).toBe(150000n);
  await p.cardLimit.updateMany({ where: limitWhere, data: { amountMinor: 50000n } });

  // Receipt replay must preserve a newer independent limit change.
  wedge.restore();
  const repeated = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const limitAfter = await p.cardLimit.findMany({ where: limitWhere });
  const txAfter = await p.transaction.count({ where: { userId } });
  const balance = centsToMoney((await p.account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor);
  const listed = await listActions(s);
  const listedRow = listed.actions.find((a) => a.id === id);

  console.log(
    'REVIEW_STANDALONE_CARD_MUTATION_RECONCILE',
    JSON.stringify({
      firstHttp: first.status,
      repeatedHttp: repeated.status,
      repeatedOk: repeated.body.data?.ok,
      actionStatus: stored?.status,
      limitRowsBefore: limitBefore.length,
      limitRowsAfter: limitAfter.length,
      txBefore,
      txAfter,
      balance,
      visible: listed.ids.includes(id),
      listedRowStatus: listedRow?.status,
    }),
  );

  expect(repeated.status).toBe(200);
  expect(repeated.body.data?.ok).toBe(true);
  expect(repeated.body.data?.status).toBe('executed');
  expect(stored?.status).toBe('executed');
  expect(limitAfter).toHaveLength(1); expect(limitAfter[0].amountMinor).toBe(50000n);
  expect(txAfter).toBe(txBefore); // no ledger movement
  expect(balance).toBe(CHECKING_BALANCE);
  expect(await p.executionReceipt.count({ where: { userId, key: id } })).toBe(1);
  expect(listed.ids).not.toContain(id);
  expect(listedRow).toBeUndefined();
});

it('an orphaned limit action without a receipt remains unknown and is never retried', async () => {
  const sessionId = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const action = await pendingActionRepo.createPendingAction({
    sessionId, userId, toolName: 'set_card_limit', args: { cardId: 'card_credit', category: '\u5a31\u4e50', amount: '1500' },
    status: 'confirmed', tier: 'YELLOW', requiresMfa: false,
    summary: { title: 'Unknown card limit result', toolName: 'set_card_limit', tier: 'YELLOW', requiresMfa: false, fields: [] },
  });
  expect(await p.executionReceipt.count({ where: { userId, key: action.id } })).toBe(0);
  const recovered = await confirmRaw(action.id, sessionId);
  expect(recovered.status).toBe(200);
  expect(recovered.body.data).toMatchObject({ ok: false, status: 'needs_reconciliation' });
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('needs_reconciliation');
  expect((await p.cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '\u5a31\u4e50' } })).amountMinor).toBe(300000n);
  expect((await listActions(sessionId)).ids).toContain(action.id);
  expect(await p.executionReceipt.count({ where: { userId, key: action.id } })).toBe(0);
});

it('a standalone limit-change receipt is recovered without re-applying its historical limit', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const limitWhere = { cardId: 'card_credit', category: '娱乐' };
  const id = await parkStandalone(
    s,
    'set_card_limit',
    { cardId: 'card_credit', category: '娱乐', amount: '1500' },
    '把娱乐限额设成1500',
  );

  // Seeded 娱乐 limit is ¥3000 — the pending write is ¥1500, so an applied write is OBSERVABLE.
  const seeded = await p.cardLimit.findMany({ where: limitWhere });
  expect(seeded.length).toBe(1);
  expect(seeded[0].amountMinor).toBe(300000n);

  const wedge = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(wedge.hits()).toBe(1); // the injection HIT the settlement transition
  wedge.restore();

  // WEDGED, pre-recovery: the limit WAS applied EXACTLY ONCE (one row, exactly the requested ¥1500).
  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();
  const applied = await p.cardLimit.findMany({ where: limitWhere });
  expect(applied.length).toBe(1); // replace semantics — never a SECOND row
  expect(applied[0].amountMinor).toBe(150000n); // Exactly the requested amount.

  // A LATER, independently authorized change to the same limit (¥500). If the repeat confirm re-invoked
  // the wedged tool, it would clobber this back to ¥1500 — the assertion below catches any replay.
  await p.cardLimit.updateMany({ where: limitWhere, data: { amountMinor: 50000n } });

  const txBeforeRepeat = await p.transaction.count({ where: { userId } });
  const repeated = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const finalLimits = await p.cardLimit.findMany({ where: limitWhere });
  const txAfter = await p.transaction.count({ where: { userId } });
  const balance = centsToMoney((await p.account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor);
  const listed = await listActions(s);

  console.log(
    'REVIEW_STANDALONE_CARD_LIMIT_RECONCILE',
    JSON.stringify({
      firstHttp: first.status,
      repeatedHttp: repeated.status,
      repeatedOk: repeated.body.data?.ok,
      actionStatus: stored?.status,
      finalLimitRows: finalLimits.length,
      finalLimitAmount: finalLimits[0] ? centsToMoney(finalLimits[0].amountMinor) : null,
      txAfter,
      balance,
      visible: listed.ids.includes(id),
    }),
  );

  expect(repeated.status).toBe(200);
  expect(repeated.body.data?.status).toBe('executed');
  expect(stored?.status).toBe('executed');
  expect(finalLimits.length).toBe(1); // no duplicate limit row
  expect(finalLimits[0].amountMinor).toBe(50000n); // The original operation is never re-applied.
  expect(txAfter).toBe(txBeforeRepeat); // no ledger movement
  expect(balance).toBe(CHECKING_BALANCE);
  expect(listed.ids).not.toContain(id);
});

it('a SIMULATED PROCESS RESTART (fresh module graph, empty liveness registry) still recovers the standalone wedge', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(s, 'set_card_limit', { cardId: 'card_credit', category: '\u5a31\u4e50', amount: '1500' }, 'Restore a limit change after restart');

  const wedge = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(wedge.hits()).toBe(1); // the injection HIT the settlement transition
  wedge.restore();

  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();

  // Simulate a new process: reset the module registry so the freshly imported confirm route +
  // recovery module build a NEW, EMPTY per-process liveness registry (`liveConfirmations`), then run
  // the recovery through the FRESH route handler using ONLY persisted server state.
  vi.resetModules();
  const freshRecovery = await import('@/agent/confirmation-recovery');
  expect(freshRecovery.liveCount(id)).toBe(0);
  const freshConfirm = await import('@/app/api/actions/[id]/confirm/route');

  const recovered = await confirmWith(freshConfirm.POST as unknown as RoutePost, id, s);

  // Assert the DB state via a query against the SAME SQLite file (the file is identical).
  const stored = await getTestPrisma().pendingAction.findUnique({ where: { id } });
  const limits = await getTestPrisma().cardLimit.findMany({ where: { cardId: 'card_credit', category: '\u5a31\u4e50' } });
  const listed = await listActions(s);

  console.log(
    'REVIEW_STANDALONE_PROCESS_RESTART',
    JSON.stringify({
      firstHttp: first.status,
      recoveredHttp: recovered.status,
      recoveredOk: recovered.body.data?.ok,
      actionStatus: stored?.status,
      limitRows: limits.length,
      visible: listed.ids.includes(id),
    }),
  );

  expect(recovered.status).toBe(200);
  expect(stored?.status).toBe('executed');
  expect(stored?.status).not.toBe('confirmed');
  expect(limits).toHaveLength(1); expect(limits[0].amountMinor).toBe(150000n);
  expect(await getTestPrisma().executionReceipt.count({ where: { userId, key: id } })).toBe(1);
  expect(listed.ids).not.toContain(id);
});

it('repeat confirm + page refresh after recovery stay consistent (idempotent, no extra side effect)', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(s, 'set_card_limit', { cardId: 'card_credit', category: '\u5a31\u4e50', amount: '1500' }, 'Confirm and refresh the same limit change');

  const limitWhere = { cardId: 'card_credit', category: '\u5a31\u4e50' };

  const wedge = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(wedge.hits()).toBe(1); // the injection HIT the settlement transition
  wedge.restore();

  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();

  // First recovery.
  const recovered = await confirmRaw(id, s);
  expect(recovered.status).toBe(200);
  expect(recovered.body.data?.status).toBe('executed');

  const limitsAfterRecovery = await p.cardLimit.findMany({ where: limitWhere });
  const balanceAfterRecovery = centsToMoney((await p.account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor);
  const txAfterRecovery = await p.transaction.count({ where: { userId } });

  // The SAME confirm AGAIN — idempotent: terminal status unchanged, no new side effect.
  const again = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const limitsAfterAgain = await p.cardLimit.findMany({ where: limitWhere });
  const balanceAfterAgain = centsToMoney((await p.account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor);
  const txAfterAgain = await p.transaction.count({ where: { userId } });

  // The page-refresh path.
  const refreshed = await listActions(s);
  const refreshedRow = refreshed.actions.find((a) => a.id === id);

  console.log(
    'REVIEW_STANDALONE_REPEAT_REFRESH',
    JSON.stringify({
      recoveredStatus: recovered.body.data?.status,
      againHttp: again.status,
      againStatus: again.body.data?.status,
      storedStatus: stored?.status,
      limitsAfterRecovery: limitsAfterRecovery.length,
      limitsAfterAgain: limitsAfterAgain.length,
      txAfterRecovery,
      txAfterAgain,
      balanceAfterRecovery,
      balanceAfterAgain,
      visible: refreshed.ids.includes(id),
      refreshedRowStatus: refreshedRow?.status,
    }),
  );

  expect(again.status).toBe(200);
  expect(stored?.status).toBe('executed');
  expect(stored?.status).toBe(recovered.body.data?.status); // unchanged terminal status
  expect(limitsAfterAgain).toEqual(limitsAfterRecovery);
  expect(limitsAfterAgain).toHaveLength(1); expect(limitsAfterAgain[0].amountMinor).toBe(150000n);
  expect(await p.executionReceipt.count({ where: { userId, key: id } })).toBe(1);
  expect(txAfterAgain).toBe(txAfterRecovery);
  expect(balanceAfterAgain).toBe(balanceAfterRecovery);
  expect(balanceAfterAgain).toBe(CHECKING_BALANCE);
  expect(refreshed.ids).not.toContain(id);
  expect(refreshedRow).toBeUndefined();
});

it('a STANDALONE transfer whose replay FAILS settles failed (never executed) and is not surfaced', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  // Park with a RESOLVABLE, seeded recipient: the gateway resolves the transfer recipient
  // SERVER-SIDE at park time (`security/security-gateway.ts#resolveTransferRecipient`), so an
  // unresolvable name would be rejected as a clarify/validation error and NO `PendingAction`
  // would ever be persisted. The parked args are canonicalized to the resolved `contactId`.
  const id = await parkStandalone(s, 'transfer_money', { name: '张伟', amount: '150' }, '给张伟转150元');
  // THEN remove that contact BEFORE the first confirm so the SDK's EXECUTION-TIME resolution
  // (`banking-sdk/transfer.ts#resolveRecipient` re-reads the contact by id) fails NOT_FOUND:
  // the business write fails, so the idempotent REPLAY fails too — the recovered terminal state
  // must be `failed`, never a fabricated `executed`. (Contact has no FK dependents;
  // `resetDatabase()` in `beforeEach` re-seeds it for the next test.)
  await p.contact.delete({ where: { id: 'contact_zhangwei' } });

  const txBefore = await p.transaction.count({ where: { userId } });

  const wedge = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(wedge.hits()).toBe(1); // the injection HIT the settlement transition
  wedge.restore();

  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();

  const repeated = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const storedResult = stored?.resultJson ? JSON.parse(stored.resultJson) : null;
  const txAfter = await p.transaction.count({ where: { userId } });
  const balance = centsToMoney((await p.account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor);
  const listed = await listActions(s);

  console.log(
    'REVIEW_STANDALONE_FAILED_REPLAY',
    JSON.stringify({
      firstHttp: first.status,
      repeatedHttp: repeated.status,
      repeatedOk: repeated.body.data?.ok,
      actionStatus: stored?.status,
      replayOk: storedResult?.ok,
      txBefore,
      txAfter,
      balance,
      visible: listed.ids.includes(id),
    }),
  );

  expect(repeated.status).toBe(200);
  expect(repeated.body.data?.ok).toBe(false);
  expect(stored?.status).toBe('failed'); // a real failure, never `executed`
  expect(storedResult?.ok).toBe(false); // the TRUE replay outcome is persisted
  expect(txAfter).toBe(txBefore); // no ledger movement
  expect(balance).toBe(CHECKING_BALANCE);
  expect(listed.ids).not.toContain(id); // `failed` is terminal & NOT surfaced
});

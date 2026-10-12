/**
 * integration/standalone-recovery.test.ts — DEFECT 3: STANDALONE gated-action wedge recovery.
 *
 * A STANDALONE (non-plan) YELLOW/RED gated action that parks a `PendingAction` and whose SDK side
 * effect COMMITS but whose result+status transaction ROLLS BACK is left `confirmed` with
 * `resultJson === null` — a WEDGE. A repeat confirm/verify is rejected by the gateway's exactly-once
 * CAS with `CONFLICT`, and `agent/confirmation-recovery.ts#recoverStandaloneWedge` is the ONLY place
 * that row can settle:
 *  - a PROVEN-idempotent standalone tool (`transfer_money` ONLY) is REPLAYED on its ledger key (the
 *    action id) → side effect EXACTLY ONCE, terminal `executed` (or `failed` when the replay itself
 *    fails);
 *  - any OTHER write tool (`apply_virtual_card`, `set_card_limit`, …) transitions to the explicit,
 *    queryable `needs_reconciliation` status — NEVER a fabricated failure, NEVER a rollback.
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
 * (`vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(...)`) that makes the
 * result+status transaction genuinely roll back — every assertion re-reads persisted DB state.
 */
import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import type { ToolName } from '@/lib/contracts/tools';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
/** Seeded 活期 balance (fixtures ACCOUNTS) — unchanged by a card action, −amount after a transfer. */
const CHECKING_BALANCE = 23580;

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

/** A real route handler's `POST` for `/…/[id]` (app-layer `IdRouteContext`). */
type RoutePost = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** POST a confirm through a specific (possibly freshly imported) route handler, with the cookie. */
async function confirmWith(handler: RoutePost, id: string, sessionId: string) {
  const res = await handler(
    new NextRequest(`http://localhost/api/actions/${id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${sessionId}` },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}

/** The default confirm route (top-level import). */
const confirmRaw = (id: string, sessionId: string) => confirmWith(confirmPost, id, sessionId);

/** `GET /api/actions` — the page-refresh path the UI uses to restore pending entries. */
async function listActions(sessionId: string) {
  const res = await actionsGet(
    new NextRequest('http://localhost/api/actions', {
      headers: { cookie: `banking_session=${sessionId}` },
    }),
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
  return vi
    .spyOn(pendingActionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('review: standalone result transaction failed'));
}

it('a STANDALONE transfer wedge is replayed idempotently to executed (side effect exactly once)', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(s, 'transfer_money', { name: '张伟', amount: 200 }, '给张伟转200元');

  const debitWhere = { userId, amount: -200, counterpartyId: 'contact_zhangwei' };
  expect(await p.transaction.count({ where: debitWhere })).toBe(0);

  const spy = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(spy.mock.calls.length).toBe(1); // the injection HIT the target

  // WEDGED, pre-recovery: side effect COMMITTED, row left `confirmed` with NO persisted result.
  const wedged = await p.pendingAction.findUnique({ where: { id } });
  const listedWhileWedged = await listActions(s);
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();
  expect(await p.transaction.count({ where: debitWhere })).toBe(1);
  expect((await p.account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance).toBe(23380);
  // NEW CONTRACT (`GET /api/actions` classifies a NON-SETTLED `confirmed` row): a standalone wedge
  // stranded at `confirmed` with NO active execution lease is SURFACED — `attention` `recoverable`
  // (a safely recoverable tool) or `reconciliation` (one that must be settled manually) — so the
  // user can find the recovery entry AFTER a plain refresh. It is no longer the old "invisible
  // `confirmed` row" defect. (A `confirmed` row WITH a non-expired persisted lease is `processing`;
  // a settled `executed`/`failed` row is still hidden.)
  expect(listedWhileWedged.ids).toContain(id);

  // REPEAT confirm → proven-idempotent replay on the SAME ledger key → terminal `executed`.
  spy.mockRestore();
  const repeated = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const listed = await listActions(s);
  const debitFinal = await p.transaction.count({ where: debitWhere });
  const balanceFinal = (await p.account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance;

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
  expect(balanceFinal).toBe(23380);
  expect(listed.ids).not.toContain(id); // `executed` is terminal & NOT surfaced
});

it('a STANDALONE apply_virtual_card wedge cannot be replayed → settles needs_reconciliation, stays visible, no duplicate card', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(s, 'apply_virtual_card', { label: '旅行备用' }, '申请一张虚拟卡');

  const virtualWhere = { userId, type: 'VIRTUAL' };
  const virtualBefore = await p.card.count({ where: virtualWhere });
  const txBefore = await p.transaction.count({ where: { userId } });
  expect(virtualBefore).toBe(0);

  const spy = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(spy.mock.calls.length).toBe(1); // the injection HIT the target

  // WEDGED, pre-recovery: the virtual card WAS issued, the row is `confirmed` with NO result.
  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();
  expect(await p.card.count({ where: virtualWhere })).toBe(1); // side effect committed exactly once

  // REPEAT confirm → NOT proven idempotent for a standalone key → explicit `needs_reconciliation`.
  spy.mockRestore();
  const repeated = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const virtualAfter = await p.card.count({ where: virtualWhere });
  const txAfter = await p.transaction.count({ where: { userId } });
  const balance = (await p.account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance;
  const listed = await listActions(s);
  const listedRow = listed.actions.find((a) => a.id === id);

  console.log(
    'REVIEW_STANDALONE_VIRTUAL_CARD_RECONCILE',
    JSON.stringify({
      firstHttp: first.status,
      repeatedHttp: repeated.status,
      repeatedOk: repeated.body.data?.ok,
      actionStatus: stored?.status,
      virtualBefore,
      virtualAfter,
      txBefore,
      txAfter,
      balance,
      visible: listed.ids.includes(id),
      listedRowStatus: listedRow?.status,
    }),
  );

  expect(repeated.status).toBe(200);
  expect(repeated.body.data?.ok).toBe(false);
  expect(repeated.body.data?.status).toBe('needs_reconciliation');
  expect(stored?.status).toBe('needs_reconciliation'); // VISIBLE, non-`confirmed` terminal state
  expect(virtualAfter).toBe(1); // the repeat must NOT issue a SECOND virtual card
  expect(txAfter).toBe(txBefore); // no ledger movement
  expect(balance).toBe(CHECKING_BALANCE);
  expect(listed.ids).toContain(id); // `needs_reconciliation` MUST be surfaced
  expect(listedRow?.status).toBe('needs_reconciliation');
});

it('a STANDALONE set_card_limit wedge is never replayed (needs_reconciliation) and never re-applies its old limit', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const limitWhere = { cardId: 'card_credit', category: '娱乐' };
  const id = await parkStandalone(
    s,
    'set_card_limit',
    { cardId: 'card_credit', category: '娱乐', amount: 1500 },
    '把娱乐限额设成1500',
  );

  // Seeded 娱乐 limit is ¥3000 — the pending write is ¥1500, so an applied write is OBSERVABLE.
  const seeded = await p.cardLimit.findMany({ where: limitWhere });
  expect(seeded.length).toBe(1);
  expect(seeded[0].amount).toBe(3000);

  const spy = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(spy.mock.calls.length).toBe(1); // the injection HIT the target
  spy.mockRestore();

  // WEDGED, pre-recovery: the limit WAS applied EXACTLY ONCE (one row, exactly the requested ¥1500).
  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();
  const applied = await p.cardLimit.findMany({ where: limitWhere });
  expect(applied.length).toBe(1); // replace semantics — never a SECOND row
  expect(applied[0].amount).toBe(1500); // exactly the requested amount

  // A LATER, independently authorized change to the same limit (¥500). If the repeat confirm re-invoked
  // the wedged tool, it would clobber this back to ¥1500 — the assertion below catches any replay.
  await p.cardLimit.updateMany({ where: limitWhere, data: { amount: 500 } });

  const txBeforeRepeat = await p.transaction.count({ where: { userId } });
  const repeated = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const finalLimits = await p.cardLimit.findMany({ where: limitWhere });
  const txAfter = await p.transaction.count({ where: { userId } });
  const balance = (await p.account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance;
  const listed = await listActions(s);

  console.log(
    'REVIEW_STANDALONE_CARD_LIMIT_RECONCILE',
    JSON.stringify({
      firstHttp: first.status,
      repeatedHttp: repeated.status,
      repeatedOk: repeated.body.data?.ok,
      actionStatus: stored?.status,
      finalLimitRows: finalLimits.length,
      finalLimitAmount: finalLimits[0]?.amount,
      txAfter,
      balance,
      visible: listed.ids.includes(id),
    }),
  );

  expect(repeated.status).toBe(200);
  expect(repeated.body.data?.status).toBe('needs_reconciliation');
  expect(stored?.status).toBe('needs_reconciliation');
  expect(finalLimits.length).toBe(1); // no duplicate limit row
  expect(finalLimits[0].amount).toBe(500); // NOT re-applied — the tool was never re-invoked
  expect(txAfter).toBe(txBeforeRepeat); // no ledger movement
  expect(balance).toBe(CHECKING_BALANCE);
  expect(listed.ids).toContain(id); // `needs_reconciliation` MUST be surfaced
});

it('a SIMULATED PROCESS RESTART (fresh module graph, empty liveness registry) still recovers the standalone wedge', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(s, 'apply_virtual_card', { label: '重启恢复' }, '申请虚拟卡');

  const spy = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(spy.mock.calls.length).toBe(1); // the injection HIT the target
  spy.mockRestore();

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
  const virtualCount = await getTestPrisma().card.count({ where: { userId, type: 'VIRTUAL' } });
  const listed = await listActions(s);

  console.log(
    'REVIEW_STANDALONE_PROCESS_RESTART',
    JSON.stringify({
      firstHttp: first.status,
      recoveredHttp: recovered.status,
      recoveredOk: recovered.body.data?.ok,
      actionStatus: stored?.status,
      virtualCount,
      visible: listed.ids.includes(id),
    }),
  );

  expect(recovered.status).toBe(200);
  expect(stored?.status).toBe('needs_reconciliation');
  expect(stored?.status).not.toBe('confirmed');
  expect(virtualCount).toBe(1); // no duplicate card across the "restart"
  expect(listed.ids).toContain(id);
});

it('repeat confirm + page refresh after recovery stay consistent (idempotent, no extra side effect)', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(s, 'apply_virtual_card', { label: '刷新一致性' }, '申请虚拟卡');

  const virtualWhere = { userId, type: 'VIRTUAL' };

  const spy = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(spy.mock.calls.length).toBe(1); // the injection HIT the target
  spy.mockRestore();

  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();

  // First recovery.
  const recovered = await confirmRaw(id, s);
  expect(recovered.status).toBe(200);
  expect(recovered.body.data?.status).toBe('needs_reconciliation');

  const virtualAfterRecovery = await p.card.count({ where: virtualWhere });
  const balanceAfterRecovery = (await p.account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance;
  const txAfterRecovery = await p.transaction.count({ where: { userId } });

  // The SAME confirm AGAIN — idempotent: terminal status unchanged, no new side effect.
  const again = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const virtualAfterAgain = await p.card.count({ where: virtualWhere });
  const balanceAfterAgain = (await p.account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance;
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
      virtualAfterRecovery,
      virtualAfterAgain,
      txAfterRecovery,
      txAfterAgain,
      balanceAfterRecovery,
      balanceAfterAgain,
      visible: refreshed.ids.includes(id),
      refreshedRowStatus: refreshedRow?.status,
    }),
  );

  expect(again.status).toBe(200);
  expect(stored?.status).toBe('needs_reconciliation');
  expect(stored?.status).toBe(recovered.body.data?.status); // unchanged terminal status
  expect(virtualAfterAgain).toBe(virtualAfterRecovery); // no additional side effect
  expect(virtualAfterAgain).toBe(1);
  expect(txAfterAgain).toBe(txAfterRecovery);
  expect(balanceAfterAgain).toBe(balanceAfterRecovery);
  expect(balanceAfterAgain).toBe(CHECKING_BALANCE);
  expect(refreshed.ids).toContain(id); // visibility matches the `needs_reconciliation` status
  expect(refreshedRow?.status).toBe('needs_reconciliation');
});

it('a STANDALONE transfer whose replay FAILS settles failed (never executed) and is not surfaced', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  // Park with a RESOLVABLE, seeded recipient: the gateway resolves the transfer recipient
  // SERVER-SIDE at park time (`security/security-gateway.ts#resolveTransferRecipient`), so an
  // unresolvable name would be rejected as a clarify/validation error and NO `PendingAction`
  // would ever be persisted. The parked args are canonicalized to the resolved `contactId`.
  const id = await parkStandalone(s, 'transfer_money', { name: '张伟', amount: 150 }, '给张伟转150元');
  // THEN remove that contact BEFORE the first confirm so the SDK's EXECUTION-TIME resolution
  // (`banking-sdk/transfer.ts#resolveRecipient` re-reads the contact by id) fails NOT_FOUND:
  // the business write fails, so the idempotent REPLAY fails too — the recovered terminal state
  // must be `failed`, never a fabricated `executed`. (Contact has no FK dependents;
  // `resetDatabase()` in `beforeEach` re-seeds it for the next test.)
  await p.contact.delete({ where: { id: 'contact_zhangwei' } });

  const txBefore = await p.transaction.count({ where: { userId } });

  const spy = wedgeResultTransaction();
  const first = await confirmRaw(id, s);
  expect(spy.mock.calls.length).toBe(1); // the injection HIT the target
  spy.mockRestore();

  const wedged = await p.pendingAction.findUnique({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged?.status).toBe('confirmed');
  expect(wedged?.resultJson).toBeNull();

  const repeated = await confirmRaw(id, s);
  const stored = await p.pendingAction.findUnique({ where: { id } });
  const storedResult = stored?.resultJson ? JSON.parse(stored.resultJson) : null;
  const txAfter = await p.transaction.count({ where: { userId } });
  const balance = (await p.account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance;
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

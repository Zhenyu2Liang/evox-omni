/**
 * review-restart-independence.test.ts — recovery correctness depends on PERSISTED data, NOT the
 * in-process liveness / lease registry.
 *
 * WHY this suite exists: the recovery path uses PER-PROCESS auxiliary hints — the reference-counted
 * live-confirmation registry (`agent/confirmation-recovery.ts#liveConfirmations`) and the persisted
 * execution LEASE (`PendingAction.executionLeaseOwner`/`executionLeaseExpiresAt`). A real SERVICE
 * RESTART (or a second instance) starts with an EMPTY registry, so the ONLY thing recovery may rely
 * on is PERSISTED state: the `PendingAction` row (status + `resultJson`), its committed
 * `ExecutionReceipt` and the money ledger.
 *
 * This spec SIMULATES that restart: it builds a GENUINE wedge (the SDK side effect COMMITS but its
 * result+status transaction ROLLS BACK — fault injected at
 * `pendingActionRepo.setPendingActionStatus`, so the row is left `confirmed` + `resultJson=null`),
 * then CLEARS the module graph with `vi.resetModules()` and drives recovery through FRESHLY IMPORTED
 * route handlers. It PROVES the fresh registry is EMPTY (`liveCount===0`) while an artificially
 * retained marker on the OLD graph is NON-empty — so a recovery that still relied on in-process
 * bookkeeping would defer (and fail these assertions), while one that reads PERSISTED evidence lands
 * the TRUE, exactly-once outcome.
 *
 * Real app-entry layer: the REAL Next.js route handlers, the REAL confirmation continuation, the REAL
 * planner executor, the REAL Banking SDK and the REAL isolated test SQLite (`prisma/test.db`) run
 * in-process. The ONLY mock is REAL fault injection that makes the result+status transaction
 * genuinely roll back. Every assertion re-reads persisted DB state.
 */
import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { ToolName } from '@/lib/contracts/tools';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
/** Seeded 活期 balance (fixtures ACCOUNTS) — debited by the transferred amount. */
const CHECKING_BALANCE = 23580;

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

/** A real route handler's `POST` for `/…/[id]` (app-layer `IdRouteContext`). */
type RoutePost = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
/** A real route handler's `GET` (no params). */
type RouteGet = (req: NextRequest) => Promise<Response>;

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
  const parsed = await res.json();
  return { status: res.status, body: parsed, data: parsed.data };
}

const confirmWith = (handler: RoutePost, id: string, sessionId: string) =>
  postAction(handler, 'confirm', id, sessionId);
const recoverWith = (handler: RoutePost, id: string, sessionId: string) =>
  postAction(handler, 'recover', id, sessionId);

/** POST `/api/tasks/[id]` (a plan control verb) through a specific (possibly fresh) handler. */
async function postTask(handler: RoutePost, id: string, sessionId: string, action: string) {
  const res = await handler(
    new NextRequest(`http://localhost/api/tasks/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${sessionId}` },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id }) },
  );
  const parsed = await res.json();
  return { status: res.status, body: parsed, data: parsed.data };
}

/** `GET /api/actions` — the page-refresh read model (through a possibly fresh handler). */
async function listActions(sessionId: string, handler: RouteGet) {
  const res = await handler(
    new NextRequest('http://localhost/api/actions', {
      headers: { cookie: `banking_session=${sessionId}` },
    }),
  );
  const parsed = await res.json();
  const actions: Array<{ id: string; status: string; attention: string; toolName: string }> =
    parsed.data ?? [];
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
  expect(gated.pendingActionId).toBeTruthy();
  return gated.pendingActionId!;
}

/** The `runTool` the planner uses: every node routes through the gateway-authorized gated path. */
const runner = (sessionId: string) =>
  (toolName: string, args: Record<string, unknown>, ctx: { taskId: string; nodeId: string }) =>
    executeGatedTool({
      sessionId,
      userId,
      toolName: toolName as ToolName,
      args,
      userRequest: '审查重启独立性',
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });

/** The REAL fault injection: make the NEXT result+status transaction genuinely roll back. */
function wedgeResultTransaction() {
  return vi
    .spyOn(pendingActionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('review: restart-independence result transaction failed'));
}

const debitCount = (amount: number) =>
  getTestPrisma().transaction.count({
    where: { userId, amount: -amount, counterpartyId: 'contact_zhangwei' },
  });
const checkingBalance = async () =>
  (await getTestPrisma().account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance;

/** Defensive: a lingering persisted lease would look like `processing`; clear it so only evidence remains. */
async function clearLeaseIfAny(id: string): Promise<void> {
  const p = getTestPrisma();
  const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  if (row.executionLeaseOwner !== null) {
    await p.pendingAction.update({
      where: { id },
      data: { executionLeaseOwner: null, executionLeaseExpiresAt: null },
    });
  }
}

it('a standalone transfer wedge recovers from PERSISTED evidence after the in-process registry is cleared', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(sessionId, 'transfer_money', { name: '张伟', amount: 200 }, '给张伟转200元');
  expect(await debitCount(200)).toBe(0);

  const spy = wedgeResultTransaction();
  const first = await confirmWith(confirmPost, id, sessionId);
  const injectionCalls = spy.mock.calls.length;
  spy.mockRestore();
  expect(injectionCalls).toBeGreaterThanOrEqual(1); // the injection FIRED (the target was hit)

  // WEDGE: the atomic result+status transaction rolled back, so the row carries NO result…
  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();
  // …while the SDK side effect DID commit (debit + ledger + receipt written in ONE tx) — the only
  // durable truth a restarted process can read.
  expect(await debitCount(200)).toBe(1);
  expect(await checkingBalance()).toBe(CHECKING_BALANCE - 200);
  expect(await p.executionReceipt.count({ where: { userId, key: id } })).toBe(1);
  await clearLeaseIfAny(id);

  // (1) BEFORE the restart the in-process registry is NON-empty (an artificially retained marker).
  const beforeRestart = await import('@/agent/confirmation-recovery');
  beforeRestart.retainAction(id);
  const liveBeforeRestart = beforeRestart.liveCount(id);

  // (2) SIMULATED SERVICE RESTART — clear the module graph; only PERSISTED state survives.
  vi.resetModules();
  const freshRecovery = await import('@/agent/confirmation-recovery');
  const freshRecover = await import('@/app/api/actions/[id]/recover/route');
  const freshList = await import('@/app/api/actions/route');
  const liveAfterRestart = freshRecovery.liveCount(id);

  // The wedge is DISCOVERABLE from the refreshed payload alone (no remembered action id).
  const listed = await listActions(sessionId, freshList.GET as RouteGet);
  const discovered = listed.actions.find((a) => a.toolName === 'transfer_money');
  if (discovered === undefined) {
    throw new Error('review: the refreshed list did not surface the wedged standalone action');
  }

  // (3) Recover through the FRESHLY imported handler — the fresh registry is EMPTY.
  const recovered = await recoverWith(freshRecover.POST as RoutePost, discovered.id, sessionId);
  const stored = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const auditRows = await p.auditLog.count({ where: { dedupeKey: `exec:${id}` } });

  console.log(
    'REVIEW_RESTART_STANDALONE',
    JSON.stringify({
      injectionCalls,
      wedgedStatus: wedged.status,
      wedgedResult: wedged.resultJson,
      wedgedLease: wedged.executionLeaseOwner,
      liveBeforeRestart,
      liveAfterRestart,
      refreshStatus: listed.row(id)?.status,
      refreshAttention: listed.row(id)?.attention,
      discoveredIdMatches: discovered.id === id,
      recoveredHttp: recovered.status,
      recoveredOk: recovered.data?.ok,
      recoveredStatus: recovered.data?.status,
      storedStatus: stored.status,
      storedResultOk: stored.resultJson ? JSON.parse(stored.resultJson).ok : null,
      receipts: await p.executionReceipt.count({ where: { userId, key: id } }),
      debits: await debitCount(200),
      balance: await checkingBalance(),
      auditRows,
    }),
  );

  // The "restart" really produced an EMPTY in-process registry (the old graph held a marker).
  expect(liveBeforeRestart).toBe(1);
  expect(liveAfterRestart).toBe(0);

  // Persisted evidence alone made the wedge visible + recoverable.
  expect(listed.status).toBe(200);
  expect(listed.ids).toContain(id);
  expect(listed.row(id)?.status).toBe('confirmed');
  expect(listed.row(id)?.attention).toBe('recoverable');
  expect(discovered.id).toBe(id);

  // The receipt-first recovery lands `executed` WITHOUT re-invoking the tool (side effect once).
  expect(recovered.status).toBe(200);
  expect(recovered.data?.ok).toBe(true);
  expect(recovered.data?.actionId).toBe(id);
  expect(recovered.data?.status).toBe('executed');
  expect(recovered.data?.message).toContain('已提交的执行凭证');
  expect(stored.status).toBe('executed');
  expect(stored.resultJson ? JSON.parse(stored.resultJson).ok : null).toBe(true);
  expect(await p.executionReceipt.count({ where: { userId, key: id } })).toBe(1); // still ONE receipt
  expect(await debitCount(200)).toBe(1); // exactly ONE debit — never re-executed
  expect(await checkingBalance()).toBe(CHECKING_BALANCE - 200);
  expect(auditRows).toBe(1); // exactly ONE execution audit for this action

  beforeRestart.releaseAction(id); // tidy the retained marker on the OLD graph
});

it('a plan-linked transfer wedge resumes and backfills its node from persisted evidence after a restart', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const submitted = await runSubmitPlan(
    userId,
    {
      goal: '重启后计划转账恢复',
      nodes: [
        {
          id: 'transfer',
          name: '转账',
          kind: 'tool',
          tool: 'transfer_money',
          args: { name: '张伟', amount: 200 },
          dependencies: [],
        },
      ],
    },
    { sessionId, runTool: runner(sessionId) },
  );
  const plan = submitted.data as { id: string; status: string };
  expect(plan.status).toBe('waiting_confirmation');

  const pending = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  const receiptKey = `nxe:${plan.id}:transfer`;

  const spy = wedgeResultTransaction();
  const first = await confirmWith(confirmPost, pending.id, sessionId);
  const injectionCalls = spy.mock.calls.length;
  spy.mockRestore();
  expect(injectionCalls).toBeGreaterThanOrEqual(1); // the injection FIRED (the target was hit)

  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  expect(first.status).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();
  expect(await p.executionReceipt.count({ where: { userId, key: receiptKey } })).toBe(1);
  expect(await debitCount(200)).toBe(1);
  await clearLeaseIfAny(pending.id);

  // SIMULATED SERVICE RESTART — only PERSISTED state survives.
  vi.resetModules();
  const freshRecovery = await import('@/agent/confirmation-recovery');
  const freshTask = await import('@/app/api/tasks/[id]/route');
  const liveAfterRestart = freshRecovery.liveCount(pending.id);

  // Resume the owning plan through the FRESHLY imported handler: the node re-run converges on the
  // committed receipt and backfills the node result WITHOUT re-invoking the tool.
  const resumed = await postTask(freshTask.POST as RoutePost, plan.id, sessionId, 'resume');
  const storedAction = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  const storedPlan = await p.agentTask.findUniqueOrThrow({
    where: { id: plan.id },
    include: { nodes: true },
  });
  const node = storedPlan.nodes.find((n) => n.nodeId === 'transfer');
  const auditRows = await p.auditLog.count({ where: { dedupeKey: `exec:${pending.id}` } });

  console.log(
    'REVIEW_RESTART_PLAN',
    JSON.stringify({
      injectionCalls,
      wedgedStatus: wedged.status,
      wedgedResult: wedged.resultJson,
      liveAfterRestart,
      resumeHttp: resumed.status,
      planStatus: resumed.data?.status,
      storedPlanStatus: storedPlan.status,
      nodeStatus: node?.status,
      actionStatus: storedAction.status,
      actionResultOk: storedAction.resultJson ? JSON.parse(storedAction.resultJson).ok : null,
      receipts: await p.executionReceipt.count({ where: { userId, key: receiptKey } }),
      debits: await debitCount(200),
      balance: await checkingBalance(),
      auditRows,
    }),
  );

  expect(liveAfterRestart).toBe(0); // the restart really produced an empty registry
  expect(resumed.status).toBe(200);
  expect(resumed.data?.status).toBe('success'); // the plan settled
  expect(storedPlan.status).toBe('success');
  expect(node?.status).toBe('success');
  expect(storedAction.status).toBe('executed');
  expect(storedAction.resultJson ? JSON.parse(storedAction.resultJson).ok : null).toBe(true);
  expect(await p.executionReceipt.count({ where: { userId, key: receiptKey } })).toBe(1); // ONE receipt
  expect(await debitCount(200)).toBe(1); // exactly ONE debit — never re-executed
  expect(await checkingBalance()).toBe(CHECKING_BALANCE - 200);
  expect(auditRows).toBe(1); // exactly ONE execution audit for the node's action
});

it('repeat recovery across a module reset is idempotent (no second debit, no second execution audit)', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkStandalone(sessionId, 'transfer_money', { name: '张伟', amount: 200 }, '给张伟转200元');

  const spy = wedgeResultTransaction();
  const first = await confirmWith(confirmPost, id, sessionId);
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1); // the injection FIRED (the target was hit)
  spy.mockRestore();

  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();
  expect(await debitCount(200)).toBe(1);
  await clearLeaseIfAny(id);

  // Recovery #1 — through a FIRST freshly imported handler/registry.
  vi.resetModules();
  const fresh1 = await import('@/agent/confirmation-recovery');
  const recover1 = await import('@/app/api/actions/[id]/recover/route');
  const live1 = fresh1.liveCount(id);
  const rec1 = await recoverWith(recover1.POST as RoutePost, id, sessionId);

  // Recovery #2 — a SECOND restart + recovery of the SAME action (a repeat click after a restart).
  vi.resetModules();
  const fresh2 = await import('@/agent/confirmation-recovery');
  const recover2 = await import('@/app/api/actions/[id]/recover/route');
  const live2 = fresh2.liveCount(id);
  const rec2 = await recoverWith(recover2.POST as RoutePost, id, sessionId);

  const stored = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const auditRows = await p.auditLog.count({ where: { dedupeKey: `exec:${id}` } });

  console.log(
    'REVIEW_RESTART_REPEAT_IDEMPOTENT',
    JSON.stringify({
      live1,
      live2,
      rec1Http: rec1.status,
      rec1Ok: rec1.data?.ok,
      rec1Status: rec1.data?.status,
      rec2Http: rec2.status,
      rec2Ok: rec2.data?.ok,
      rec2Status: rec2.data?.status,
      storedStatus: stored.status,
      receipts: await p.executionReceipt.count({ where: { userId, key: id } }),
      debits: await debitCount(200),
      balance: await checkingBalance(),
      auditRows,
    }),
  );

  expect(live1).toBe(0);
  expect(live2).toBe(0);

  // Recovery #1 lands the TRUE success (the debit had committed) exactly once.
  expect(rec1.status).toBe(200);
  expect(rec1.data?.ok).toBe(true);
  expect(rec1.data?.status).toBe('executed');

  // Recovery #2 must NOT downgrade the success, must NOT re-run the tool and must NOT re-audit.
  expect(rec2.status).toBe(200);
  expect(rec2.data?.ok).toBe(false); // honest "nothing left to recover"
  expect(rec2.data?.status).toBe('executed'); // reports the CURRENT persisted status
  expect(stored.status).toBe('executed'); // unchanged — never downgraded
  expect(await p.executionReceipt.count({ where: { userId, key: id } })).toBe(1); // ONE receipt
  expect(await debitCount(200)).toBe(1); // no second ledger movement
  expect(await checkingBalance()).toBe(CHECKING_BALANCE - 200); // no second debit
  expect(auditRows).toBe(1); // no second execution audit (`exec:<id>` dedupe key)
});

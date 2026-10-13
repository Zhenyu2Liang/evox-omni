/**
 * integration/committed-outcomes.test.ts — the "committed side effect, result NOT persisted" WEDGE.
 *
 * WHY this suite exists: a gated action's side effect (the SDK write) and its result+status+audit
 * landing are TWO different transactions. When the side effect COMMITS but the landing transaction
 * ROLLS BACK, the row is left `confirmed` with `resultJson === null` — a WEDGE. Finalizing it from the
 * (absent) `resultJson` alone would settle a SUCCESSFUL, irreversible side effect as `failed`. The
 * ONLY sound behaviour is EVIDENCE-BASED convergence on the TRUTH, never a re-run on a guess.
 *
 * This spec proves that wedge recovery lands the SAME truth for BOTH action shapes — a PLAN-LINKED
 * node and a STANDALONE action — and that the derived facts stay MUTUALLY CONSISTENT across every
 * store at once:
 *   • the money ledger (`Account.balance`, `Transaction` rows),
 *   • the committed-fact `ExecutionReceipt` (the durable proof the side effect ran),
 *   • the `PendingAction.status` (+ its persisted `resultJson`),
 *   • the plan `AgentTask.status` and its `AgentTaskNode.status`.
 * And it pins the honest DIVERGENCE for a non-idempotent tool: a wedge that cannot be safely replayed
 * settles the explicit, queryable `needs_reconciliation` state — never `failed`, never `executed`,
 * never a second side effect — and stays surfaced by `GET /api/actions`.
 *
 * Real app-entry layer: REAL Next.js route handlers, the REAL confirmation continuation, the REAL
 * planner executor, the REAL Banking SDK and the REAL isolated test SQLite (`prisma/test.db`) run
 * in-process; no model/LLM is on this path. The ONLY mock is REAL fault injection
 * (`vi.spyOn(pendingActionRepo, 'setPendingActionStatus').mockRejectedValueOnce(...)`) that makes the
 * result+status transaction genuinely roll back — every assertion re-reads persisted DB state and
 * asserts the injection actually FIRED before trusting the wedge.
 */
import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { executionReceiptId, ledgerKeyForAction, nodeExecutionKey } from '@/lib/ledger';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
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

/** POST through a real `/api/actions/[id]/<verb>` handler with the session cookie. */
async function actionCall(handler: RoutePost, id: string, sessionId: string, verb: string) {
  const response = await handler(
    new NextRequest(`http://localhost/api/actions/${id}/${verb}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${sessionId}` },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { http: response.status, body: await response.json() };
}
const confirm = (id: string, s: string) => actionCall(confirmPost, id, s, 'confirm');
const recover = (id: string, s: string) => actionCall(recoverPost, id, s, 'recover');

/** POST a task control command (`pause` | `resume` | `cancel` | `retry`); returns the plan snapshot. */
async function task(id: string, sessionId: string, command: string) {
  const response = await taskPost(
    new NextRequest(`http://localhost/api/tasks/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${sessionId}` },
      body: JSON.stringify({ action: command }),
    }),
    { params: Promise.resolve({ id }) },
  );
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

/** `GET /api/actions` — the page-refresh read model the UI uses to restore pending entries. */
async function listActions(sessionId: string) {
  const response = await actionsGet(
    new NextRequest('http://localhost/api/actions', { headers: { cookie: `banking_session=${sessionId}` } }),
  );
  expect(response.status).toBe(200);
  const actions = ((await response.json()).data ?? []) as Array<{ id: string; status: string }>;
  return { actions, ids: actions.map((a) => a.id), row: (id: string) => actions.find((a) => a.id === id) };
}

/**
 * The REAL fault injection: make the NEXT result+status transaction genuinely roll back, so the SDK
 * side effect has already committed while the row is left `confirmed` with `resultJson === null`.
 */
function wedgeResultTransaction() {
  return vi
    .spyOn(pendingActionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('review: result landing failed'));
}

/** A plan-node `runTool` that routes every node through the gateway-authorized execution path. */
const runner = (sessionId: string) =>
  (toolName: string, args: Record<string, unknown>, ctx: { taskId: string; nodeId: string }) =>
    executeGatedTool({
      sessionId,
      userId,
      toolName: toolName as never,
      args,
      userRequest: '核查已提交副作用的恢复真实性',
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });

const debitCount = (amount: string) =>
  getTestPrisma().transaction.count({
    where: { userId, amountMinor: -moneyToCents(amount), counterpartyId: 'contact_zhangwei' },
  });
const checkingBalance = async () =>
  centsToMoney((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor);

it('a plan-linked transfer wedge recovers to the committed truth on resume: success node, executed action, one receipt, one debit', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();

  // A single-node plan whose only node is a gated (YELLOW) ¥200 transfer → parked for confirmation.
  const submitted = await runSubmitPlan(
    userId,
    {
      goal: '计划节点已提交副作用恢复',
      nodes: [
        {
          id: 'transfer',
          name: '转账',
          kind: 'tool',
          tool: 'transfer_money',
          args: { name: '张伟', amount: '200.00' },
          dependencies: [],
        },
      ],
    },
    { sessionId: s, runTool: runner(s) },
  );
  const plan: { id: string; status: string } = submitted.data as never;
  expect(plan.status).toBe('waiting_confirmation');

  const nodeKey = nodeExecutionKey(plan.id, 'transfer');
  const pending = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  expect(pending.taskId).toBe(plan.id);
  expect(pending.nodeId).toBe('transfer');
  expect(ledgerKeyForAction({ id: pending.id, taskId: plan.id, nodeId: 'transfer' })).toBe(nodeKey);
  expect(await debitCount('200.00')).toBe(0);

  // CONFIRM with the result-landing fault: the ¥200 SDK side effect COMMITS, the transaction rolls back.
  const spy = wedgeResultTransaction();
  const first = await confirm(pending.id, s);
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1); // the injection HIT the target
  spy.mockRestore();

  // WEDGED, pre-recovery: side effect committed EXACTLY ONCE, row left `confirmed` with NO result.
  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  expect(first.http).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();
  const receiptKey = nodeExecutionKey(plan.id, 'transfer');
  expect(await p.executionReceipt.count({ where: { userId, key: receiptKey } })).toBe(1);
  expect(await p.executionReceipt.findUnique({ where: { id: executionReceiptId(userId, receiptKey) } })).not.toBeNull();
  expect(await debitCount('200.00')).toBe(1);
  expect(await checkingBalance()).toBe(subtractMoney(CHECKING_BALANCE, '200.00'));

  // RESUME the owning plan → the node is backfilled from the COMMITTED receipt, never re-run.
  const resumed = await task(plan.id, s, 'resume');
  expect(resumed.status).toBe('success');

  const storedPlan = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
  const storedNode = storedPlan.nodes.find((n) => n.nodeId === 'transfer')!;
  const storedAction = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  const storedResult = storedAction.resultJson ? JSON.parse(storedAction.resultJson) : null;

  console.log(
    'REVIEW_COMMITTED_PLAN_WEDGE',
    JSON.stringify({
      firstHttp: first.http,
      wedgedStatus: wedged.status,
      planStatus: storedPlan.status,
      nodeStatus: storedNode.status,
      actionStatus: storedAction.status,
      resultOk: storedResult?.ok,
      receipts: await p.executionReceipt.count({ where: { userId, key: receiptKey } }),
      debits: await debitCount('200.00'),
      balance: await checkingBalance(),
    }),
  );

  expect(storedPlan.status).toBe('success');
  expect(storedNode.status).toBe('success');
  expect(storedAction.status).toBe('executed');
  expect(storedResult?.ok).toBe(true); // the persisted result is the TRUE outcome
  // Tool never re-invoked → still exactly ONE receipt + ONE debit + a stable balance.
  expect(await p.executionReceipt.count({ where: { userId, key: receiptKey } })).toBe(1);
  expect(await debitCount('200.00')).toBe(1);
  expect(await checkingBalance()).toBe(subtractMoney(CHECKING_BALANCE, '200.00'));
});

it('a standalone transfer wedge recovers via the recover route from its committed receipt: executed, one receipt, one debit, surfaced no more', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();

  const gated = await executeGatedTool({
    sessionId: s,
    userId,
    toolName: 'transfer_money',
    args: { name: '张伟', amount: '250.00' },
    userRequest: '给张伟转250元',
  });
  const id = gated.pendingActionId!;
  expect(id).toBeTruthy();
  expect(await debitCount('250.00')).toBe(0);

  const spy = wedgeResultTransaction();
  const first = await confirm(id, s);
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1); // the injection HIT the target
  spy.mockRestore();

  // WEDGED, pre-recovery: side effect committed EXACTLY ONCE, row `confirmed` with NO result.
  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  expect(first.http).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();
  const receiptKey = ledgerKeyForAction({ id });
  expect(receiptKey).toBe(id);
  expect(await p.executionReceipt.count({ where: { userId, key: receiptKey } })).toBe(1);
  expect(await p.executionReceipt.findUnique({ where: { id: executionReceiptId(userId, receiptKey) } })).not.toBeNull();
  expect(await debitCount('250.00')).toBe(1);
  expect(await checkingBalance()).toBe(subtractMoney(CHECKING_BALANCE, '250.00'));

  // RECOVER through the refresh-reachable entry point — receipt-first, the tool is NEVER re-run.
  const recovered = await recover(id, s);
  const stored = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const storedResult = stored.resultJson ? JSON.parse(stored.resultJson) : null;
  const listed = await listActions(s);

  console.log(
    'REVIEW_COMMITTED_STANDALONE_RECOVER',
    JSON.stringify({
      firstHttp: first.http,
      recoverHttp: recovered.http,
      recoverOk: recovered.body.data?.ok,
      actionStatus: stored.status,
      resultOk: storedResult?.ok,
      receipts: await p.executionReceipt.count({ where: { userId, key: receiptKey } }),
      debits: await debitCount('250.00'),
      balance: await checkingBalance(),
      surfaced: listed.ids.includes(id),
    }),
  );

  expect(recovered.http).toBe(200);
  expect(recovered.body.data?.ok).toBe(true);
  expect(stored.status).toBe('executed');
  expect(storedResult?.ok).toBe(true);
  expect(await p.executionReceipt.count({ where: { userId, key: receiptKey } })).toBe(1);
  expect(await debitCount('250.00')).toBe(1); // exactly one debit
  expect(await checkingBalance()).toBe(subtractMoney(CHECKING_BALANCE, '250.00'));
  expect(listed.ids).not.toContain(id); // `executed` is terminal & NOT surfaced
});

it('a standalone virtual-card wedge recovers its atomic receipt with exactly one card', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const virtualWhere = { userId, type: 'VIRTUAL' as const };

  const gated = await executeGatedTool({
    sessionId: s,
    userId,
    toolName: 'apply_virtual_card',
    args: { label: '旅行备用' },
    userRequest: '申请一张虚拟卡',
  });
  const id = gated.pendingActionId!;
  expect(id).toBeTruthy();
  const virtualBefore = await p.card.count({ where: virtualWhere });
  expect(virtualBefore).toBe(0);
  const txBefore = await p.transaction.count({ where: { userId } });

  const spy = wedgeResultTransaction();
  const first = await confirm(id, s);
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1); // the injection HIT the target
  spy.mockRestore();

  // WEDGED, pre-recovery: the virtual card WAS issued EXACTLY ONCE, row `confirmed` with NO result.
  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  expect(first.http).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();
  expect(await p.card.count({ where: virtualWhere })).toBe(1);

  // The unified command receipt proves the original card was committed. Recovery never issues another.
  const recovered = await recover(id, s);
  const stored = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const virtualAfter = await p.card.count({ where: virtualWhere });
  const listed = await listActions(s);

  console.log(
    'REVIEW_COMMITTED_VIRTUAL_CARD_WEDGE',
    JSON.stringify({
      firstHttp: first.http,
      recoverHttp: recovered.http,
      recoverOk: recovered.body.data?.ok,
      recoverStatus: recovered.body.data?.status,
      actionStatus: stored.status,
      virtualBefore,
      virtualAfter,
      txBefore,
      txAfter: await p.transaction.count({ where: { userId } }),
      balance: await checkingBalance(),
      surfaced: listed.ids.includes(id),
      surfacedStatus: listed.row(id)?.status,
    }),
  );

  expect(recovered.http).toBe(200);
  expect(recovered.body.data?.ok).toBe(true);
  expect(recovered.body.data?.status).toBe('executed');
  expect(stored.status).toBe('executed');
  expect(virtualAfter).toBe(1); // never re-run → no second virtual card
  expect(await p.transaction.count({ where: { userId } })).toBe(txBefore); // no ledger movement
  expect(await checkingBalance()).toBe(CHECKING_BALANCE);
  expect(await p.executionReceipt.count({ where: { userId, key: id } })).toBe(1);
  expect((await p.auditLog.findUniqueOrThrow({ where: { dedupeKey: `exec:${id}` } })).status).toBe('success');
  expect(listed.ids).not.toContain(id);
});

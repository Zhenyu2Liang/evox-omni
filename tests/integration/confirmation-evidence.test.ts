import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getDemoSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { banking } from '@/banking-sdk';
import { auditStore } from '@/audit/audit-logger';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { centsToMoney } from '@/lib/money';
import * as executionFence from '@/agent/execution-fence';
import { securityGateway } from '@/security/security-gateway';
import { openManualReview, resolveManualReview } from '@/agent/manual-review';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());
type Route = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function action(handler: Route, id: string, _sessionId: string, verb: string) {
  const r = await handler(new NextRequest(`http://localhost/api/actions/${id}/${verb}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }), { params: Promise.resolve({ id }) });
  return { http: r.status, body: await r.json() };
}
const confirm = (id: string, s: string) => action(confirmPost, id, s, 'confirm');
const recover = (id: string, s: string) => action(recoverPost, id, s, 'recover');
async function cancelTask(id: string, _sessionId: string) {
  const r = await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }),
  }), { params: Promise.resolve({ id }) });
  expect(r.status).toBe(200); return (await r.json()).data;
}
const runner = (s: string) => (toolName: string, args: Record<string, unknown>, ctx: { taskId: string; nodeId: string }) =>
  executeGatedTool({ sessionId: s, userId, toolName: toolName as any, args, userRequest: '审查未闭合事务边界', taskId: ctx.taskId, nodeId: ctx.nodeId });
function deferred() { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; }
async function bounded(p: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([p, new Promise((_, reject) => timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000))]); }
  finally { clearTimeout(timer); }
}
const debits = () => getTestPrisma().transaction.count({ where: { userId, amountMinor: -20000n, counterpartyId: 'contact_zhangwei' } });

it('a committed transfer followed by a status-return exception recovers from the original receipt', async () => {
  const p = getTestPrisma(); const s = (await getDemoSession(userId)).sessionId;
  const parked = await executeGatedTool({ sessionId: s, userId, toolName: 'transfer_money', args: { name: '张伟', amount: '200' }, userRequest: '给张伟转200元' });
  const id = parked.pendingActionId!; expect(id).toBeTruthy();
  const original = securityGateway.recordActionResult.bind(securityGateway); let committed = 0;
  const spy = vi.spyOn(securityGateway, 'recordActionResult').mockImplementation(async (...input) => {
    if (input[0] === id && input[1] === 'executed') { committed++; throw new Error('Status response lost after transaction commit'); }
    return original(...input);
  });
  const first = await confirm(id, s); expect(committed).toBe(1); spy.mockRestore();
  expect(await debits()).toBe(1); expect(await p.executionReceipt.count({ where: { userId, key: id } })).toBe(1);
  const recovery = await recover(id, s);
  const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const audit = await p.auditLog.findUnique({ where: { dedupeKey: `exec:${id}` } });
  console.log('REVIEW_COMMIT_THEN_EXCEPTION', JSON.stringify({ firstHttp: first.http, firstOk: first.body.data?.ok, recoveryOk: recovery.body.data?.ok, status: row.status, receiptCount: 1, balance: centsToMoney((await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor), debits: await debits(), executionAuditStatus: audit?.status }));
  expect(row.status).toBe('executed'); expect(audit?.status).toBe('success');
});

it('a posted transfer with a missing receipt requires manual reconciliation without another debit', async () => {
  const p = getTestPrisma(); const s = (await getDemoSession(userId)).sessionId;
  const submitted = await runSubmitPlan(userId, { goal: '历史已入账计划恢复', nodes: [{ id: 'transfer', name: '转账', kind: 'tool', tool: 'transfer_money', args: { name: '张伟', amount: '200' }, dependencies: [] }] }, { sessionId: s, runTool: runner(s) });
  const plan: any = submitted.data; expect(plan.status).toBe('waiting_confirmation');
  const pending = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  const spy = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result landing unavailable'));
  const first = await confirm(pending.id, s); expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
  expect(first.http).toBe(500); expect(await debits()).toBe(1);
  const wedge = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  expect(wedge.status).toBe('confirmed'); expect(wedge.resultJson).toBeNull();
  // A damaged receipt leaves the posted ledger intact but removes the complete result evidence.
  expect((await p.executionReceipt.deleteMany({ where: { userId, key: `nxe:${plan.id}:transfer` } })).count).toBe(1);
  const recovered = await recover(pending.id, s);
  const stored = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  const storedPlan = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
  expect(recovered.body.data).toMatchObject({ ok: false, status: 'needs_reconciliation' });
  expect(stored.status).toBe('needs_reconciliation');
  expect(storedPlan.status).toBe('failed');
  expect(storedPlan.nodes[0].status).toBe('failed');
  expect(await p.executionReceipt.count()).toBe(0);
  expect(await debits()).toBe(1);
  expect((await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2338000n);

  const identity = { userId, sessionId: s };
  const review = await openManualReview(identity, { taskId: plan.id }, 'The committed transfer has incomplete evidence.');
  expect(review.mayRetry).toBe(false);
  await expect(resolveManualReview(identity, review.id, 'retry', 'Retry the transfer.'))
    .rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await resolveManualReview(identity, review.id, 'stop', 'Preserve the ledger and stop automatic work.'))
    .toMatchObject({ status: 'closed', resolution: 'stop' });
  await confirm(pending.id, s);
  expect(await debits()).toBe(1);
  expect(await p.executionReceipt.count()).toBe(0);
  expect((await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2338000n);
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('needs_reconciliation');
  expect((await p.agentTask.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe('cancelled');
});

it('cancellation completed before a blocked card-limit SDK write must prevent that write', async () => {
  const p = getTestPrisma(); const s = (await getDemoSession(userId)).sessionId;
  const submitted = await runSubmitPlan(userId, { goal: '取消确认中的卡片调整', nodes: [{ id: 'limit', name: '调整限额', kind: 'tool', tool: 'set_card_limit', args: { cardId: 'card_credit', category: '娱乐', amount: '1500' }, dependencies: [] }] }, { sessionId: s, runTool: runner(s) });
  const plan: any = submitted.data; expect(plan.status).toBe('waiting_confirmation');
  const pending = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  const limit = async () => centsToMoney((await p.cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } })).amountMinor);
  expect(await limit()).toBe('3000.00');
  const reached = deferred(), release = deferred(); const capture = executionFence.buildConfirmFence; let entered = 0;
  const spy = vi.spyOn(executionFence, 'buildConfirmFence').mockImplementation(async (...input) => {
    const fence = await capture(...input);
    entered++; reached.release(); await release.promise; return fence;
  });
  const running = confirm(pending.id, s); let cancelled: any; let first: any;
  try {
    await bounded(reached.promise); expect(entered).toBe(1);
    expect((await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('confirmed');
    cancelled = await cancelTask(plan.id, s); expect(cancelled.status).toBe('cancelled'); expect(await limit()).toBe('3000.00');
  } finally { release.release(); first = await running; spy.mockRestore(); }
  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id } });
  const op = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  console.log('REVIEW_CARD_CANCEL_FENCE_MISSING', JSON.stringify({ cancelledStatus: cancelled.status, limitWhenCancelled: 3000, limitAfterRelease: await limit(), actionStatus: op.status, storedPlan: stored.status, confirmationOk: first.body.data?.ok }));
  expect(await limit()).toBe('3000.00'); expect(stored.status).toBe('cancelled');
});

it('failure of required execution audit must roll back the debit and receipt as claimed in the report', async () => {
  const p = getTestPrisma(); const s = (await getDemoSession(userId)).sessionId;
  const parked = await executeGatedTool({ sessionId: s, userId, toolName: 'transfer_money', args: { name: '张伟', amount: '200' }, userRequest: '审查资金与审计同事务' });
  const id = parked.pendingActionId!; expect(id).toBeTruthy();
  const original = auditStore.insertAuditLog; let injected = 0;
  const spy = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey === `exec:${id}`) { injected++; throw new Error('review: required audit storage unavailable'); }
    return original(entry, opts);
  });
  const first = await confirm(id, s); expect(injected).toBe(1); spy.mockRestore();
  const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const balance = centsToMoney((await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor);
  const receiptCount = await p.executionReceipt.count({ where: { userId, key: id } });
  const auditCount = await p.auditLog.count({ where: { dedupeKey: `exec:${id}` } });
  console.log('REVIEW_AUDIT_BUSINESS_NOT_ATOMIC', JSON.stringify({ http: first.http, actionStatus: row.status, balance, debits: await debits(), receipts: receiptCount, executionAudits: auditCount }));
  expect(balance).toBe('23580.00'); expect(await debits()).toBe(0); expect(receiptCount).toBe(0); expect(auditCount).toBe(0);
});

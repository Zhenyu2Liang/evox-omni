import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { banking } from '@/banking-sdk';
import { auditStore } from '@/audit/audit-logger';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());
type Route = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function action(handler: Route, id: string, s: string, verb: string) {
  const r = await handler(new NextRequest(`http://localhost/api/actions/${id}/${verb}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `banking_session=${s}` }, body: '{}',
  }), { params: Promise.resolve({ id }) });
  return { http: r.status, body: await r.json() };
}
const confirm = (id: string, s: string) => action(confirmPost, id, s, 'confirm');
const recover = (id: string, s: string) => action(recoverPost, id, s, 'recover');
async function cancelTask(id: string, s: string) {
  const r = await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `banking_session=${s}` }, body: JSON.stringify({ action: 'cancel' }),
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
const debits = () => getTestPrisma().transaction.count({ where: { userId, amount: -200, counterpartyId: 'contact_zhangwei' } });

it('a committed transfer followed by an SDK return-path exception must converge executed through the normal confirmation path', async () => {
  const p = getTestPrisma(); const s = (await getOrCreateSession(userId)).sessionId;
  const parked = await executeGatedTool({ sessionId: s, userId, toolName: 'transfer_money', args: { name: '张伟', amount: 200 }, userRequest: '给张伟转200元' });
  const id = parked.pendingActionId!; expect(id).toBeTruthy();
  const original = banking.transfer.createTransfer; let committed = 0;
  const spy = vi.spyOn(banking.transfer, 'createTransfer').mockImplementation(async input => {
    const result = await original(input); committed++;
    expect(result.success).toBe(true);
    throw new Error('review: SDK response path lost after transaction commit');
  });
  const first = await confirm(id, s); expect(committed).toBe(1); spy.mockRestore();
  expect(await debits()).toBe(1); expect(await p.executionReceipt.count({ where: { userId, key: id } })).toBe(1);
  const recovery = await recover(id, s);
  const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const audit = await p.auditLog.findUnique({ where: { dedupeKey: `exec:${id}` } });
  console.log('REVIEW_COMMIT_THEN_EXCEPTION', JSON.stringify({ firstHttp: first.http, firstOk: first.body.data?.ok, recoveryOk: recovery.body.data?.ok, status: row.status, receiptCount: 1, balance: (await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance, debits: await debits(), executionAuditStatus: audit?.status }));
  expect(row.status).toBe('executed'); expect(audit?.status).toBe('success');
});

it('a pre-receipt plan-linked posted transfer must retain its proven ledger success on recovery', async () => {
  const p = getTestPrisma(); const s = (await getOrCreateSession(userId)).sessionId;
  const submitted = await runSubmitPlan(userId, { goal: '历史已入账计划恢复', nodes: [{ id: 'transfer', name: '转账', kind: 'tool', tool: 'transfer_money', args: { name: '张伟', amount: 200 }, dependencies: [] }] }, { sessionId: s, runTool: runner(s) });
  const plan: any = submitted.data; expect(plan.status).toBe('waiting_confirmation');
  const pending = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  const spy = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result landing unavailable'));
  const first = await confirm(pending.id, s); expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
  expect(first.http).toBe(500); expect(await debits()).toBe(1);
  const wedge = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  expect(wedge.status).toBe('confirmed'); expect(wedge.resultJson).toBeNull();
  // Model a genuine pre-upgrade record: the canonical deterministic ledger exists, no receipt was available.
  expect((await p.executionReceipt.deleteMany({ where: { userId, key: `nxe:${plan.id}:transfer` } })).count).toBe(1);
  const recovered = await recover(pending.id, s);
  const stored = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  const storedPlan = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
  console.log('REVIEW_LEGACY_PLAN_LEDGER_IGNORED', JSON.stringify({ recoveryOk: recovered.body.data?.ok, actionStatus: stored.status, planStatus: storedPlan.status, nodeStatus: storedPlan.nodes[0].status, receipts: await p.executionReceipt.count(), balance: (await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance, debits: await debits() }));
  expect(stored.status).toBe('executed'); expect(storedPlan.nodes[0].status).toBe('success');
});

it('cancellation completed before a blocked card-limit SDK write must prevent that write', async () => {
  const p = getTestPrisma(); const s = (await getOrCreateSession(userId)).sessionId;
  const submitted = await runSubmitPlan(userId, { goal: '取消确认中的卡片调整', nodes: [{ id: 'limit', name: '调整限额', kind: 'tool', tool: 'set_card_limit', args: { cardId: 'card_credit', category: '娱乐', amount: 1500 }, dependencies: [] }] }, { sessionId: s, runTool: runner(s) });
  const plan: any = submitted.data; expect(plan.status).toBe('waiting_confirmation');
  const pending = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  const limit = async () => (await p.cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } })).amount;
  expect(await limit()).toBe(3000);
  const reached = deferred(), release = deferred(); const original = banking.card.setCardLimit; let entered = 0;
  const spy = vi.spyOn(banking.card, 'setCardLimit').mockImplementation(async input => {
    entered++; reached.release(); await release.promise; return original(input);
  });
  const running = confirm(pending.id, s); let cancelled: any; let first: any;
  try {
    await bounded(reached.promise); expect(entered).toBe(1);
    expect((await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('confirmed');
    cancelled = await cancelTask(plan.id, s); expect(cancelled.status).toBe('cancelled'); expect(await limit()).toBe(3000);
  } finally { release.release(); first = await running; spy.mockRestore(); }
  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id } });
  const op = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  console.log('REVIEW_CARD_CANCEL_FENCE_MISSING', JSON.stringify({ cancelledStatus: cancelled.status, limitWhenCancelled: 3000, limitAfterRelease: await limit(), actionStatus: op.status, storedPlan: stored.status, confirmationOk: first.body.data?.ok }));
  expect(await limit()).toBe(3000); expect(stored.status).toBe('cancelled');
});

it('failure of required execution audit must roll back the debit and receipt as claimed in the report', async () => {
  const p = getTestPrisma(); const s = (await getOrCreateSession(userId)).sessionId;
  const parked = await executeGatedTool({ sessionId: s, userId, toolName: 'transfer_money', args: { name: '张伟', amount: 200 }, userRequest: '审查资金与审计同事务' });
  const id = parked.pendingActionId!; expect(id).toBeTruthy();
  const original = auditStore.insertAuditLog; let injected = 0;
  const spy = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey === `exec:${id}`) { injected++; throw new Error('review: required audit storage unavailable'); }
    return original(entry, opts);
  });
  const first = await confirm(id, s); expect(injected).toBe(1); spy.mockRestore();
  const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const balance = (await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance;
  const receiptCount = await p.executionReceipt.count({ where: { userId, key: id } });
  const auditCount = await p.auditLog.count({ where: { dedupeKey: `exec:${id}` } });
  console.log('REVIEW_AUDIT_BUSINESS_NOT_ATOMIC', JSON.stringify({ http: first.http, actionStatus: row.status, balance, debits: await debits(), receipts: receiptCount, executionAudits: auditCount }));
  expect(balance).toBe(23580); expect(await debits()).toBe(0); expect(receiptCount).toBe(0); expect(auditCount).toBe(0);
});

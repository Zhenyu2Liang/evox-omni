import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { banking } from '@/banking-sdk';
import { auditStore } from '@/audit/audit-logger';
import * as contactRepo from '@/lib/db/repositories/contact';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase()); afterEach(() => vi.restoreAllMocks()); afterAll(() => disconnectTestPrisma());
function deferred() { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; }
async function bounded(p: Promise<unknown>) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([p, new Promise((_, reject) => timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000))]); } finally { clearTimeout(timer); } }
type Route = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function action(handler: Route, id: string, s: string, verb: string) { const response = await handler(new NextRequest(`http://localhost/api/actions/${id}/${verb}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` }, body: '{}' }), { params: Promise.resolve({ id }) }); return { http: response.status, body: await response.json() }; }
const confirm = (id: string, s: string) => action(confirmPost, id, s, 'confirm');
const recover = (id: string, s: string) => action(recoverPost, id, s, 'recover');
async function task(id: string, s: string, command: string) { const response = await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` }, body: JSON.stringify({ action: command }) }), { params: Promise.resolve({ id }) }); expect(response.status).toBe(200); return (await response.json()).data; }
const runner = (s: string) => (toolName: string, args: Record<string, unknown>, ctx: { taskId: string; nodeId: string }) => executeGatedTool({ sessionId: s, userId, toolName: toolName as any, args, userRequest: '审查统一执行机制', taskId: ctx.taskId, nodeId: ctx.nodeId });

it('a plan-linked posted transfer must recover from its receipt instead of being finalized failed', async () => {
  const s = (await getOrCreateSession(userId)).sessionId; const p = getTestPrisma();
  const submitted = await runSubmitPlan(userId, { goal: '计划转账回执恢复', nodes: [{ id: 'transfer', name: '转账', kind: 'tool', tool: 'transfer_money', args: { name: '张伟', amount: 200 }, dependencies: [] }] }, { sessionId: s, runTool: runner(s) });
  const plan: any = submitted.data; expect(plan.status).toBe('waiting_confirmation');
  const pending = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  const spy = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('review: plan result landing failed'));
  const first = await confirm(pending.id, s); expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
  expect(first.http).toBe(500); expect(wedged.status).toBe('confirmed'); expect(wedged.resultJson).toBeNull();
  expect(await p.executionReceipt.count({ where: { userId, key: `nxe:${plan.id}:transfer` } })).toBe(1);
  const recovered = await recover(pending.id, s);
  const stored = await p.pendingAction.findUniqueOrThrow({ where: { id: pending.id } }); const storedPlan = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
  console.log('REVIEW_PLAN_RECEIPT_IGNORED', JSON.stringify({ http: recovered.http, responseOk: recovered.body.data?.ok, actionStatus: stored.status, planStatus: storedPlan.status, nodeStatus: storedPlan.nodes[0].status, balance: (await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance, debits: await p.transaction.count({ where: { userId, amount: -200, counterpartyId: 'contact_zhangwei' } }), executionAudits: await p.auditLog.count({ where: { dedupeKey: `exec:${pending.id}` } }) }));
  expect(stored.status).toBe('executed'); expect(storedPlan.nodes[0].status).toBe('success');
});

it('a transient audit insert failure must not permanently strand a settled transfer without audit', async () => {
  const s = (await getOrCreateSession(userId)).sessionId; const p = getTestPrisma();
  const gated = await executeGatedTool({ sessionId: s, userId, toolName: 'transfer_money', args: { name: '张伟', amount: 200 }, userRequest: '给张伟转200元' }); const id = gated.pendingActionId!;
  const original = auditStore.insertAuditLog; let injected = 0;
  const spy = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => { if (opts?.dedupeKey === `exec:${id}` && injected === 0) { injected++; throw new Error('review: transient audit insert failure'); } return original(entry, opts); });
  const first = await confirm(id, s); expect(injected).toBe(1); spy.mockRestore();
  const recovered = await recover(id, s); const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const audits = await p.auditLog.count({ where: { dedupeKey: `exec:${id}` } });
  console.log('REVIEW_AUDIT_FAILURE_SWALLOWED', JSON.stringify({ firstHttp: first.http, firstOk: first.body.data?.ok, recoveryOk: recovered.body.data?.ok, actionStatus: row.status, receiptCount: await p.executionReceipt.count({ where: { userId, key: id } }), executionAudits: audits }));
  expect(audits).toBe(1);
});

it('overlapping different requests using the same execution key must conflict and never return a wrong recipient', async () => {
  const p = getTestPrisma(); const reached = deferred(), release = deferred(); const key = 'review:overlapping:different-request';
  const original = contactRepo.searchContacts; let held = 0;
  const spy = vi.spyOn(contactRepo, 'searchContacts').mockImplementation(async (uid, keyword) => { const rows = await original(uid, keyword); if (keyword === '王芳') { held++; reached.release(); await release.promise; } return rows; });
  const slow = banking.transfer.createTransfer({ userId, idempotencyKey: key, name: '王芳', amount: 300 }).then(result => ({ ok: true, result, code: undefined }), error => ({ ok: false, result: undefined, code: error.code }));
  let winner: any; let loser: any;
  try { await bounded(reached.promise); expect(held).toBe(1); winner = await banking.transfer.createTransfer({ userId, idempotencyKey: key, name: '张伟', amount: 200 }); }
  finally { release.release(); loser = await slow; spy.mockRestore(); }
  const ledger = await p.transaction.findUniqueOrThrow({ where: { id: winner.transactionId } });
  console.log('REVIEW_CONCURRENT_DIGEST_BYPASS', JSON.stringify({ winnerRecipient: winner.recipient.name, loserOk: loser.ok, loserCode: loser.code, loserAmount: loser.result?.amount, loserRecipient: loser.result?.recipient.name, ledgerRecipient: ledger.counterpartyId, ledgerAmount: ledger.amount, receipts: await p.executionReceipt.count({ where: { userId, key } }) }));
  expect(loser.ok).toBe(false); expect(loser.code).toBe('CONFLICT');
});

it('a taken-over then cancelled plan must fence a blocked SDK write before any side effect commits', async () => {
  const s = (await getOrCreateSession(userId)).sessionId; const p = getTestPrisma(); const reached = deferred(), release = deferred();
  const original = banking.budget.reserveBudget; let calls = 0; let planId = ''; let oldResult: any; let takeover: any; let takeoverRun: Promise<any> | undefined; let cancelled: any;
  const spy = vi.spyOn(banking.budget, 'reserveBudget').mockImplementation(async input => { calls++; if (calls === 1) { reached.release(); await release.promise; } return original(input); });
  const oldRun = runSubmitPlan(userId, { goal: '实际 SDK 写入围栏', nodes: [{ id: 'budget', name: '预算', kind: 'tool', tool: 'reserve_budget', args: { name: '实际写入围栏预算', amount: 10 }, dependencies: [] }] }, { sessionId: s, runTool: (tool, args, ctx) => { planId = ctx.taskId; return runner(s)(tool, args, ctx); } });
  try {
    await bounded(reached.promise); expect(await p.budget.count({ where: { name: '实际写入围栏预算' } })).toBe(0);
    const oldToken = (await p.agentTask.findUniqueOrThrow({ where: { id: planId } })).executionToken;
    await p.agentTask.update({ where: { id: planId }, data: { executionClaimedAt: new Date(Date.now() - 660000) } });
    takeoverRun = task(planId, s, 'resume');
    // The second run really rotates the durable token, then shares the first in-flight tool promise.
    // Do not wait on that promise before releasing the barrier: it is deliberately still running.
    await bounded((async () => { for (;;) { const current = await p.agentTask.findUniqueOrThrow({ where: { id: planId } }); if (current.executionToken !== null && current.executionToken !== oldToken) return; await new Promise(resolve => setTimeout(resolve, 15)); } })());
    cancelled = await task(planId, s, 'cancel'); expect(cancelled.status).toBe('cancelled');
    expect(await p.budget.count({ where: { name: '实际写入围栏预算' } })).toBe(0);
  }
  finally { release.release(); oldResult = await oldRun; if (takeoverRun) takeover = await takeoverRun; spy.mockRestore(); }
  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId } }); const budgets = await p.budget.count({ where: { name: '实际写入围栏预算' } });
  console.log('REVIEW_SDK_FENCE_MISSING', JSON.stringify({ sdkCalls: calls, confirmedCancelStatus: cancelled.status, budgetsWhenCancelled: 0, budgetsAfterOldRelease: budgets, winnerStatus: takeover.status, storedStatus: stored.status, oldStatus: oldResult.data?.status }));
  expect(budgets).toBe(0);
});

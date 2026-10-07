import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());
function deferred() { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; }
async function bounded(p: Promise<unknown>) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([p, new Promise((_, reject) => timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000))]); } finally { clearTimeout(timer); } }
async function confirm(id: string, s: string) {
  const response = await confirmPost(new NextRequest(`http://localhost/api/actions/${id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` }, body: '{}' }), { params: Promise.resolve({ id }) });
  return { http: response.status, body: await response.json() };
}
async function list(s: string) { const response = await actionsGet(new NextRequest('http://localhost/api/actions', { headers: { cookie: `banking_session=${s}` } })); expect(response.status).toBe(200); return (await response.json()).data as Array<{ id: string; status: string }>; }
async function transferWedge(s: string) {
  const gate = await executeGatedTool({ sessionId: s, userId, toolName: 'transfer_money', args: { name: '张伟', amount: 200 }, userRequest: '给张伟转200元' });
  const id = gate.pendingActionId!; expect(id).toBeTruthy();
  const spy = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result write failed after debit'));
  const first = await confirm(id, s); expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
  const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id } });
  expect(first.http).toBe(500); expect(row.status).toBe('confirmed'); expect(row.resultJson).toBeNull();
  expect(await getTestPrisma().transaction.count({ where: { userId, amount: -200, counterpartyId: 'contact_zhangwei' } })).toBe(1);
  return id;
}

it('a claimed node must not start its tool or publish a plan after takeover while its running notification is blocked', async () => {
  const s = (await getOrCreateSession(userId)).sessionId; const p = getTestPrisma();
  const reached = deferred(), release = deferred(); let planId = ''; let oldToolCalls = 0; let afterTakeover = false;
  const latePlans: string[] = []; let oldResult: any; let takeover: any;
  const oldRun = runSubmitPlan(userId, { goal: '认领后通知阻塞接管', nodes: [{ id: 'budget', name: '预算', kind: 'tool', tool: 'reserve_budget', args: { name: '认领后通知阻塞接管预算', amount: 10 }, dependencies: [] }] }, {
    sessionId: s,
    onNodeUpdate: async node => { if (node.id === 'budget' && node.status === 'running') { planId = (await p.agentTask.findFirstOrThrow({ where: { sessionId: s } })).id; reached.release(); await release.promise; } },
    onPlanUpdate: plan => { if (afterTakeover) latePlans.push(plan.status); },
    runTool: async (tool, args, ctx) => { oldToolCalls++; return executeGatedTool({ sessionId: s, userId, toolName: tool as any, args, userRequest: '核查接管前工具未启动', taskId: ctx.taskId, nodeId: ctx.nodeId }); },
  });
  try {
    await bounded(reached.promise); expect(oldToolCalls).toBe(0);
    await p.agentTask.update({ where: { id: planId }, data: { executionClaimedAt: new Date(Date.now() - 660000) } });
    const response = await taskPost(new NextRequest(`http://localhost/api/tasks/${planId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` }, body: JSON.stringify({ action: 'resume' }) }), { params: Promise.resolve({ id: planId }) });
    expect(response.status).toBe(200); takeover = (await response.json()).data; expect(takeover.status).toBe('success'); afterTakeover = true;
  } finally { release.release(); oldResult = await oldRun; }
  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId } });
  console.log('REVIEW_POSTCLAIM_TAKEOVER', JSON.stringify({ oldToolCalls, latePlans, oldStatus: oldResult.data?.status, winnerStatus: takeover.status, storedStatus: stored.status, budgets: await p.budget.count({ where: { name: '认领后通知阻塞接管预算' } }) }));
  expect(oldToolCalls).toBe(0); expect(latePlans).toHaveLength(0);
});

it('refresh alone must surface a standalone wedge without requiring a hidden action id to be confirmed again', async () => {
  const s = (await getOrCreateSession(userId)).sessionId; const id = await transferWedge(s);
  const visible = await list(s); const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id } });
  console.log('REVIEW_REFRESH_WITHOUT_REPEAT', JSON.stringify({ status: row.status, visible: visible.some(a => a.id === id), visibleCount: visible.length }));
  expect(row.status !== 'confirmed' || visible.some(a => a.id === id)).toBe(true);
});

it('successful standalone transfer recovery must leave a durable execution audit', async () => {
  const s = (await getOrCreateSession(userId)).sessionId; const id = await transferWedge(s); const recovered = await confirm(id, s);
  const p = getTestPrisma(); const audits = await p.auditLog.findMany({ where: { sessionId: s, toolName: 'transfer_money' } });
  console.log('REVIEW_RECOVERY_AUDIT', JSON.stringify({ recoveredOk: recovered.body.data?.ok, status: (await p.pendingAction.findUniqueOrThrow({ where: { id } })).status, audits: audits.map(a => ({ status: a.status, toolResult: a.toolResult })) }));
  expect(recovered.body.data?.ok).toBe(true);
  expect(audits.some(a => a.status === 'success' && a.toolResult !== null && JSON.parse(a.toolResult).ok === true)).toBe(true);
});

it('an already ledgered transfer must not become failed when recipient lookup changes before recovery', async () => {
  const s = (await getOrCreateSession(userId)).sessionId; const id = await transferWedge(s); const p = getTestPrisma();
  await p.contact.update({ where: { id: 'contact_zhangwei' }, data: { name: '张伟（已更名）' } });
  const repeated = await confirm(id, s); const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const balance = (await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance;
  const debits = await p.transaction.count({ where: { userId, amount: -200, counterpartyId: 'contact_zhangwei' } });
  console.log('REVIEW_REPLAY_LOOKUP_CHANGED', JSON.stringify({ recoveredOk: repeated.body.data?.ok, status: row.status, message: repeated.body.data?.message, balance, debits }));
  expect(debits).toBe(1); expect(balance).toBe(23380); expect(row.status).toBe('executed');
});

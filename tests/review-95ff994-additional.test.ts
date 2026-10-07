import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { auditStore } from '@/audit/audit-logger';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { getState } from '@/security/circuit-breaker';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());
type Route = typeof confirmPost;
async function call(handler: Route, id: string, sessionId: string, body: object = {}) {
  const response = await handler(new NextRequest(`http://localhost/api/actions/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
  return { http: response.status, body: await response.json() };
}
const balance = async () => (await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance;

it('a locked session must not initiate the first debit through recovery after a required-audit rollback', async () => {
  const p = getTestPrisma();
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const parked = await executeGatedTool({ userId, sessionId, toolName: 'transfer_money', args: { name: '张伟', amount: 200 }, userRequest: '审计回滚后恢复' });
  const id = parked.pendingActionId!; expect(id).toBeTruthy();
  const insert = auditStore.insertAuditLog;
  let injected = 0;
  const fault = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey === `exec:${id}`) { injected++; throw new Error('review: required audit unavailable'); }
    return insert(entry, opts);
  });
  const initial = await call(confirmPost, id, sessionId); fault.mockRestore();
  expect(initial.http).toBe(500); expect(injected).toBe(1); expect(await balance()).toBe(23580);
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('confirmed');
  const red = await executeGatedTool({ userId, sessionId, toolName: 'transfer_money', args: { name: '张伟', amount: 2000 }, userRequest: '触发验证失败熔断' });
  expect(red.pendingActionId).toBeTruthy();
  for (let i = 0; i < 3; i++) await call(verifyPost, red.pendingActionId!, sessionId, { code: '000000' });
  expect(getState(sessionId).locked).toBe(true);
  const recovered = await call(recoverPost, id, sessionId);
  console.log('REVIEW_RECOVERY_CIRCUIT_BYPASS', JSON.stringify({ locked: getState(sessionId).locked, http: recovered.http, ok: recovered.body.data?.ok, status: recovered.body.data?.status, balance: await balance() }));
  expect(await balance()).toBe(23580);
});

it('a caller with a valid own session must not adjust a card belonging to another user', async () => {
  const p = getTestPrisma();
  const foreignUser = await p.user.create({ data: { id: 'review_other_user', name: '另一个客户', phone: '13900009999' } });
  const sessionId = (await getOrCreateSession(foreignUser.id)).sessionId;
  const card = await p.card.findUniqueOrThrow({ where: { id: 'card_credit' } });
  expect(card.userId).toBe(userId);
  const parked = await executeGatedTool({ userId: foreignUser.id, sessionId, toolName: 'set_card_limit', args: { cardId: card.id, category: '娱乐', amount: 1500 }, userRequest: '修改他人卡片限额' });
  expect(parked.pendingActionId).toBeTruthy();
  const response = await call(confirmPost, parked.pendingActionId!, sessionId);
  const stored = await p.cardLimit.findFirstOrThrow({ where: { cardId: card.id, category: '娱乐' } });
  console.log('REVIEW_CARD_RESOURCE_OWNERSHIP', JSON.stringify({ caller: foreignUser.id, owner: card.userId, http: response.http, ok: response.body.data?.ok, amount: stored.amount }));
  expect(stored.amount).toBe(3000);
});

it('contradictory plan-linked receipt evidence must land manual reconciliation even when a success audit already exists', async () => {
  const p = getTestPrisma();
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const submitted = await runSubmitPlan(userId, { goal: '计划凭证冲突人工核对', nodes: [{ id: 'transfer', name: '转账', kind: 'tool', tool: 'transfer_money', args: { name: '张伟', amount: 200 }, dependencies: [] }] }, {
    sessionId, runTool: (toolName, args, ctx) => executeGatedTool({ userId, sessionId, toolName: toolName as any, args, userRequest: '计划凭证冲突人工核对', taskId: ctx.taskId, nodeId: ctx.nodeId }),
  });
  const plan = submitted.data as { id: string; status: string };
  expect(plan.status).toBe('waiting_confirmation');
  const action = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  const fault = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result landing unavailable'));
  const first = await call(confirmPost, action.id, sessionId);
  expect(first.http).toBe(500); expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore();
  expect(await p.auditLog.count({ where: { dedupeKey: `exec:${action.id}`, status: 'success' } })).toBe(1);
  const receipt = await p.executionReceipt.findFirstOrThrow({ where: { userId, key: `nxe:${plan.id}:transfer` } });
  await p.executionReceipt.update({ where: { id: receipt.id }, data: { resultJson: JSON.stringify({ ...JSON.parse(receipt.resultJson), amount: 999 }) } });
  const originalInsert = auditStore.insertAuditLog;
  const auditErrors: string[] = [];
  const observer = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    try { return await originalInsert(entry, opts); }
    catch (error) {
      if (opts?.dedupeKey === `exec:${action.id}`) auditErrors.push(String((error as { code?: string }).code));
      throw error;
    }
  });
  const recovered = await call(recoverPost, action.id, sessionId);
  observer.mockRestore();
  const after = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  const afterPlan = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
  console.log('REVIEW_PLAN_RECONCILIATION_AUDIT_COLLISION', JSON.stringify({ http: recovered.http, ok: recovered.body.data?.ok, status: after.status, planStatus: afterPlan.status, nodeStatus: afterPlan.nodes[0].status, nodeError: afterPlan.nodes[0].error, auditErrors, message: recovered.body.data?.message, balance: await balance(), audits: await p.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } }) }));
  expect(await balance()).toBe(23380);
  expect(after.status).toBe('needs_reconciliation');
});

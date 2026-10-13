import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { createToolRegistry } from '@/agent/tools';
import { banking } from '@/banking-sdk';
import { auditStore } from '@/audit/audit-logger';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import * as cardRepo from '@/lib/db/repositories/card';
import { recordFailure, getState } from '@/security/circuit-breaker';
import { recovery, mfa } from '@/security';
import type { ToolName } from '@/lib/contracts/tools';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { centsToMoney } from '@/lib/money';
import { toJson } from '@/lib/json';
import * as executionFence from '@/agent/execution-fence';
import * as commandExecution from '@/agent/command-execution';

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
const balance = async () => centsToMoney((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor);
async function park(amount = '200') {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const action = await executeGatedTool({ userId, sessionId, toolName: 'transfer_money', args: { name: '张伟', amount }, userRequest: '恢复安全边界回归' });
  expect(action.pendingActionId).toBeTruthy();
  return { id: action.pendingActionId!, sessionId };
}
async function rolledBackTransfer(amount = '200') {
  const action = await park(amount); const original = auditStore.insertAuditLog;
  const fault = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey === `exec:${action.id}`) throw new Error('repair: critical audit unavailable');
    return original(entry, opts);
  });
  expect((await call(confirmPost, action.id, action.sessionId)).http).toBe(500); fault.mockRestore();
  expect(await balance()).toBe('23580.00');
  expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  return action;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(new Error('repair barrier timeout')), 7000))]); }
  finally { clearTimeout(timer); }
}

it('recovery rechecks a breaker that trips after recovery authorization but before the actual SDK write', async () => {
  const p = getTestPrisma(); const action = await rolledBackTransfer();
  const reached = deferred(), release = deferred(); const capture = executionFence.buildConfirmFence;
  const barrier = vi.spyOn(executionFence, 'buildConfirmFence').mockImplementation(async (...input) => {
    const fence = await capture(...input);
    reached.resolve(); await release.promise; return fence;
  });
  const running = call(recoverPost, action.id, action.sessionId);
  let response: Awaited<ReturnType<typeof call>>;
  try {
    await bounded(reached.promise);
    for (let i = 0; i < 3; i++) await recordFailure(action.sessionId);
    expect((await getState(action.sessionId)).locked).toBe(true);
  } finally { release.resolve(); response = await running; barrier.mockRestore(); }
  expect(response!.http).toBe(423); expect(await balance()).toBe('23580.00');
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('confirmed');
  expect(await p.executionReceipt.count()).toBe(0);
  expect(await p.transaction.count({ where: { userId, amountMinor: -20000n, channel: 'TRANSFER' } })).toBe(0);
});

it('a locked session can reconstruct a committed result without creating another debit', async () => {
  const p = getTestPrisma(); const action = await park();
  const fault = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('repair: status unavailable'));
  expect((await call(confirmPost, action.id, action.sessionId)).http).toBe(500);
  expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore(); expect(await balance()).toBe('23380.00');
  for (let i = 0; i < 3; i++) await recordFailure(action.sessionId);
  const recovered = await call(recoverPost, action.id, action.sessionId);
  expect(recovered.body.data).toMatchObject({ ok: true, status: 'executed' });
  expect((await getState(action.sessionId)).locked).toBe(true); expect(await balance()).toBe('23380.00');
  expect(await p.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } })).toBe(1);
  expect(await p.transaction.count({ where: { userId, amountMinor: -20000n, channel: 'TRANSFER' } })).toBe(1);
});

it('recovery escalates newly high-risk transfers to MFA before any new debit, then verifies and commits once', async () => {
  const p = getTestPrisma(); const action = await rolledBackTransfer();
  // Another banking channel posted a transfer since the original authorization.
  await banking.transfer.createTransfer({ userId, name: '张伟', amount: '900', idempotencyKey: 'repair:external-transfer' });
  const recovered = await call(recoverPost, action.id, action.sessionId);
  expect(recovered.body.data).toMatchObject({ ok: false, status: 'awaiting_mfa', tier: 'RED', requiresMfa: true });
  expect(recovered.body.data.events).toContainEqual({ type: 'mfa_required', actionId: action.id });
  expect(await balance()).toBe('22680.00');
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).requiresMfa).toBe(true);
  const wrong = await call(verifyPost, action.id, action.sessionId, { code: '000000' });
  expect(wrong.body.data.ok).toBe(false); expect(await balance()).toBe('22680.00');
  const verified = await call(verifyPost, action.id, action.sessionId, { code: '123456' });
  expect(verified.body.data).toMatchObject({ ok: true, status: 'executed', tier: 'RED' });
  expect(await balance()).toBe('22480.00');
  expect(await p.executionReceipt.count({ where: { userId, key: action.id } })).toBe(1);
});

it.each(['before-landing', 'after-landing'] as const)('concurrent fresh recovery at the 1000 boundary reuses the winner %s without duplicate risk or debit', async timing => {
  const p = getTestPrisma(); const action = await rolledBackTransfer('1000');
  const committed = deferred(), releaseFirst = deferred();
  const readReceipt = commandExecution.readCommandReceipt;
  let held = false;
  vi.spyOn(commandExecution, 'readCommandReceipt').mockImplementation(async (...args) => {
    const result = await readReceipt(...args);
    if (args[0].operationKey === action.id && result !== undefined && !held) {
      held = true; committed.resolve(); await releaseFirst.promise;
    }
    return result;
  });
  const transfer = banking.transfer.createTransfer;
  let transfers = 0;
  vi.spyOn(banking.transfer, 'createTransfer').mockImplementation(async input => {
    transfers++;
    const result = await transfer(input);
    return result;
  });
  const first = call(recoverPost, action.id, action.sessionId);
  let second: Promise<Awaited<ReturnType<typeof call>>> | undefined;
  let results: Awaited<ReturnType<typeof call>>[] = [];
  try {
    await bounded(committed.promise);
    if (timing === 'after-landing') { releaseFirst.resolve(); await first; }
    second = call(recoverPost, action.id, action.sessionId);
    await second;
  } finally {
    releaseFirst.resolve(); results = await Promise.all(second ? [first, second] : [first]);
  }
  for (const [index, response] of results.entries()) {
    expect(response.http).toBe(200);
    expect(response.body.data).toMatchObject({
      ok: index === 1 && timing === 'after-landing' ? false : true,
      status: 'executed', tier: 'YELLOW', requiresMfa: false,
    });
  }
  // The first attempt rolled back: do not narrate a fictitious earlier successful execution.
  expect(results[0].body.data.message).not.toContain('此前已执行');
  expect(await balance()).toBe('22580.00');
  expect(await p.transaction.count({ where: { userId, amountMinor: -100000n, channel: 'TRANSFER' } })).toBe(1);
  expect(await p.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } })).toBe(1);
  expect(transfers).toBe(1);
  expect(await p.mfaChallenge.count({ where: { actionId: action.id } })).toBe(0);
  const settled = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  expect(settled).toMatchObject({ status: 'executed', riskLevel: 'YELLOW', requiresMfa: false });
  expect(JSON.parse(settled.resultJson!)).toMatchObject({ ok: true, data: { amount: '1000.00', newBalance: '22580.00' } });
  expect(await p.executionReceipt.count({ where: { userId, key: action.id } })).toBe(1);
});

const resourceTools: ToolName[] = ['set_card_limit', 'freeze_card', 'unfreeze_card', 'report_lost_card', 'cancel_subscription', 'set_subscription_reminder'];
it.each(resourceTools)('%s refuses another user resource even with valid own confirmation/MFA and forged argument identity', async toolName => {
  const p = getTestPrisma(); const other = await p.user.create({ data: { id: 'repair_other_user', name: '其他客户', phone: '13900008888' } });
  if (toolName === 'unfreeze_card') await p.card.update({ where: { id: 'card_credit' }, data: { status: 'FROZEN' } });
  const sessionId = (await getOrCreateSession(other.id)).sessionId;
  const state = async () => toJson(await Promise.all([p.card.findMany({ orderBy: { id: 'asc' } }), p.cardLimit.findMany({ orderBy: { id: 'asc' } }), p.subscription.findMany({ orderBy: { id: 'asc' } })]));
  const before = await state();
  const action = await executeGatedTool({ userId: other.id, sessionId, toolName, userRequest: '资源归属回归',
    args: { cardId: 'card_credit', category: '娱乐', amount: '1500', subscriptionId: 'sub_netflix', remind: true, userId },
  });
  // Resolution now denies foreign resources before parking. Also exercise execution against a
  // deliberately planted legacy/corrupt row, retaining the original write-boundary assertions.
  expect(action.pendingActionId).toBeUndefined();
  expect(await state()).toBe(before);
  const requiresMfa = ['unfreeze_card', 'report_lost_card'].includes(toolName);
  const row = await actionRepo.createPendingAction({ sessionId, userId: other.id, toolName,
    args: { cardId: 'card_credit', category: '娱乐', amount: '1500', subscriptionId: 'sub_netflix', remind: true, userId },
    tier: requiresMfa ? 'RED' : 'YELLOW', requiresMfa,
    status: requiresMfa ? 'awaiting_mfa' : 'pending',
    summary: { title: 'legacy foreign resource', toolName, tier: requiresMfa ? 'RED' : 'YELLOW', requiresMfa, fields: [] },
  });
  if (requiresMfa) await mfa.issueChallenge(row.id);
  const response = await call(row.requiresMfa ? verifyPost : confirmPost, row.id, sessionId, row.requiresMfa ? { code: '123456' } : {});
  expect(response.body.data.ok).toBe(false); expect(response.body.data.status).toBe('failed');
  expect(await state()).toBe(before);
});

it('resource writers reject missing identity at the SDK boundary', async () => {
  await expect(banking.card.setCardLimit({ userId: '', cardId: 'card_credit', category: '娱乐', amount: '1500' })).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
  await expect(banking.card.freezeCard('card_credit', '')).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
  await expect(banking.subscription.cancelSubscription('sub_netflix', '')).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
  await expect(banking.subscription.setSubscriptionReminder('sub_netflix', true, '')).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
});

it('ownership is enforced again by the actual write when the resource owner changes after lookup', async () => {
  const p = getTestPrisma(); await p.user.create({ data: { id: 'repair_new_owner', name: '新所有者', phone: '13900007777' } });
  const reached = deferred(), release = deferred();
  const original = cardRepo.getCard;
  const lookup = vi.spyOn(cardRepo, 'getCard').mockImplementation(async id => {
    const row = await original(id); reached.resolve(); await release.promise; return row;
  });
  const running = banking.card.setCardLimit({ userId, cardId: 'card_credit', category: '娱乐', amount: '1500' })
    .then(data => ({ ok: true, data }), error => ({ ok: false, error }));
  let result: Awaited<typeof running>;
  try {
    await bounded(reached.promise);
    await p.card.update({ where: { id: 'card_credit' }, data: { userId: 'repair_new_owner' } });
    expect((await p.card.findUniqueOrThrow({ where: { id: 'card_credit' } })).userId).toBe('repair_new_owner');
  } finally { release.resolve(); result = await running; lookup.mockRestore(); }
  expect(result!.ok).toBe(false);
  expect((await p.cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } })).amountMinor).toBe(300000n);
});

async function contradictoryPlan() {
  const p = getTestPrisma(); const sessionId = (await getOrCreateSession(userId)).sessionId;
  const submitted = await runSubmitPlan(userId, { goal: '人工核对审计回归', nodes: [{ id: 'transfer', name: '转账', kind: 'tool', tool: 'transfer_money', args: { name: '张伟', amount: '200' }, dependencies: [] }] }, {
    sessionId, runTool: (toolName, args, ctx) => executeGatedTool({ userId, sessionId, toolName: toolName as ToolName, args, userRequest: '人工核对审计回归', taskId: ctx.taskId, nodeId: ctx.nodeId }),
  });
  const plan = submitted.data as { id: string };
  const action = await p.pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  const fault = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('repair: status unavailable'));
  expect((await call(confirmPost, action.id, sessionId)).http).toBe(500); expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore();
  const audit = await p.auditLog.findUniqueOrThrow({ where: { dedupeKey: `exec:${action.id}` } });
  const receipt = await p.executionReceipt.findFirstOrThrow({ where: { key: `nxe:${plan.id}:transfer` } });
  await p.executionReceipt.update({ where: { id: receipt.id }, data: {
    resultJson: JSON.stringify({ ...JSON.parse(receipt.resultJson), amount: '999.00' }),
    responseJson: JSON.stringify({ ...JSON.parse(receipt.responseJson!), data: { ...JSON.parse(receipt.responseJson!).data, amount: '999.00' } }),
  } });
  return { id: action.id, sessionId, audit, planId: plan.id };
}

it('manual reconciliation retains the original success audit, adds one distinct event, and remains idempotent on repeat', async () => {
  const p = getTestPrisma(); const action = await contradictoryPlan();
  for (let i = 0; i < 2; i++) {
    const response = await call(recoverPost, action.id, action.sessionId);
    expect(response.body.data).toMatchObject({ ok: false, status: 'needs_reconciliation' });
    expect(response.body.data.message).toContain('人工核对');
  }
  expect(await p.auditLog.findUnique({ where: { dedupeKey: `exec:${action.id}` } })).toEqual(action.audit);
  expect(await p.auditLog.count({ where: { dedupeKey: `reconcile:${action.id}`, status: 'blocked' } })).toBe(1);
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('needs_reconciliation');
  expect((await p.agentTask.findUniqueOrThrow({ where: { id: action.planId } })).status).toBe('failed');
  expect(await balance()).toBe('23380.00');
  expect(await p.transaction.count({ where: { userId, amountMinor: -20000n, channel: 'TRANSFER' } })).toBe(1);
});

it('a failed reconciliation audit rolls back the state change and a later recovery succeeds without another debit', async () => {
  const p = getTestPrisma(); const action = await contradictoryPlan(); const original = auditStore.insertAuditLog;
  let injected = 0;
  const fault = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey === `reconcile:${action.id}`) { injected++; throw new Error('repair: reconciliation audit unavailable'); }
    return original(entry, opts);
  });
  expect((await call(recoverPost, action.id, action.sessionId)).http).toBe(500); expect(injected).toBe(1); fault.mockRestore();
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('confirmed');
  expect(await p.auditLog.findUnique({ where: { dedupeKey: `exec:${action.id}` } })).toEqual(action.audit);
  expect(await p.auditLog.count({ where: { dedupeKey: `reconcile:${action.id}` } })).toBe(0);
  expect((await call(recoverPost, action.id, action.sessionId)).body.data.status).toBe('needs_reconciliation');
  expect(await balance()).toBe('23380.00');
});

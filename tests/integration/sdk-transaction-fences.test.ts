import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { banking } from '@/banking-sdk';
import { createToolRegistry } from '@/agent/tools';
import { AppError } from '@/lib/errors';
import type { ToolName } from '@/lib/contracts/tools';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { recordAudit } from '@/audit';
import type { AuditEntry } from '@/lib/contracts/audit';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

const mutations: ToolName[] = ['transfer_money', 'reserve_budget', 'set_card_limit', 'freeze_card',
  'unfreeze_card', 'report_lost_card', 'apply_virtual_card', 'cancel_subscription',
  'set_subscription_reminder', 'create_scheduled_task', 'subscribe_investment', 'redeem_investment'];

async function businessState() {
  const p = getTestPrisma();
  return JSON.stringify(await Promise.all([
    p.account.findMany({ orderBy: { id: 'asc' } }), p.transaction.findMany({ orderBy: { id: 'asc' } }),
    p.card.findMany({ orderBy: { id: 'asc' } }), p.cardLimit.findMany({ orderBy: { id: 'asc' } }),
    p.subscription.findMany({ orderBy: { id: 'asc' } }), p.budget.findMany({ orderBy: { id: 'asc' } }),
    p.scheduledTask.findMany({ orderBy: { id: 'asc' } }), p.investmentHolding.findMany({ orderBy: { id: 'asc' } }),
    p.executionReceipt.findMany({ orderBy: { id: 'asc' } }),
  ]));
}

it.each(mutations)('%s reaches the trusted transaction fence and commits no business mutation when it rejects', async tool => {
  const p = getTestPrisma();
  const subscription = await p.subscription.findFirstOrThrow();
  const product = await p.investmentProduct.findFirstOrThrow({ orderBy: { minAmount: 'asc' } });
  const holding = await p.investmentHolding.findFirstOrThrow({ where: { userId, status: 'HOLDING' } });
  if (tool === 'unfreeze_card') await p.card.update({ where: { id: 'card_credit' }, data: { status: 'FROZEN' } });
  const args: Partial<Record<ToolName, Record<string, unknown>>> = {
    transfer_money: { name: '张伟', amount: 200 }, reserve_budget: { name: '写入围栏预算', amount: 10 },
    set_card_limit: { cardId: 'card_credit', category: '娱乐', amount: 1500 },
    freeze_card: { cardId: 'card_credit' }, unfreeze_card: { cardId: 'card_credit' },
    report_lost_card: { cardId: 'card_credit' }, apply_virtual_card: { label: '写入围栏虚拟卡' },
    cancel_subscription: { subscriptionId: subscription.id },
    set_subscription_reminder: { subscriptionId: subscription.id, remind: !subscription.remind },
    create_scheduled_task: { name: '写入围栏任务', kind: 'REMINDER', runAt: Date.now() + 86400000 },
    subscribe_investment: { productId: product.id, amount: product.minAmount },
    redeem_investment: { holdingId: holding.id },
  };
  const before = await businessState(); let fences = 0;
  const result = await createToolRegistry(userId).executeDirect(tool, args[tool]!, {
    idempotencyKey: `repair:${tool}`,
    fence: async () => { fences++; throw new AppError('CONFLICT', 'repair: execution right revoked'); },
  });
  expect(fences).toBe(1); expect(result.ok).toBe(false); expect(await businessState()).toBe(before);
});

it('legacy same-key/different-request rejects, and matching history replays without guessing its original balance', async () => {
  const p = getTestPrisma(); const key = 'repair:legacy:request-match';
  const input = { userId, name: '张伟', amount: 200, idempotencyKey: key };
  const original = await banking.transfer.createTransfer(input);
  expect((await p.executionReceipt.deleteMany({ where: { userId, key } })).count).toBe(1);
  await p.contact.update({ where: { id: 'contact_zhangwei' }, data: { name: '张伟的新名字' } });
  const replay = await banking.transfer.getCommittedTransfer(input);
  expect(replay?.transactionId).toBe(original.transactionId); expect(replay?.recipient.name).toBe('张伟');
  expect(replay?.newBalance).toBeUndefined();
  await expect(banking.transfer.createTransfer({ ...input, amount: 300 })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance).toBe(23380);
  expect(await p.transaction.count({ where: { id: original.transactionId } })).toBe(1);
});

type Route = typeof confirmPost;
async function call(handler: Route, id: string, sessionId: string) {
  const r = await handler(new NextRequest(`http://localhost/api/actions/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` }, body: '{}',
  }), { params: Promise.resolve({ id }) });
  return { http: r.status, body: await r.json() };
}
async function parkTransfer() {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const parked = await executeGatedTool({ sessionId, userId, toolName: 'transfer_money', args: { name: '张伟', amount: 200 }, userRequest: '审计和历史恢复回归' });
  expect(parked.pendingActionId).toBeTruthy();
  return { sessionId, id: parked.pendingActionId! };
}

it('an already executed historical action with missing audit is repaired exactly once without another debit', async () => {
  const p = getTestPrisma(); const { sessionId, id } = await parkTransfer();
  const first = await call(confirmPost, id, sessionId); expect(first.body.data.ok).toBe(true);
  expect((await p.auditLog.deleteMany({ where: { dedupeKey: `exec:${id}` } })).count).toBe(1);
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('executed');
  const repaired = await call(recoverPost, id, sessionId); expect(repaired.body.data.ok).toBe(true);
  const repeat = await call(recoverPost, id, sessionId); expect(repeat.body.data.status).toBe('executed');
  expect(await p.auditLog.count({ where: { dedupeKey: `exec:${id}` } })).toBe(1);
  expect(await p.transaction.count({ where: { userId, amount: -200, counterpartyId: 'contact_zhangwei' } })).toBe(1);
  expect((await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance).toBe(23380);
});

it('a receipt inconsistent with its ledger routes recovery to reconciliation without re-execution', async () => {
  const p = getTestPrisma(); const { sessionId, id } = await parkTransfer();
  const fault = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('repair: status unavailable'));
  const first = await call(confirmPost, id, sessionId); expect(first.http).toBe(500); expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore();
  const receipt = await p.executionReceipt.findFirstOrThrow({ where: { userId, key: id } });
  await p.executionReceipt.update({ where: { id: receipt.id }, data: { resultJson: JSON.stringify({ ...JSON.parse(receipt.resultJson), amount: 999 }) } });
  const recovered = await call(recoverPost, id, sessionId);
  expect(recovered.body.data.status).toBe('needs_reconciliation');
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('needs_reconciliation');
  expect((await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance).toBe(23380);
  expect(await p.transaction.count({ where: { userId, amount: -200, counterpartyId: 'contact_zhangwei' } })).toBe(1);
});

it('strict audit dedupe never absorbs a different tool or business outcome under the same key', async () => {
  const entry: AuditEntry = { timestamp: Date.now(), sessionId: 'repair:audit-session', userRequest: '审计身份', toolName: 'transfer_money', riskLevel: 'YELLOW', confirmationRequired: true, confirmed: true, mfaRequired: false, status: 'success', toolResult: { ok: true, data: { transactionId: 'repair:tx', amount: 200 } } };
  await recordAudit(entry, { dedupeKey: 'repair:audit-identity', strict: true });
  await expect(recordAudit({ ...entry, toolName: 'apply_virtual_card' }, { dedupeKey: 'repair:audit-identity', strict: true })).rejects.toMatchObject({ code: 'P2002' });
  await expect(recordAudit({ ...entry, status: 'failed', toolResult: { ok: false } }, { dedupeKey: 'repair:audit-identity', strict: true })).rejects.toMatchObject({ code: 'P2002' });
  expect(await getTestPrisma().auditLog.count({ where: { dedupeKey: 'repair:audit-identity' } })).toBe(1);
});

/** Real HTTP/gateway/Pi runtime/SDK/SQLite regressions; only execution scheduling is controlled. */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executeGatedTool, getOrCreateSession } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { banking } from '@/banking-sdk';
import { getState } from '@/security/circuit-breaker';
import { computeDailyTransferTotal } from '@/security/risk-engine';
import { idempotentTransferTxId } from '@/lib/ledger';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as chatPost } from '@/app/api/chat/route';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

async function call(handler: typeof confirmPost, id: string, sessionId: string, body: object = {}) {
  const response = await handler(new NextRequest(`http://localhost/api/actions/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
  return { http: response.status, body: await response.json() };
}

async function chat(message: string, sessionId: string) {
  const response = await chatPost(new NextRequest('http://localhost/api/chat?stream=0', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` },
    body: JSON.stringify({ message }),
  }));
  return { http: response.status, body: await response.json() };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('repair barrier timeout')), 7000);
    })]);
  } finally { clearTimeout(timer); }
}

async function park(amount: number, sessionId: string) {
  const outcome = await executeGatedTool({ userId, sessionId, toolName: 'transfer_money',
    args: { name: '张伟', amount }, userRequest: '金额及熔断回归' });
  expect(outcome.pendingActionId).toBeTruthy();
  return outcome.pendingActionId!;
}

const balance = async () => (await getTestPrisma().account.findUniqueOrThrow({
  where: { id: 'acct_checking' },
})).balance;

it('[integration] rejects both fractional-cent requests through natural-language HTTP before creating authorization', async () => {
  const p = getTestPrisma();
  const before = await p.transaction.findMany({ where: { userId, channel: 'TRANSFER' } });
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  for (const amount of [999.995, 0.005]) {
    const response = await chat(`给张伟转${amount}元`, sessionId);
    expect(JSON.stringify(response.body)).toContain('两位小数');
  }
  expect(await p.pendingAction.count({ where: { sessionId } })).toBe(0);
  expect(await p.transaction.findMany({ where: { userId, channel: 'TRANSFER' } })).toEqual(before);
  expect(await balance()).toBe(23580);
});

it.each([999.995, 0.005, NaN, Infinity, 0, -1])(
  '[integration] SDK rejects invalid amount %s without rounding or creating financial facts', async amount => {
    const p = getTestPrisma();
    const before = await p.executionReceipt.count();
    const beforeLedger = await p.transaction.findMany({ where: { userId, channel: 'TRANSFER' } });
    await expect(banking.transfer.createTransfer({ userId, name: '张伟', amount,
      idempotencyKey: 'invalid:amount' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await balance()).toBe(23580);
    expect(await p.transaction.findMany({ where: { userId, channel: 'TRANSFER' } })).toEqual(beforeLedger);
    expect(await p.executionReceipt.count()).toBe(before);
  },
);

it('[integration] legacy fractional-cent pending actions cannot be confirmed concurrently', async () => {
  const p = getTestPrisma();
  const before = await p.transaction.findMany({ where: { userId, channel: 'TRANSFER' } });
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const ids = [await park(999.99, sessionId), await park(0.01, sessionId)];
  for (const [index, amount] of [999.995, 0.005].entries()) {
    await p.pendingAction.update({ where: { id: ids[index] }, data: {
      argsJson: JSON.stringify({ name: '张伟', amount }),
    } });
  }
  const responses = await Promise.all(ids.map(id => call(confirmPost, id, sessionId)));
  expect(responses.map(r => r.http)).toEqual([400, 400]);
  expect(await balance()).toBe(23580);
  expect(await p.transaction.findMany({ where: { userId, channel: 'TRANSFER' } })).toEqual(before);
  expect((await p.pendingAction.findMany({ where: { id: { in: ids } } })).every(r => r.status === 'pending')).toBe(true);
});

it('[integration] an invalid legacy in-flight amount fails closed without authorizing a new transfer', async () => {
  const p = getTestPrisma();
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const invalid = await park(999.99, sessionId);
  await p.pendingAction.update({ where: { id: invalid }, data: {
    status: 'confirmed', argsJson: JSON.stringify({ name: '张伟', amount: 999.995 }),
  } });
  const next = await park(0.01, sessionId);
  const response = await call(confirmPost, next, sessionId);
  expect(response.http).toBe(400);
  expect(await balance()).toBe(23580);
  expect(await computeDailyTransferTotal(userId)).toBe(0);
  expect((await p.pendingAction.findUniqueOrThrow({ where: { id: next } })).status).toBe('pending');
});

it.each([0.01, 0.02])('[integration] concurrent 999.99 + %s uses exact cents and requires MFA only above 1000', async secondAmount => {
  const p = getTestPrisma();
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const first = await park(999.99, sessionId);
  const second = await park(secondAmount, sessionId);
  const reached = deferred(), release = deferred();
  const transfer = banking.transfer.createTransfer;
  const barrier = vi.spyOn(banking.transfer, 'createTransfer').mockImplementation(async input => {
    if (input.idempotencyKey === first) { reached.resolve(); await release.promise; }
    return transfer(input);
  });
  const running = call(confirmPost, first, sessionId);
  let one!: Awaited<ReturnType<typeof call>>;
  let two!: Awaited<ReturnType<typeof call>>;
  try {
    await bounded(reached.promise);
    two = await call(confirmPost, second, sessionId);
    expect(two.body.data.requiresMfa).toBe(secondAmount === 0.02);
    expect(two.body.data.tier).toBe(secondAmount === 0.02 ? 'RED' : 'YELLOW');
    if (secondAmount === 0.02) {
      expect(two.body.data.status).toBe('awaiting_mfa');
      expect(await balance()).toBe(23580);
    }
  } finally { release.resolve(); one = await running; barrier.mockRestore(); }
  expect(one.body.data.status).toBe('executed');
  if (secondAmount === 0.02) {
    expect(await computeDailyTransferTotal(userId)).toBe(999.99);
    expect((await call(verifyPost, second, sessionId, { code: '123456' })).body.data.status).toBe('executed');
  } else {
    expect(two.body.data.status).toBe('executed');
  }
  const expectedTotal = secondAmount === 0.02 ? 1000.01 : 1000;
  expect(await computeDailyTransferTotal(userId)).toBe(expectedTotal);
  expect(await balance()).toBeCloseTo(23580 - expectedTotal, 8);
  const rows = await p.transaction.findMany({ where: {
    id: { in: [first, second].map(id => idempotentTransferTxId(userId, id)) },
  } });
  expect(rows.map(r => r.amount).sort((a, b) => a - b)).toEqual([-999.99, -secondAmount]);
  for (const [id, amount] of [[first, 999.99], [second, secondAmount]] as const) {
    const action = await p.pendingAction.findUniqueOrThrow({ where: { id } });
    expect(JSON.parse(action.argsJson).amount).toBe(amount);
    const receipt = await p.executionReceipt.findFirstOrThrow({ where: { userId, key: id } });
    expect(JSON.parse(receipt.resultJson).amount).toBe(amount);
  }
});

it('[integration] ordinary cent amounts remain valid despite binary floating-point representation', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const id = await park(0.29, sessionId);
  expect((await call(confirmPost, id, sessionId)).body.data.status).toBe('executed');
  expect(await computeDailyTransferTotal(userId)).toBe(0.29);
  expect(await balance()).toBeCloseTo(23579.71, 8);
});

it.each(['standalone', 'plan', 'chat'] as const)(
  '[integration] GREEN %s budget cannot write after three real MFA failures trip the session', async scope => {
    const p = getTestPrisma();
    const sessionId = (await getOrCreateSession(userId)).sessionId;
    const blocker = await park(5000, sessionId);
    const before = await p.budget.count();
    const reached = deferred(), release = deferred();
    const reserve = banking.budget.reserveBudget;
    const barrier = vi.spyOn(banking.budget, 'reserveBudget').mockImplementation(async input => {
      reached.resolve(); await release.promise; return reserve(input);
    });
    const args = { name: '熔断边界预算', amount: 1000 };
    const running = scope === 'standalone'
      ? executeGatedTool({ userId, sessionId, toolName: 'reserve_budget', args, userRequest: '预留预算' })
      : scope === 'chat'
        ? chat('帮我预留1000元买手机', sessionId)
        : runSubmitPlan(userId, { goal: '熔断预算', nodes: [
          { id: 'budget', name: '预留预算', kind: 'tool', tool: 'reserve_budget', args, dependencies: [] },
          { id: 'next', name: '后续预算', kind: 'tool', tool: 'reserve_budget', args, dependencies: ['budget'] },
        ] }, { sessionId, runTool: (toolName, toolArgs, ctx) => executeGatedTool({
          userId, sessionId, toolName, args: toolArgs, userRequest: '计划预算', taskId: ctx.taskId, nodeId: ctx.nodeId,
        }) });
    let outcome: unknown;
    try {
      await bounded(reached.promise);
      for (let i = 0; i < 3; i++) await call(verifyPost, blocker, sessionId, { code: '000000' });
      expect((await getState(sessionId)).locked).toBe(true);
      expect(await p.budget.count()).toBe(before);
    } finally { release.resolve(); outcome = await running; }
    expect(await p.budget.count()).toBe(before);
    expect(JSON.stringify(outcome)).toContain('熔断');
    expect(barrier).toHaveBeenCalledTimes(1);
  },
);

it('[integration] same local budget key belongs to each user, and each owner replays only their own row', async () => {
  const p = getTestPrisma();
  const sessionA = (await getOrCreateSession(userId)).sessionId;
  const other = await p.user.create({ data: { id: 'budget_other', name: '其他客户', phone: '13900007777' } });
  const sessionB = (await getOrCreateSession(other.id)).sessionId;
  const reserve = (owner: string, sessionId: string, name: string, amount: number, purpose: string) =>
    executeGatedTool({ userId: owner, sessionId, toolName: 'reserve_budget', userRequest: '预算幂等归属',
      args: { name, amount, purpose, idempotencyKey: 'monthly-rent' } });
  const [a, b] = await Promise.all([
    reserve(userId, sessionA, 'A的预算', 1000, '个人财务信息A'),
    reserve(other.id, sessionB, 'B的预算', 10, '个人财务信息B'),
  ]);
  expect(a.ok).toBe(true); expect(b.ok).toBe(true);
  expect(a.data).toMatchObject({ name: 'A的预算', amount: 1000, purpose: '个人财务信息A' });
  expect(b.data).toMatchObject({ name: 'B的预算', amount: 10, purpose: '个人财务信息B' });
  expect(JSON.stringify(b)).not.toContain('个人财务信息A');
  expect(await p.budget.count({ where: { idempotencyKey: 'monthly-rent' } })).toBe(2);
  const repeats = await Promise.all([
    reserve(userId, sessionA, 'A的预算', 1000, '个人财务信息A'),
    reserve(other.id, sessionB, 'B的预算', 10, '个人财务信息B'),
  ]);
  expect(repeats.map(r => r.data)).toEqual([a.data, b.data]);
  expect(await p.budget.count({ where: { userId: other.id } })).toBe(1);
});

it('[integration] concurrent SDK replays of one owner/key create only one budget', async () => {
  const p = getTestPrisma();
  const input = { userId, name: '并发预算', amount: 100, idempotencyKey: 'same-owner:key' };
  const [a, b] = await Promise.all([banking.budget.reserveBudget(input), banking.budget.reserveBudget(input)]);
  expect(b).toEqual(a);
  expect(await p.budget.count({ where: { userId, idempotencyKey: input.idempotencyKey } })).toBe(1);
});

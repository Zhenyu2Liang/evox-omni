import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeGatedTool, getOrCreateSession, verifyAction } from '@/agent';
import { securityGateway } from '@/security/security-gateway';
import { buildAutomaticWriteFence, buildPlanNodeFence } from '@/agent/execution-fence';
import { createToolRegistry } from '@/agent/tools';
import { claimPendingActionLease } from '@/lib/db/repositories/pendingAction';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function parkedAction() {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const outcome = await executeGatedTool({
    sessionId, userId, toolName: 'transfer_money',
    args: { contactId: 'contact_zhangwei', amount: '2000' }, userRequest: 'Transfer approval lease regression',
  });
  expect(outcome.pendingActionId).toBeTruthy();
  return { actionId: outcome.pendingActionId!, sessionId, userId };
}

it('a duplicate arriving before authorization cannot replace or release the live owner lease', async () => {
  const identity = await parkedAction();
  const reached = deferred();
  const release = deferred();
  const authorize = securityGateway.authorizeAction.bind(securityGateway);
  let calls = 0;
  vi.spyOn(securityGateway, 'authorizeAction').mockImplementation(async (...args) => {
    if (++calls === 1) {
      reached.resolve();
      await release.promise;
    }
    return authorize(...args);
  });
  const first = verifyAction(identity.actionId, '123456', identity);
  let firstOutcome;
  try {
    await reached.promise;
    const before = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: identity.actionId } });
    expect(before.status).toBe('awaiting_mfa');
    expect(before.executionLeaseOwner).not.toBeNull();
    const duplicate = await verifyAction(identity.actionId, '123456', identity);
    const after = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: identity.actionId } });
    expect(duplicate.ok).toBe(false);
    expect(calls).toBe(1);
    expect(after.executionLeaseOwner).toBe(before.executionLeaseOwner);
    expect(after.executionLeaseExpiresAt).toEqual(before.executionLeaseExpiresAt);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  } finally {
    release.resolve();
    firstOutcome = await first;
  }
  expect(firstOutcome.ok).toBe(true);
  expect(await getTestPrisma().transaction.count({ where: { userId, amountMinor: -200000n, channel: 'TRANSFER' } })).toBe(1);
  expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: identity.actionId } })).executionLeaseOwner).toBeNull();
});

it('a live lease persisted by another process refuses a new human decision until its expiry', async () => {
  const identity = await parkedAction();
  const now = Date.now();
  expect(await claimPendingActionLease(identity.actionId, {
    owner: 'other-process', now: new Date(now), expiresAt: new Date(now + 60000),
  })).toBe(true);
  const duplicate = await verifyAction(identity.actionId, '123456', identity);
  expect(duplicate.ok).toBe(false);
  expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: identity.actionId } })).executionLeaseOwner).toBe('other-process');
  expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  await getTestPrisma().pendingAction.update({ where: { id: identity.actionId }, data: { executionLeaseExpiresAt: new Date(now - 1) } });
  expect((await verifyAction(identity.actionId, '123456', identity)).ok).toBe(true);
});

it('a foreign caller cannot mutate execution lease metadata', async () => {
  const identity = await parkedAction();
  await expect(verifyAction(identity.actionId, '123456', { userId: 'foreign-user', sessionId: identity.sessionId }))
    .rejects.toMatchObject({ code: 'SECURITY_DENIED' });
  expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: identity.actionId } })).executionLeaseOwner).toBeNull();
});

it.each([
  ['missing-task', 'missing-node'], ['missing-task', undefined], [undefined, 'missing-node'], ['', 'missing-node'],
])('an incomplete or deleted workflow link fails closed: %s / %s', async (taskId, nodeId) => {
  await expect(buildPlanNodeFence(taskId, nodeId)).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('a deleted node cannot silently become a standalone automatic banking write', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const task = await getTestPrisma().agentTask.create({ data: {
    sessionId, userId, goal: 'Deleted node fence regression', status: 'running', executionToken: 'live-plan-owner',
  } });
  let writes = 0;
  await expect((async () => {
    const fence = await buildAutomaticWriteFence(sessionId, task.id, 'deleted-node');
    writes++;
    return createToolRegistry(userId).executeDirect('reserve_budget', { name: 'Deleted node budget', amount: '10' }, { fence });
  })()).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(writes).toBe(0);
  expect(await getTestPrisma().budget.count({ where: { userId, name: 'Deleted node budget' } })).toBe(0);
});

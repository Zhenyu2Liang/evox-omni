import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmAction, executeGatedTool, getDemoSession, verifyAction } from '@/agent';
import { createToolRegistry } from '@/agent/tools';
import * as fences from '@/agent/execution-fence';
import { safeParse } from '@/lib/json';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import type { ToolName } from '@/lib/contracts/tools';

const userId = 'user_liming';
beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectTestPrisma);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function pauseAtWriteFence() {
  const reached = deferred();
  const release = deferred();
  const original = fences.buildConfirmFence;
  const spy = vi.spyOn(fences, 'buildConfirmFence').mockImplementationOnce(async (...args) => {
    const fence = await original(...args);
    reached.resolve();
    await release.promise;
    return fence;
  });
  return { reached: reached.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

async function park(red = true, toolName: ToolName = 'transfer_money') {
  const sessionId = (await getDemoSession(userId)).sessionId;
  const outcome = await executeGatedTool({ userId, sessionId, toolName,
    args: toolName === 'transfer_money' ? { contactId: 'contact_zhangwei', amount: red ? '2000.00' : '200.00' }
      : { cardId: 'card_credit' }, userRequest: 'Write authority regression' });
  expect(outcome.pendingActionId).toBeTruthy();
  return { id: outcome.pendingActionId!, sessionId };
}

async function assertNoCommit(actionId: string, rejectionReason?: RegExp) {
  const db = getTestPrisma();
  expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  expect(await db.executionReceipt.count()).toBe(0);
  expect(await db.auditLog.count({ where: { dedupeKey: `exec:${actionId}`, status: 'success' } })).toBe(0);
  if (rejectionReason) {
    const audit = await db.auditLog.findFirstOrThrow({ where: { dedupeKey: `exec:${actionId}`, status: { in: ['failed', 'blocked'] } } });
    const outcome = safeParse<{ ok?: boolean; error?: string }>(audit.toolResult, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(rejectionReason);
  }
  expect((await db.card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status).toBe('ACTIVE');
}

describe('confirmed banking commands revalidate authority at mutation time', () => {
  it('renews an expired pending verification but requires a fresh submission instead of using the old submitted code', async () => {
    const action = await park();
    const db = getTestPrisma();
    await db.mfaChallenge.update({ where: { actionId: action.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    const renewed = await verifyAction(action.id, '123456', { userId, sessionId: action.sessionId });
    expect(renewed).toMatchObject({ ok: false, status: 'awaiting_mfa', requiresMfa: true });
    const challenge = await db.mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } });
    expect(challenge.status).toBe('pending');
    expect(challenge.attempts).toBe(0);
    expect(challenge.verifiedAt).toBeNull();
    expect(challenge.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    await assertNoCommit(action.id);
    const confirmed = await verifyAction(action.id, '123456', { userId, sessionId: action.sessionId });
    expect(confirmed).toMatchObject({ ok: true, status: 'executed' });
    expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2158000n);
    expect(await db.executionReceipt.count()).toBe(1);
  });

  it('reuses an unexpired pending challenge without resetting existing failure counts', async () => {
    const action = await park();
    await verifyAction(action.id, '000000', { userId, sessionId: action.sessionId });
    const db = getTestPrisma();
    const before = await db.mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } });
    expect(before.attempts).toBe(1);
    const prompted = await confirmAction(action.id, { userId, sessionId: action.sessionId });
    expect(prompted).toMatchObject({ ok: false, status: 'awaiting_mfa' });
    const after = await db.mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } });
    expect(after).toEqual(before);
    await assertNoCommit(action.id);
  });

  it.each(['expired', 'consumed', 'changed_digest'] as const)('rejects %s verification after successful gateway authorization but before a new debit', async reason => {
    const action = await park();
    const barrier = await pauseAtWriteFence();
    const running = verifyAction(action.id, '123456', { userId, sessionId: action.sessionId });
    let result: Awaited<typeof running>;
    try {
      await barrier.reached;
      const challenge = await getTestPrisma().mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } });
      expect(challenge.status).toBe('verified');
      await getTestPrisma().mfaChallenge.update({ where: { actionId: action.id }, data: reason === 'expired'
        ? { expiresAt: new Date(Date.now() - 1) } : reason === 'consumed' ? { consumedAt: new Date() }
          : { commandDigest: 'another-command' } });
    } finally { barrier.release(); result = await running; barrier.restore(); }
    expect(result!.ok).toBe(false);
    await assertNoCommit(action.id, /verification expired, was consumed or no longer matches this command/);
  });

  it('applies the same verification expiry check to static RED card commands', async () => {
    const action = await park(true, 'freeze_card');
    const barrier = await pauseAtWriteFence();
    const running = verifyAction(action.id, '123456', { userId, sessionId: action.sessionId });
    let result: Awaited<typeof running>;
    try {
      await barrier.reached;
      await getTestPrisma().mfaChallenge.update({ where: { actionId: action.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    } finally { barrier.release(); result = await running; barrier.restore(); }
    expect(result!.ok).toBe(false);
    await assertNoCommit(action.id, /verification expired, was consumed or no longer matches this command/);
  });

  it.each(['closed', 'changed_owner'] as const)('rejects a %s session after a YELLOW command was authorized', async reason => {
    const action = await park(false);
    const barrier = await pauseAtWriteFence();
    const running = confirmAction(action.id, { userId, sessionId: action.sessionId });
    // A revoked session can also deny result narration. The bank mutation must remain absent.
    const observed = running.catch(error => ({ ok: false, error }));
    try {
      await barrier.reached;
      if (reason === 'changed_owner') {
        await getTestPrisma().user.create({ data: { id: 'replacement_owner', name: 'Replacement', phone: '00000000000' } });
      }
      await getTestPrisma().agentSession.update({ where: { id: action.sessionId }, data: reason === 'closed'
        ? { status: 'closed' } : { userId: 'replacement_owner' } });
    } finally { barrier.release(); barrier.restore(); }
    expect((await observed).ok).toBe(false);
    await assertNoCommit(action.id, /session is no longer active or owned by this user/);
  });

  it('replays a committed RED receipt after its verification is consumed and expired without entering the write fence', async () => {
    const action = await park();
    const result = await verifyAction(action.id, '123456', { userId, sessionId: action.sessionId });
    expect(result.ok).toBe(true);
    const db = getTestPrisma();
    const row = await db.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
    const challenge = await db.mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } });
    expect(challenge.consumedAt).not.toBeNull();
    await db.mfaChallenge.update({ where: { actionId: action.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await db.agentSession.update({ where: { id: action.sessionId }, data: { status: 'closed' } });
    const args = safeParse<Record<string, unknown>>(row.argsJson, {});
    const fence = await fences.buildConfirmFence(null, null, action.id, { userId, sessionId: action.sessionId, toolName: row.toolName, args });
    const invoked = vi.fn(fence);
    const replay = await createToolRegistry(userId).executeDirect(row.toolName as ToolName, args,
      { idempotencyKey: action.id, fence: invoked });
    expect(replay).toEqual(result.result);
    expect(invoked).not.toHaveBeenCalled();
    expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2158000n);
    expect(await db.executionReceipt.count()).toBe(1);
    expect(await db.transaction.count({ where: { accountId: 'acct_checking', amountMinor: -200000n, channel: 'TRANSFER' } })).toBe(1);
    expect(await db.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } })).toBe(1);
  });
});

import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/cards/[id]/consume/route';
import { banking } from '@/banking-sdk';
import { security } from '@/security';
import { getDemoSession } from '@/agent/session';
import * as turns from '@/agent/run-turn';
import type { CardConsumptionResponse } from '@/lib/contracts/card-consumption';
import { getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { idCtx, postJson } from './harness';

beforeEach(resetDatabase);
const db = () => getTestPrisma();
const balance = async () => (await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
const call = (body: Record<string, unknown>, cardId = 'card_debit') => postJson<{ data?: CardConsumptionResponse }>(
  POST, `/api/cards/${cardId}/consume`, body, { ctx: idCtx(cardId) });
const input = { amount: '2.00', category: '餐饮', executionKey: 'security-spend' };
const verify = (actionId: string, extra: Record<string, unknown> = {}) => call({ ...input, actionId, confirmed: true, code: '123456', ...extra });

it('only proposes without MFA, then executes once without calling model narration', async () => {
  const narration = vi.spyOn(turns, 'resumeTurn');
  try {
    const before = await balance();
    const proposal = await call(input);
    expect(proposal.data?.data).toMatchObject({ ok: false, status: 'awaiting_mfa' });
    expect(await balance()).toBe(before);
    const actionId = proposal.data!.data!.actionId;
    expect((await verify(actionId, { confirmed: false })).status).toBe(403);
    const done = await verify(actionId);
    expect(done.data?.data).toMatchObject({ ok: true, status: 'executed', result: { consumption: { amount: '2.00' } } });
    expect(await balance()).toBe(before - 200n);
    const replay = await call(input);
    expect(replay.data?.data?.result).toEqual(done.data?.data?.result);
    expect(await db().cardConsumption.count()).toBe(1);
    expect(narration).not.toHaveBeenCalled();
  } finally { narration.mockRestore(); }
});

it('refuses a new proposal while the account is locked', async () => {
  const identity = await getDemoSession(DEMO_USER_ID);
  for (let n = 0; n < 3; n++) await security.circuitBreaker.recordFailure(identity.sessionId);
  const before = await balance();
  expect((await call(input)).status).toBe(423);
  expect(await balance()).toBe(before);
  expect(await db().pendingAction.count()).toBe(0);
});

it('refuses a correct code if the account was locked after the proposal', async () => {
  const proposal = await call(input);
  const identity = await getDemoSession(DEMO_USER_ID);
  for (let n = 0; n < 3; n++) await security.circuitBreaker.recordFailure(identity.sessionId);
  const before = await balance();
  expect((await verify(proposal.data!.data!.actionId)).status).toBe(423);
  expect(await balance()).toBe(before);
});

it('binds verification and retries to the original card and arguments', async () => {
  const proposal = await call(input);
  const actionId = proposal.data!.data!.actionId;
  expect((await verify(actionId, { amount: '2000.00' })).status).toBe(409);
  expect((await verify(actionId, { merchant: 'changed' })).status).toBe(409);
  expect((await call({ ...input, amount: '3.00' })).status).toBe(409);
  expect((await call({ ...input, actionId, confirmed: true, code: '123456' }, 'card_credit')).status).toBe(409);
  expect(await db().cardConsumption.count()).toBe(0);
});

it('locks a proposal after three incorrect codes and never revives it on account reset', async () => {
  const proposal = await call(input);
  const id = proposal.data!.data!.actionId;
  for (let n = 0; n < 3; n++) await verify(id, { code: '000000' });
  expect((await db().pendingAction.findUniqueOrThrow({ where: { id } })).status).toBe('locked');
  const identity = await getDemoSession(DEMO_USER_ID);
  await security.circuitBreaker.resetDemoSession(identity.sessionId);
  expect((await verify(id)).status).toBe(409);
  expect(await db().cardConsumption.count()).toBe(0);
});

it('does not double debit concurrent verification requests', async () => {
  const proposal = await call(input);
  const responses = await Promise.all([verify(proposal.data!.data!.actionId), verify(proposal.data!.data!.actionId)]);
  expect(responses.some(response => response.data?.data?.status === 'executed')).toBe(true);
  expect(await db().cardConsumption.count()).toBe(1);
});

it('checks category limits again when the verified operation actually commits', async () => {
  const proposal = await call(input);
  await banking.card.setCardLimit({ userId: DEMO_USER_ID, cardId: 'card_debit', category: '餐饮', amount: '1.00' });
  const before = await balance();
  expect((await verify(proposal.data!.data!.actionId)).status).toBe(422);
  expect(await balance()).toBe(before);
  expect(await db().cardConsumption.count()).toBe(0);
});

it('rechecks the account lock at the execution fence after MFA was accepted', async () => {
  const proposal = await call(input);
  const gateway = security.gateway.securityGateway;
  const authorize = gateway.authorizeAction.bind(gateway);
  const hook = vi.spyOn(gateway, 'authorizeAction').mockImplementation(async (...args) => {
    const outcome = await authorize(...args);
    if (outcome.ok) {
      const identity = await getDemoSession(DEMO_USER_ID);
      for (let n = 0; n < 3; n++) await security.circuitBreaker.recordFailure(identity.sessionId);
    }
    return outcome;
  });
  try {
    const before = await balance();
    expect((await verify(proposal.data!.data!.actionId)).status).toBe(423);
    expect(await balance()).toBe(before);
    expect(await db().cardConsumption.count()).toBe(0);
  } finally { hook.mockRestore(); }
});

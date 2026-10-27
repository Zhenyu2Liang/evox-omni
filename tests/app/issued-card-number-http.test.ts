import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/actions/[id]/card-number/route';
import { executeGatedTool } from '@/agent/confirmation';
import { getDemoSession, verifyAction } from '@/agent';
import { MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
const db = getTestPrisma;
const userId = 'user_liming';
const request = (id: string) => GET(new NextRequest(`http://localhost/api/actions/${id}/card-number`), { params: Promise.resolve({ id }) });

async function issuance(execute = true) {
  const { sessionId } = await getDemoSession(userId);
  const originalCount = await db().card.count();
  await db().card.update({ where: { id: 'card_credit' }, data: { status: 'LOST' } });
  await executeGatedTool({ userId, sessionId, toolName: 'replace_card', args: { cardId: 'card_credit' }, userRequest: '补办信用卡' });
  const action = await db().pendingAction.findFirstOrThrow({ where: { sessionId, toolName: 'replace_card' } });
  if (execute) expect((await verifyAction(action.id, MFA_CODE, { sessionId, userId })).ok).toBe(true);
  return { actionId: action.id, sessionId, originalCount };
}

describe('verified issuance number receipt', () => {
  it('reveals the actual new number only after verified execution without changing the stored model result', async () => {
    const { actionId, originalCount } = await issuance();
    const action = await db().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    const result = JSON.parse(action.resultJson!);
    const card = await db().card.findUniqueOrThrow({ where: { id: result.data.id } });
    const response = await request(actionId);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).data).toEqual({ cardId: card.id, cardNumber: card.numberFull, numberMasked: card.numberMasked });
    expect(card.numberFull).toMatch(/^\d{12,19}$/);
    expect(action.resultJson).not.toContain(card.numberFull!);
    expect(await db().card.count()).toBe(originalCount + 1);
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status).toBe('LOST');
  });

  it('does not reveal a number while the issuance is waiting for MFA', async () => {
    const { actionId, originalCount } = await issuance(false);
    expect((await request(actionId)).status).toBe(403);
    expect(await db().card.count()).toBe(originalCount);
  });

  it.each(['owner', 'session', 'unverified', 'unconsumed', 'wrong-tool', 'failed'] as const)('fails closed for %s evidence', async change => {
    const { actionId } = await issuance();
    if (change === 'owner') await db().pendingAction.update({ where: { id: actionId }, data: { userId: 'another-owner' } });
    if (change === 'session') await db().pendingAction.update({ where: { id: actionId }, data: { sessionId: 'another-session' } });
    if (change === 'unverified') await db().mfaChallenge.update({ where: { actionId }, data: { verifiedAt: null } });
    if (change === 'unconsumed') await db().mfaChallenge.update({ where: { actionId }, data: { consumedAt: null } });
    if (change === 'wrong-tool') await db().pendingAction.update({ where: { id: actionId }, data: { toolName: 'freeze_card' } });
    if (change === 'failed') await db().pendingAction.update({ where: { id: actionId }, data: { status: 'failed' } });
    const response = await request(actionId);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('cardNumber');
  });
});

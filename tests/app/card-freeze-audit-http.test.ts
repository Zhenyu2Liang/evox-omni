import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeGatedTool, getDemoSession } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { GET as auditGet, type AuditData } from '@/app/api/audit/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import { auditStore } from '@/audit/audit-logger';
import { MFA_CODE } from '@/lib/constants';
import { DEVELOPER_MODE_COOKIE, DEVELOPER_MODE_ENABLED } from '@/lib/developer-mode/shared';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, getJson, idCtx, postJson } from './harness';

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string } }
const developerOptions = { cookie: `${DEVELOPER_MODE_COOKIE}=${DEVELOPER_MODE_ENABLED}` };
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

async function cardStatus(id: string) {
  return (await getTestPrisma().card.findUniqueOrThrow({ where: { id } })).status;
}

async function confirm(id: string) {
  return postJson<Envelope<ActionResponse>>(confirmPost, actionUrl(id, 'confirm'), {}, { ctx: idCtx(id) });
}

async function verify(id: string, code = MFA_CODE) {
  return postJson<Envelope<ActionResponse>>(verifyPost, actionUrl(id, 'verify'), { code }, { ctx: idCtx(id) });
}

describe('card status authorization and visible owner-scoped audit', () => {
  it('requires independent verification for both cards in a workflow and exposes both committed audits', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const goal = 'Freeze both owned cards';
    await runSubmitPlan(DEMO_USER_ID, { goal, nodes: [
      { id: 'credit', name: 'Freeze credit card', kind: 'tool', tool: 'freeze_card',
        args: { cardId: 'card_credit' }, dependencies: [] },
      { id: 'debit', name: 'Freeze debit card', kind: 'tool', tool: 'freeze_card',
        args: { cardId: 'card_debit' }, dependencies: [] },
    ] }, { sessionId, runTool: (toolName, args, context) => executeGatedTool({
      sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: goal, ...context,
    }) });
    const database = getTestPrisma();
    const first = await database.pendingAction.findFirstOrThrow({ where: { sessionId, nodeId: 'credit' } });
    expect(first).toMatchObject({ status: 'awaiting_mfa', riskLevel: 'RED', requiresMfa: true });
    expect((await confirm(first.id)).data?.data?.status).toBe('awaiting_mfa');
    expect(await cardStatus('card_credit')).toBe('ACTIVE');
    expect(await cardStatus('card_debit')).toBe('ACTIVE');
    expect((await verify(first.id, '000000')).data?.data?.ok).toBe(false);
    expect(await cardStatus('card_credit')).toBe('ACTIVE');
    expect((await verify(first.id)).data?.data?.ok).toBe(true);
    expect(await cardStatus('card_credit')).toBe('FROZEN');
    expect(await cardStatus('card_debit')).toBe('ACTIVE');
    const second = await database.pendingAction.findFirstOrThrow({ where: { sessionId, nodeId: 'debit' } });
    expect(second).toMatchObject({ status: 'awaiting_mfa', riskLevel: 'RED', requiresMfa: true });
    const secondChallenge = await database.mfaChallenge.findUniqueOrThrow({ where: { actionId: second.id } });
    expect(secondChallenge.status).not.toBe('verified');
    expect(secondChallenge.consumedAt).toBeNull();
    expect((await confirm(second.id)).data?.data?.status).toBe('awaiting_mfa');
    expect(await cardStatus('card_debit')).toBe('ACTIVE');
    expect((await verify(second.id)).data?.data?.ok).toBe(true);
    expect(await cardStatus('card_debit')).toBe('FROZEN');

    const audits = await getJson<Envelope<AuditData>>(auditGet,
      '/api/audit?toolName=freeze_card&status=success&riskLevel=RED&userId=other&sessionId=other', developerOptions);
    expect(audits.status).toBe(200);
    expect(audits.data?.data?.entries).toHaveLength(2);
    expect(audits.data?.data?.summary.total).toBe(2);
    expect(audits.data?.data?.summary.byRisk).toEqual({ RED: 2 });
    for (const entry of audits.data!.data!.entries) {
      expect(entry).toMatchObject({ userId: DEMO_USER_ID, sessionId, confirmationRequired: true,
        confirmed: true, mfaRequired: true, mfaResult: 'success', status: 'success' });
    }
    for (const action of [first, second]) {
      expect(await database.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } })).toBe(1);
      expect((await database.mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } })).consumedAt).not.toBeNull();
    }
  });

  it('rechecks the static policy if a pending operation carries a downgraded persisted tier', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const proposed = await executeGatedTool({ sessionId, userId: DEMO_USER_ID, toolName: 'freeze_card',
      args: { cardId: 'card_credit' }, userRequest: 'Freeze the credit card' });
    const id = proposed.pendingActionId!;
    await getTestPrisma().pendingAction.update({ where: { id }, data: {
      status: 'pending', riskLevel: 'YELLOW', requiresMfa: false,
    } });
    expect((await confirm(id)).data?.data).toMatchObject({ status: 'awaiting_mfa', tier: 'RED', requiresMfa: true });
    expect(await cardStatus('card_credit')).toBe('ACTIVE');
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id } })).riskLevel).toBe('RED');
  });

  it('rolls a card change back if its required execution audit fails', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const proposed = await executeGatedTool({ sessionId, userId: DEMO_USER_ID, toolName: 'freeze_card',
      args: { cardId: 'card_credit' }, userRequest: 'Freeze the credit card' });
    const id = proposed.pendingActionId!;
    const insert = auditStore.insertAuditLog;
    const fault = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation((entry, options) => {
      if (options?.dedupeKey === `exec:${id}`) return Promise.reject(new Error('Required audit unavailable'));
      return insert(entry, options);
    });
    try {
      expect((await verify(id)).status).toBe(500);
      expect(await cardStatus('card_credit')).toBe('ACTIVE');
      expect(await getTestPrisma().executionReceipt.count({ where: { userId: DEMO_USER_ID, key: id } })).toBe(0);
      expect(await getTestPrisma().auditLog.count({ where: { dedupeKey: `exec:${id}` } })).toBe(0);
    } finally { fault.mockRestore(); }
    const recovered = await postJson<Envelope<ActionResponse>>(recoverPost,
      actionUrl(id, 'recover'), {}, { ctx: idCtx(id) });
    expect(recovered.data?.data?.status).toBe('needs_reconciliation');
    expect(await cardStatus('card_credit')).toBe('ACTIVE');
    const audits = await getJson<Envelope<AuditData>>(auditGet, '/api/audit?toolName=freeze_card&status=blocked', developerOptions);
    expect(audits.data?.data?.entries).toHaveLength(1);
    expect(audits.data?.data?.entries[0]).toMatchObject({ userId: DEMO_USER_ID, sessionId, status: 'blocked' });
  });

  it('shows cancellation audits and excludes other owners and sessions', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const proposed = await executeGatedTool({ sessionId, userId: DEMO_USER_ID, toolName: 'freeze_card',
      args: { cardId: 'card_credit' }, userRequest: 'Freeze the credit card' });
    const id = proposed.pendingActionId!;
    expect((await postJson(cancelPost, actionUrl(id, 'cancel'), {}, { ctx: idCtx(id) })).status).toBe(200);
    await getTestPrisma().user.create({ data: { id: 'other', name: 'Other owner', phone: '13900003344' } });
    await getTestPrisma().auditLog.createMany({ data: [
      { sessionId, userId: 'other', userRequest: 'Other owner', toolName: 'freeze_card', riskLevel: 'RED', status: 'success' },
      { sessionId: 'other', userId: DEMO_USER_ID, userRequest: 'Other session', toolName: 'freeze_card', riskLevel: 'RED', status: 'success' },
    ] });
    const audits = await getJson<Envelope<AuditData>>(auditGet, '/api/audit?toolName=freeze_card', developerOptions);
    expect(audits.data?.data?.entries).toHaveLength(1);
    expect(audits.data?.data?.entries[0]).toMatchObject({ userId: DEMO_USER_ID, sessionId, status: 'cancelled' });
    expect(audits.data?.data?.summary.total).toBe(1);
    expect(await cardStatus('card_credit')).toBe('ACTIVE');
  });
});

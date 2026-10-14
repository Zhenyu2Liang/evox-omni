import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as activityGet } from '@/app/api/activity/route';
import { GET as auditGet } from '@/app/api/audit/route';
import { POST as acknowledgePost } from '@/app/api/transactions/[id]/acknowledge/route';
import { getDemoSession } from '@/agent';
import { audit } from '@/audit';
import type { ActivityRecord } from '@/lib/contracts/activity';
import { DEVELOPER_MODE_COOKIE, DEVELOPER_MODE_ENABLED } from '@/lib/developer-mode/shared';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { getJson, idCtx, postJson } from './harness';

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string } }
const developerOptions = { cookie: `${DEVELOPER_MODE_COOKIE}=${DEVELOPER_MODE_ENABLED}` };
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

describe('public activity and developer audit HTTP boundaries', () => {
  it('blocks raw audit access before parsing filters or loading diagnostics', async () => {
    const load = vi.spyOn(audit, 'listAudit');
    try {
      const response = await getJson<Envelope<unknown>>(auditGet, '/api/audit?limit=bad');
      expect(response.status).toBe(403);
      expect(response.data?.error?.code).toBe('SECURITY_DENIED');
      expect(load).not.toHaveBeenCalled();
    } finally { load.mockRestore(); }
    expect((await getJson(auditGet, '/api/audit', developerOptions)).status).toBe(200);
  });

  it('returns a safe read-only domain timeline under the server-resolved owner scope', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const database = getTestPrisma();
    await database.user.create({ data: { id: 'other-activity-owner', name: 'Other owner', phone: '13900004455' } });
    await database.auditLog.createMany({ data: [
      { id: 'owned-contact', userId: DEMO_USER_ID, sessionId, toolName: 'add_contact', riskLevel: 'YELLOW',
        status: 'success', userRequest: 'Sensitive user request', toolArgs: '{"password":"secret"}',
        toolResult: '{"ok":true,"data":{"phone":"13812345678"}}', detail: 'Internal policy detail' },
      { id: 'other-owner', userId: 'other-activity-owner', sessionId, toolName: 'transfer_money',
        riskLevel: 'RED', status: 'success', userRequest: 'Foreign request' },
      { id: 'other-session', userId: DEMO_USER_ID, sessionId: 'other-conversation', toolName: 'transfer_money',
        riskLevel: 'RED', status: 'success', userRequest: 'Foreign conversation' },
    ] });
    const countBefore = await database.auditLog.count();
    const response = await getJson<Envelope<{ entries: ActivityRecord[] }>>(activityGet,
      '/api/activity?userId=other-activity-owner&sessionId=other-conversation&toolName=get_balance',
      { cookie: 'banking_session=other-conversation' });
    expect(response.status).toBe(200);
    expect(response.data?.data?.entries).toEqual([{ id: 'owned-contact', timestamp: expect.any(Number),
      type: 'contact_add', status: 'completed', verification: 'not_required' }]);
    expect(await database.auditLog.count()).toBe(countBefore);
    const serialized = JSON.stringify(response.data);
    for (const hidden of ['toolName', 'toolArgs', 'toolResult', 'detail', 'sessionId', 'userId',
      'Sensitive user request', 'secret', '13812345678', 'Internal policy detail']) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it('filters technical traffic before applying the page limit', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const database = getTestPrisma();
    const base = { userId: DEMO_USER_ID, sessionId, riskLevel: 'GREEN', status: 'success', userRequest: 'Fixture' };
    await database.auditLog.createMany({ data: [
      { ...base, id: 'earlier-business', toolName: 'manual_add_card', timestamp: new Date(1000) },
      { ...base, id: 'later-business', toolName: 'freeze_card', timestamp: new Date(2000), mfaRequired: true, mfaResult: 'success' },
      ...Array.from({ length: 120 }, (_, index) => ({ ...base, id: `diagnostic-${index}`,
        toolName: index % 2 ? 'submit_plan' : 'list_subscriptions', timestamp: new Date(3000 + index) })),
    ] });
    const response = await getJson<Envelope<{ entries: ActivityRecord[] }>>(activityGet, '/api/activity?limit=2');
    expect(response.data?.data?.entries.map(entry => entry.id)).toEqual(['later-business', 'earlier-business']);
    expect(response.data?.data?.entries[0]).toMatchObject({ type: 'card_freeze', verification: 'passed' });
    expect((await getJson(activityGet, '/api/activity?limit=501')).status).toBe(400);
    expect((await getJson(activityGet, '/api/activity?limit=-1')).status).toBe(400);
  });

  it('shows an actual transaction acknowledgement once without exposing its transaction evidence', async () => {
    const database = getTestPrisma();
    const transaction = await database.transaction.findFirstOrThrow({ where: { userId: DEMO_USER_ID } });
    const path = `/api/transactions/${transaction.id}/acknowledge`;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await postJson(acknowledgePost, path, {}, { ctx: idCtx(transaction.id) })).status).toBe(200);
    }
    const response = await getJson<Envelope<{ entries: ActivityRecord[] }>>(activityGet, '/api/activity');
    expect(response.data?.data?.entries).toEqual([{ id: expect.any(String), timestamp: expect.any(Number),
      type: 'transaction_acknowledgement', status: 'completed', verification: 'not_required' }]);
    expect(JSON.stringify(response.data)).not.toContain(transaction.id);
    expect(JSON.stringify(response.data)).not.toContain('acknowledge_transaction');
    expect(await database.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).toEqual(transaction);
  });
});

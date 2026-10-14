import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/developer/security/reset/route';
import { getDemoSession } from '@/agent/session';
import { securityEventStore } from '@/audit/security-events';
import { DEVELOPER_MODE_COOKIE } from '@/lib/developer-mode/shared';
import { security } from '@/security';
import { getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { postJson } from './harness';

const path = '/api/developer/security/reset';
const enabled = { cookie: `${DEVELOPER_MODE_COOKIE}=1` };
beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

async function lockedOwner() {
  const snapshot = await getDemoSession(DEMO_USER_ID);
  for (let attempt = 0; attempt < 3; attempt += 1) await security.circuitBreaker.recordFailure(snapshot.sessionId);
  return snapshot.sessionId;
}

describe('developer verification counter reset', () => {
  it('rejects normal mode even when a valid verification code is supplied', async () => {
    const sessionId = await lockedOwner();
    expect((await postJson(POST, path, {})).status).toBe(403);
    expect((await postJson(POST, path, { verificationCode: '123456' }, { cookie: `${DEVELOPER_MODE_COOKIE}=0` })).status).toBe(403);
    expect((await security.circuitBreaker.getState(sessionId)).locked).toBe(true);
    expect(await getTestPrisma().securityEvent.count({ where: { kind: 'SECURITY_RESET' } })).toBe(0);
  });

  it('resets without credentials, audits the developer action and does not execute banking operations', async () => {
    const sessionId = await lockedOwner();
    const db = getTestPrisma();
    await db.pendingAction.create({ data: { id: 'pending-developer-reset', userId: DEMO_USER_ID,
      sessionId, toolName: 'transfer_money', argsJson: '{}', summaryJson: '{}', riskLevel: 'RED',
      status: 'awaiting_mfa', requiresMfa: true } });
    const before = await db.transaction.count();
    const response = await postJson<{ data: { locked: boolean; failures: number } }>(POST, path, {}, enabled);
    expect(response.status).toBe(200);
    expect(response.data?.data).toMatchObject({ locked: false, failures: 0 });
    expect(await db.transaction.count()).toBe(before);
    expect((await db.pendingAction.findUniqueOrThrow({ where: { id: 'pending-developer-reset' } })).status).toBe('awaiting_mfa');
    const events = await db.securityEvent.findMany({ where: { kind: 'SECURITY_RESET' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId, userId: DEMO_USER_ID });
    expect(JSON.parse(events[0].detail!)).toMatchObject({ actor: 'developer', mode: 'developer', previousFailures: 3, wasLocked: true });
  });

  it('keeps the lock if its audit cannot commit', async () => {
    const sessionId = await lockedOwner();
    vi.spyOn(securityEventStore, 'insertSecurityEvent').mockRejectedValueOnce(new Error('Audit unavailable'));
    expect((await postJson(POST, path, {}, enabled)).status).toBe(500);
    expect((await security.circuitBreaker.getState(sessionId)).locked).toBe(true);
  });
});

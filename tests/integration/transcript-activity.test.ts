import { beforeEach, describe, expect, it } from 'vitest';
import { getDemoSession, loadSession, saveSession } from '@/agent/session';
import { readTranscriptActivity } from '@/agent/transcript-activity';
import { getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

beforeEach(resetDatabase);

describe('page-opening tool activity recovery', () => {
  it('restores old frozen progress using owned journal and action evidence without altering stored records', async () => {
    const db = getTestPrisma();
    const snapshot = await getDemoSession(DEMO_USER_ID);
    snapshot.transcript = [{ id: 'historic-message', role: 'assistant', content: '', timestamp: 1,
      toolEvents: [{ toolCallId: 'reused-call', toolName: 'list_subscriptions', status: 'started' }] }];
    await saveSession(snapshot);
    const run = await db.agentRun.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID,
      requestDigest: 'digest', requestJson: '{}', status: 'completed' } });
    const invocation = await db.toolInvocation.create({ data: { runId: run.id, ordinal: 0, callId: 'reused-call',
      toolName: 'list_subscriptions', argsJson: '{}', requestDigest: 'digest', operationKey: 'operation',
      replaySafety: 'read_only', status: 'waiting_confirmation' } });
    await db.agentRunEvent.create({ data: { runId: run.id, sequence: 0, channel: 'ui', eventType: 'message_start',
      payloadJson: JSON.stringify({ type: 'message_start', message: snapshot.transcript[0] }) } });
    const action = await db.pendingAction.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID,
      toolName: 'list_subscriptions', argsJson: '{}', riskLevel: 'YELLOW', status: 'executed', summaryJson: '{}',
      invocationId: invocation.id, resultJson: JSON.stringify({ ok: true, summary: 'Six subscriptions found' }) } });
    await db.pendingAction.create({ data: { sessionId: snapshot.sessionId, userId: 'foreign-user',
      toolName: 'list_subscriptions', argsJson: '{}', riskLevel: 'YELLOW', status: 'cancelled', summaryJson: '{}',
      invocationId: invocation.id } });
    const loaded = await loadSession(snapshot.sessionId);
    if (!loaded) throw new Error('Expected the persisted shared demo session');
    const view = await readTranscriptActivity(loaded);
    expect(view[0].toolEvents?.[0]).toMatchObject({ actionId: action.id, status: 'success', summary: 'Six subscriptions found' });
    expect((await loadSession(snapshot.sessionId))?.transcript[0].toolEvents?.[0].status).toBe('started');
    expect(await db.agentRunEvent.count()).toBe(1);
    expect(await db.transaction.count()).toBeGreaterThan(0);
    expect(await db.executionReceipt.count()).toBe(0);
  });
});

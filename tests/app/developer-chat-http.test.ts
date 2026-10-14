import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/developer/chat/route';
import { POST } from '@/app/api/developer/chat/reset/route';
import { getDemoSession, loadSession, saveSession } from '@/agent/session';
import { DEVELOPER_MODE_COOKIE } from '@/lib/developer-mode/shared';
import { getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { getJson, postJson } from './harness';
import { proposeCardChange } from '@/security/manual-card-management';
import { randomUUID } from 'node:crypto';

const enabled = { cookie: `${DEVELOPER_MODE_COOKIE}=1` };
const resetPath = '/api/developer/chat/reset';
beforeEach(resetDatabase);

describe('developer conversation controls', () => {
  it('clears model context without cancelling independent card-page proposals or their challenges', async () => {
    const snapshot = await getDemoSession(DEMO_USER_ID);
    snapshot.transcript.push({ id: 'message-before-manual-change', role: 'user', content: 'Hello', timestamp: 1 });
    await saveSession(snapshot);
    const change = await proposeCardChange({ userId: DEMO_USER_ID, sessionId: snapshot.sessionId }, {
      requestId: randomUUID(), type: 'DEBIT',
    });
    const db = getTestPrisma();
    const action = await db.pendingAction.findUniqueOrThrow({ where: { id: change.change.id } });
    const challenge = await db.mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } });
    expect((await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled)).status).toBe(200);
    expect((await loadSession(snapshot.sessionId))?.transcript).toEqual([]);
    expect(await db.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).toEqual(action);
    expect(await db.mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } })).toEqual(challenge);
  });
  it('requires developer mode and explicit reset confirmation', async () => {
    expect((await getJson(GET, '/api/developer/chat')).status).toBe(403);
    expect((await postJson(POST, resetPath, { expectedRevision: 0, confirm: true })).status).toBe(403);
    expect((await postJson(POST, resetPath, { expectedRevision: 0 }, enabled)).status).toBe(400);
  });

  it('clears only current conversation context and preserves execution evidence and financial records', async () => {
    const db = getTestPrisma();
    const snapshot = await getDemoSession(DEMO_USER_ID);
    snapshot.transcript.push({ id: 'old-message', role: 'user', content: 'Hello', timestamp: 1 });
    snapshot.agentState.messages.push({ role: 'user', content: 'Hello', timestamp: 1 });
    snapshot.intent = { id: 'old-intent', revision: 1, purpose: 'undecided', requestText: 'Hello', latestMessage: 'Hello', steps: [] };
    await saveSession(snapshot);
    const run = await db.agentRun.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID,
      requestDigest: 'digest', requestJson: '{}', status: 'completed', checkpointJson: 'saved-evidence' } });
    await db.agentRunEvent.create({ data: { runId: run.id, sequence: 0, payloadJson: '{}', eventType: 'agent_end' } });
    const balances = await db.account.findMany();
    const transactions = await db.transaction.count();
    const meta = await getJson<{ data: { revision: number } }>(GET, '/api/developer/chat', enabled);
    expect(meta.data?.data.revision).toBe(snapshot.revision);
    const result = await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled);
    expect(result.status).toBe(200);
    const cleared = await loadSession(snapshot.sessionId);
    expect(cleared?.transcript).toEqual([]);
    expect(cleared?.agentState.messages).toEqual([]);
    expect(cleared?.intent).toBeUndefined();
    expect(cleared?.revision).toBe(snapshot.revision + 1);
    expect(cleared?.historyStartedAt).toBeGreaterThanOrEqual(snapshot.historyStartedAt!);
    expect(cleared?.sessionId).toBe(snapshot.sessionId);
    expect(await db.account.findMany()).toEqual(balances);
    expect(await db.transaction.count()).toBe(transactions);
    expect(await db.agentRunEvent.count()).toBe(1);
    expect((await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })).checkpointJson).toBe('saved-evidence');
    expect((await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled)).status).toBe(409);
  });

  it.each(['pending', 'awaiting_mfa', 'confirmed', 'locked', 'needs_reconciliation'])('preserves %s operations and rolls back the reset', async status => {
    const db = getTestPrisma();
    const snapshot = await getDemoSession(DEMO_USER_ID);
    snapshot.transcript.push({ id: 'message', role: 'user', content: 'Keep this context', timestamp: 1 });
    await saveSession(snapshot);
    await db.pendingAction.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID,
      toolName: 'transfer_money', riskLevel: 'YELLOW', argsJson: '{}', summaryJson: '{}', status } });
    const result = await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled);
    expect(result.status).toBe(409);
    expect((await loadSession(snapshot.sessionId))?.revision).toBe(snapshot.revision);
    expect((await loadSession(snapshot.sessionId))?.transcript).toEqual(snapshot.transcript);
  });

  it.each(['running', 'interrupted'])('refuses to detach a %s durable run', async status => {
    const snapshot = await getDemoSession(DEMO_USER_ID);
    await getTestPrisma().agentRun.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID,
      requestDigest: 'digest', requestJson: '{}', status } });
    expect((await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled)).status).toBe(409);
    expect((await loadSession(snapshot.sessionId))?.revision).toBe(snapshot.revision);
  });

  it('cannot overwrite a concurrent turn or another browser reset with a stale revision', async () => {
    const snapshot = await getDemoSession(DEMO_USER_ID);
    const result = await Promise.all([
      postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled),
      postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled),
    ]);
    expect(result.map(row => row.status).sort()).toEqual([200, 409]);
    expect((await loadSession(snapshot.sessionId))?.revision).toBe(snapshot.revision + 1);
  });

  it.each(['pending', 'running', 'paused', 'waiting_confirmation'])('keeps a %s workflow attached to its context', async status => {
    const snapshot = await getDemoSession(DEMO_USER_ID);
    await getTestPrisma().agentTask.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID, goal: 'Keep context', status } });
    expect((await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled)).status).toBe(409);
    expect((await loadSession(snapshot.sessionId))?.revision).toBe(snapshot.revision);
  });

  it('does not detach an active session lease or an open manual review', async () => {
    const db = getTestPrisma();
    const snapshot = await getDemoSession(DEMO_USER_ID);
    await db.agentSession.update({ where: { id: snapshot.sessionId }, data: { activeRunId: 'active-run' } });
    expect((await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled)).status).toBe(409);
    await db.agentSession.update({ where: { id: snapshot.sessionId }, data: { activeRunId: null } });
    await db.manualReview.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID, title: 'Check outcome',
      reason: 'Unknown result', operatorId: 'operator', operatorName: 'Operator', status: 'open' } });
    expect((await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled)).status).toBe(409);
    expect((await loadSession(snapshot.sessionId))?.revision).toBe(snapshot.revision);
  });

  it('keeps unknown tool outcomes even when their owning run already failed', async () => {
    const db = getTestPrisma();
    const snapshot = await getDemoSession(DEMO_USER_ID);
    const run = await db.agentRun.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID,
      requestDigest: 'digest', requestJson: '{}', status: 'failed' } });
    await db.toolInvocation.create({ data: { runId: run.id, ordinal: 0, callId: 'unknown-call', toolName: 'transfer_money',
      argsJson: '{}', requestDigest: 'digest', operationKey: 'operation', replaySafety: 'reconcile_only', status: 'needs_reconciliation' } });
    expect((await postJson(POST, resetPath, { expectedRevision: snapshot.revision, confirm: true }, enabled)).status).toBe(409);
    expect((await loadSession(snapshot.sessionId))?.revision).toBe(snapshot.revision);
  });
});

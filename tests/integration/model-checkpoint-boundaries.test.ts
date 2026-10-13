import { describe, expect, it } from 'vitest';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { getOrCreateSession } from '@/agent/session';
import { beginRun } from '@/agent/durable';
import { encodeCheckpoint } from '@/agent/durable/checkpoint';
import { runtimeRequestDigest } from '@/agent/durable/serialization';
import { assertAgentRunLease, beginAgentRun, completeModelRequest, commitRunSession, startModelRequest, stopObsoleteRun,
  finishAgentRun, listRecoverableAgentRuns, scheduleRunRecovery } from '@/lib/db/repositories/agentRun';
import type { AppConfig } from '@/lib/config';
import type { AgentRunLease } from '@/lib/contracts/runtime';

useFreshDatabase();
const config: AppConfig = { llmMode: 'mock', llmProvider: 'checkpoint-test', llmModel: 'checkpoint-model', demoUserId: 'user_liming' };
const inputJson = JSON.stringify({ messages: [{ role: 'user', content: 'Read my balance.', timestamp: 1 }] });
const digest = runtimeRequestDigest('model_request', JSON.parse(inputJson));

async function admitted() {
  const snapshot = await getOrCreateSession(config.demoUserId);
  const checkpointJson = encodeCheckpoint(snapshot, config);
  const admission = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId, requestId: 'checkpoint-request',
    request: { kind: 'input', message: 'Read my balance.' }, expectedRevision: snapshot.revision, checkpointJson });
  return { snapshot, admission, checkpointJson, lease: admission.lease! };
}

async function reclaim(lease: AgentRunLease) {
  const db = getTestPrisma();
  await db.agentRun.update({ where: { id: lease.runId }, data: { leaseExpiresAt: new Date(1) } });
  await db.agentSession.update({ where: { id: lease.sessionId }, data: { runLeaseExpiresAt: new Date(1) } });
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: lease.runId } });
  const admitted = await beginAgentRun({ sessionId: run.sessionId, userId: run.userId, existingRunId: run.id,
    recover: true, requestJson: run.requestJson, requestDigest: run.requestDigest });
  return admitted.lease!;
}

describe('model intent, result and conversation commit transactions', () => {
  it('stores admission state even when the process dies before runtime construction', async () => {
    const { admission, checkpointJson } = await admitted();
    expect(admission.run.checkpointJson).toBe(checkpointJson);
    expect(admission.run.checkpointStage).toBe('input');
    expect(await getTestPrisma().modelRequest.count()).toBe(0);
  });

  it('retries exactly the original unfinished intent with bounded model and recovery attempts', async () => {
    let { lease, checkpointJson } = await admitted();
    const first = await startModelRequest(lease, digest, inputJson, checkpointJson);
    for (const attempt of [2, 3]) {
      lease = await reclaim(lease);
      const next = await startModelRequest(lease, digest, inputJson, checkpointJson);
      expect(next).toMatchObject({ id: first.id, ordinal: 1, attempt });
    }
    lease = await reclaim(lease);
    await expect(startModelRequest(lease, digest, inputJson, checkpointJson)).rejects.toThrow('retry limit');
    expect(await getTestPrisma().modelRequest.count()).toBe(1);
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).recoveryAttempts).toBe(3);
  });

  it('refuses changed arguments for an interrupted model intent and permanently failed model requests', async () => {
    const { lease, checkpointJson } = await admitted();
    const model = await startModelRequest(lease, digest, inputJson, checkpointJson);
    await expect(startModelRequest(lease, 'different-input', inputJson, checkpointJson)).rejects.toThrow('cannot be replaced');
    await completeModelRequest(lease, model.id, '{}', checkpointJson, 'MODEL_PERMANENT');
    await expect(startModelRequest(lease, digest, inputJson, checkpointJson)).rejects.toThrow('permanent');
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).checkpointStage).toBe('model_intent');
  });

  it('atomically fences the old writer and commits only the replacement revision', async () => {
    const { lease, snapshot, checkpointJson } = await admitted();
    const replacement = await reclaim(lease);
    await expect(commitRunSession(lease, snapshot.revision, '{}', null, checkpointJson)).rejects.toThrow('lease');
    const revision = await commitRunSession(replacement, snapshot.revision, '{}', null, checkpointJson);
    expect(revision).toBe(snapshot.revision + 1);
    const stored = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: lease.runId } });
    expect(stored.baseRevision).toBe(revision);
    expect(JSON.parse(stored.checkpointJson!).snapshot.revision).toBe(revision);
    await assertAgentRunLease(replacement, getTestPrisma());
  });

  it('stops an obsolete checkpoint and fences effects when a newer conversation revision exists', async () => {
    const { lease } = await admitted();
    await getTestPrisma().agentSession.update({ where: { id: lease.sessionId }, data: { revision: { increment: 1 } } });
    await expect(assertAgentRunLease(lease, getTestPrisma())).rejects.toThrow('lease');
    expect(await stopObsoleteRun(lease.runId)).toBe(true);
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).status).toBe('failed');
  });

  it('persists transient backoff across discovery and excludes permanent model failures', async () => {
    const { lease, checkpointJson } = await admitted();
    const request = await startModelRequest(lease, digest, inputJson, checkpointJson);
    await completeModelRequest(lease, request.id, '{}', checkpointJson, 'MODEL_TRANSIENT');
    await finishAgentRun(lease, 'failed', 'MODEL_TRANSIENT');
    await scheduleRunRecovery(lease.runId, 'MODEL_TRANSIENT', true);
    const stored = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: lease.runId } });
    expect(stored.status).toBe('interrupted');
    expect(stored.nextRecoveryAt).not.toBeNull();
    expect(await listRecoverableAgentRuns(new Date(stored.nextRecoveryAt!.getTime() - 1))).toEqual([]);
    expect((await listRecoverableAgentRuns(stored.nextRecoveryAt!)).map(run => run.id)).toEqual([lease.runId]);
    await scheduleRunRecovery(lease.runId, 'MODEL_PERMANENT', false);
    expect(await listRecoverableAgentRuns(new Date('2099-01-01T00:00:00Z'))).toEqual([]);
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).status).toBe('failed');
  });

  it('stops discovery after the persisted recovery admission cap even after the host restarts', async () => {
    let { lease } = await admitted();
    for (const attempt of [1, 2, 3]) {
      lease = await reclaim(lease);
      expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: lease.runId } })).recoveryAttempts).toBe(attempt);
    }
    await finishAgentRun(lease, 'interrupted');
    expect(await listRecoverableAgentRuns(new Date('2099-01-01T00:00:00Z'))).toEqual([]);
    const run = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: lease.runId } });
    await expect(beginAgentRun({ sessionId: run.sessionId, userId: run.userId, existingRunId: run.id,
      recover: true, requestJson: run.requestJson, requestDigest: run.requestDigest })).rejects.toThrow('exhausted');
  });
});

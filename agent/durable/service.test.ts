import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AgentRun, ToolInvocation } from '@prisma/client';
import { AppError } from '@/lib/errors';

const mocks = vi.hoisted(() => ({
  getAgentRun: vi.fn(), listRunInvocations: vi.fn(), beginAgentRun: vi.fn(), finalizeReceiptedAgentRun: vi.fn(), restoreInvocationFromReceipt: vi.fn(), finishAgentRun: vi.fn(), renewAgentRunLease: vi.fn(), assertAgentRunLease: vi.fn(),
  synchronizeRunActionInvocations: vi.fn(),
  runPendingActionWhere: vi.fn(),
  readCommandReceipt: vi.fn(), executeDirect: vi.fn(), recoverInvocation: vi.fn(), getSession: vi.fn(),
  pendingFindFirst: vi.fn(), pendingFindMany: vi.fn(),
}));
vi.mock('@/lib/db/repositories/agentRun', () => mocks);
vi.mock('@/lib/db/client', () => ({ prisma: { pendingAction: { findFirst: mocks.pendingFindFirst, findMany: mocks.pendingFindMany } } }));
vi.mock('@/lib/db/repositories/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/agent/command-execution', () => ({ readCommandReceipt: mocks.readCommandReceipt }));
vi.mock('@/agent/tools', () => ({ TOOL_NAMES: ['get_balance', 'list_subscriptions', 'transfer_money', 'submit_plan'], createToolRegistry: () => ({ executeDirect: mocks.executeDirect }) }));
vi.mock('./recovery', () => ({ recoverInvocation: mocks.recoverInvocation }));
import { getOwnedRunSummary, recoverOwnedRun } from './service';
import { GET } from '@/app/api/runs/[id]/route';
import { POST } from '@/app/api/runs/[id]/recover/route';

const now = new Date('2026-10-13T00:00:00Z');
const owner = { sessionId: 'session-1', userId: 'user-1' };
function run(status = 'interrupted'): AgentRun {
  return { id: 'run-1', ...owner, requestId: 'request-1', requestDigest: 'original-digest', requestJson: '{"thinking":"private reasoning","password":"private credential"}', status, nextSequence: 17, nextOrdinal: 1, leaseToken: null, leaseExpiresAt: null, startedAt: now, finishedAt: null, errorCode: null };
}
function invocation(status = 'interrupted', toolName = 'get_balance'): ToolInvocation {
  return { id: 'invocation-1', runId: 'run-1', ordinal: 1, callId: 'provider-1', toolName, argsJson: '{}', requestDigest: 'digest', operationKey: 'inv:invocation-1', replaySafety: toolName === 'get_balance' ? 'read_only' : 'reconcile_only', status, resultJson: null, errorCode: null, attempt: 1, maxAttempts: 3, startedAt: now, finishedAt: null };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAgentRun.mockResolvedValue(run());
  mocks.listRunInvocations.mockResolvedValue([invocation()]);
  mocks.getSession.mockImplementation(async (id: string) => ({ id, userId: owner.userId }));
  mocks.pendingFindFirst.mockResolvedValue(null);
  mocks.pendingFindMany.mockResolvedValue([]);
  mocks.beginAgentRun.mockResolvedValue({ run: run('running'), lease: { runId: 'run-1', ...owner, token: 'new-lease' }, reused: true });
});

describe('owned runtime recovery service and HTTP boundary', () => {
  it('returns only safe run and invocation metadata', async () => {
    const summary = await getOwnedRunSummary('run-1', owner);
    expect(summary).toMatchObject({ id: 'run-1', lastSequence: 17, invocations: [{ id: 'invocation-1', toolName: 'get_balance' }] });
    expect(JSON.stringify(summary)).not.toMatch(/private reasoning|private credential|requestJson|argsJson|leaseToken/);
  });

  it('enforces both user and session ownership', async () => {
    await expect(getOwnedRunSummary('run-1', { ...owner, sessionId: 'other-session' })).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    await expect(recoverOwnedRun('run-1', { ...owner, userId: 'other-user' })).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    expect(mocks.beginAgentRun).not.toHaveBeenCalled();
  });

  it('keeps original confirmation waiting without granting or retrying it', async () => {
    mocks.getAgentRun.mockResolvedValue(run('waiting_confirmation'));
    mocks.listRunInvocations.mockResolvedValue([invocation('waiting_confirmation', 'transfer_money')]);
    const response = await recoverOwnedRun('run-1', owner);
    expect(response.outcomes).toEqual([{ invocationId: 'invocation-1', action: 'waiting', reason: 'AUTHORIZATION_REQUIRED' }]);
    expect(mocks.beginAgentRun).not.toHaveBeenCalled();
    expect(mocks.recoverInvocation).not.toHaveBeenCalled();
    expect(mocks.executeDirect).not.toHaveBeenCalled();
  });

  it('reuses the original run identity and request digest for an explicit read retry', async () => {
    const record = invocation();
    mocks.listRunInvocations.mockImplementation(async () => [record]);
    mocks.executeDirect.mockResolvedValue({ ok: true, data: { totalAvailable: '100.00' }, summary: 'Balance read' });
    mocks.recoverInvocation.mockImplementation(async (_lease, id: string, port: { execute: (value: ToolInvocation) => Promise<string> }) => {
      const resultJson = await port.execute(record);
      record.status = 'completed';
      record.resultJson = resultJson;
      return { invocationId: id, action: 'retried', resultJson };
    });
    const response = await recoverOwnedRun('run-1', owner);
    expect(response.outcomes).toEqual([{ invocationId: 'invocation-1', action: 'retried' }]);
    expect(mocks.beginAgentRun).toHaveBeenCalledWith(expect.objectContaining({ existingRunId: 'run-1', requestId: 'request-1', requestDigest: 'original-digest', recover: true }));
    expect(mocks.executeDirect).toHaveBeenCalledWith('get_balance', {});
    expect(mocks.finishAgentRun).toHaveBeenCalledWith(expect.anything(), 'completed', undefined);
  });

  it('requires the original authorization for a gated read interrupted before its security check', async () => {
    const record = { ...invocation('interrupted', 'list_subscriptions'), replaySafety: 'read_only' };
    mocks.listRunInvocations.mockResolvedValue([record]);
    const response = await recoverOwnedRun('run-1', owner);
    expect(response.outcomes).toEqual([{ invocationId: record.id, action: 'waiting', reason: 'AUTHORIZATION_REQUIRED' }]);
    expect(mocks.recoverInvocation).not.toHaveBeenCalled();
    expect(mocks.executeDirect).not.toHaveBeenCalled();
    expect(mocks.finishAgentRun).toHaveBeenCalledWith(expect.anything(), 'waiting_confirmation', undefined);
  });

  it('returns a persisted cancellation without granting another execution lease', async () => {
    mocks.getAgentRun.mockResolvedValue(run('waiting_confirmation'));
    mocks.synchronizeRunActionInvocations.mockImplementation(async () => {
      mocks.listRunInvocations.mockResolvedValue([invocation('cancelled', 'transfer_money')]);
    });
    mocks.finalizeReceiptedAgentRun.mockImplementation(async () => {
      mocks.getAgentRun.mockResolvedValue({ ...run('failed'), errorCode: 'CANCELLED' });
    });
    const response = await recoverOwnedRun('run-1', owner);
    expect(response.run).toMatchObject({ status: 'failed', errorCode: 'CANCELLED' });
    expect(response.outcomes).toEqual([{ invocationId: 'invocation-1', action: 'stopped', reason: 'CANCELLED' }]);
    expect(mocks.beginAgentRun).not.toHaveBeenCalled();
    expect(mocks.executeDirect).not.toHaveBeenCalled();
  });

  it('releases the lease when a recovery executor attempts to send a write', async () => {
    const record = invocation('interrupted', 'transfer_money');
    mocks.listRunInvocations.mockResolvedValue([record]);
    mocks.recoverInvocation.mockImplementation(async (_lease, _id, port: { execute: (value: ToolInvocation) => Promise<string> }) => port.execute(record));
    await expect(recoverOwnedRun('run-1', owner)).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    expect(mocks.executeDirect).not.toHaveBeenCalled();
    expect(mocks.finishAgentRun).toHaveBeenCalledWith(expect.anything(), 'failed', 'SECURITY_DENIED');
  });

  it('rejects missing cookies and foreign sessions on the HTTP routes', async () => {
    const context = { params: Promise.resolve({ id: 'run-1' }) };
    const missing = await GET(new NextRequest('http://localhost/api/runs/run-1'), context);
    expect(missing.status).toBe(403);
    const foreign = await POST(new NextRequest('http://localhost/api/runs/run-1/recover?sessionId=session-1', { method: 'POST', headers: { cookie: 'banking_session=other-session' }, body: '{}' }), context);
    expect(foreign.status).toBe(403);
    expect(mocks.beginAgentRun).not.toHaveBeenCalled();
  });

  it('rejects request-supplied identity or financial arguments on the recovery endpoint', async () => {
    const response = await POST(new NextRequest('http://localhost/api/runs/run-1/recover', { method: 'POST', headers: { cookie: 'banking_session=session-1' }, body: '{"userId":"other-user","args":{"amount":"999.00"}}' }), { params: Promise.resolve({ id: 'run-1' }) });
    expect(response.status).toBe(400);
    expect(mocks.beginAgentRun).not.toHaveBeenCalled();
  });

  it('does not leak internal exceptions from the metadata endpoint', async () => {
    mocks.getAgentRun.mockRejectedValue(new Error('private database detail'));
    const response = await GET(new NextRequest('http://localhost/api/runs/run-1', { headers: { cookie: 'banking_session=session-1' } }), { params: Promise.resolve({ id: 'run-1' }) });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private database detail');
    expect(AppError.from(new Error('failure')).code).toBe('INTERNAL');
  });
});

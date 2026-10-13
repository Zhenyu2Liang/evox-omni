import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({ getAgentRunForUser: vi.fn(), listPresentationEvents: vi.fn(), listRecoverableAgentRuns: vi.fn(), listRunInvocations: vi.fn(), verifyAgentRunLease: vi.fn(), claimInvocationRetry: vi.fn(), restoreInvocationFromReceipt: vi.fn(), settleRecoveredInvocation: vi.fn() }));
vi.mock('@/lib/db/repositories/agentRun', () => repository);
import { inspectRunRecovery, readRunPresentation, recoverInvocation, wakeRecoverableRuns } from './recovery';

beforeEach(() => vi.resetAllMocks());

describe('runtime recovery interfaces', () => {
  it('provides a grounded cursor without returning raw reasoning', async () => {
    repository.listPresentationEvents.mockResolvedValue([
      { id: 'event-1', runId: 'run-1', sequence: 5, channel: 'ui', eventType: 'text_delta', payloadJson: '{"type":"text_delta","delta":"Grounded"}', createdAt: new Date('2026-10-13T00:00:00Z') },
      { id: 'event-2', runId: 'run-1', sequence: 9, channel: 'ui', eventType: 'message_end', payloadJson: '{}', createdAt: new Date('2026-10-13T00:00:01Z') },
    ]);
    const page = await readRunPresentation('run-1', 'owner-1', 0, 1);
    expect(page).toMatchObject({ events: [{ sequence: 5, channel: 'ui', payload: { delta: 'Grounded' } }], nextSequence: 5, hasMore: true });
    expect(repository.listPresentationEvents).toHaveBeenCalledWith('run-1', 'owner-1', 0, 2);
  });

  it('rejects cursor manipulation before performing a read', async () => {
    await expect(readRunPresentation('run-1', 'owner-1', -1)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(readRunPresentation('run-1', 'owner-1', 0, 501)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(repository.listPresentationEvents).not.toHaveBeenCalled();
  });

  it('requires ownership before inspecting recovery decisions', async () => {
    repository.getAgentRunForUser.mockResolvedValue(null);
    await expect(inspectRunRecovery('private-run', 'other-user')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repository.listRunInvocations).not.toHaveBeenCalled();
  });

  it('discovers work without retrying or authorizing any invocation', async () => {
    repository.listRecoverableAgentRuns.mockResolvedValue([{ id: 'run-1' }, { id: 'run-2' }]);
    const wake = vi.fn(async (_runId: string) => undefined);
    expect(await wakeRecoverableRuns(wake)).toBe(2);
    expect(wake.mock.calls.map(call => call[0])).toEqual(['run-1', 'run-2']);
    expect(repository.listRunInvocations).not.toHaveBeenCalled();
  });

  it('restores a committed write before considering retry policy or execution', async () => {
    repository.listRunInvocations.mockResolvedValue([{ id: 'invocation-1', toolName: 'transfer_money', operationKey: 'inv:invocation-1', status: 'needs_reconciliation', replaySafety: 'reconcile_only', attempt: 1, maxAttempts: 1 }]);
    const execute = vi.fn();
    const readVerifiedReceipt = vi.fn(async () => '{"transactionId":"committed-1"}');
    const result = await recoverInvocation({ runId: 'run-1', sessionId: 'session-1', userId: 'owner-1', token: 'lease-1' }, 'invocation-1', { execute, readVerifiedReceipt });
    expect(result).toMatchObject({ action: 'recovered', resultJson: '{"transactionId":"committed-1"}' });
    expect(execute).not.toHaveBeenCalled();
    expect(repository.claimInvocationRetry).not.toHaveBeenCalled();
    expect(repository.restoreInvocationFromReceipt).toHaveBeenCalledWith({ invocationId: 'invocation-1', userId: 'owner-1', toolName: 'transfer_money', operationKey: 'inv:invocation-1', resultJson: '{"transactionId":"committed-1"}' });
  });

  it('does not execute an interrupted unsafe command without a receipt', async () => {
    repository.listRunInvocations.mockResolvedValue([{ id: 'invocation-1', toolName: 'transfer_money', operationKey: 'inv:invocation-1', status: 'needs_reconciliation', replaySafety: 'reconcile_only', attempt: 1, maxAttempts: 1 }]);
    const execute = vi.fn();
    const result = await recoverInvocation({ runId: 'run-1', sessionId: 'session-1', userId: 'owner-1', token: 'lease-1' }, 'invocation-1', { execute, readVerifiedReceipt: async () => undefined }, { receiptBackedTools: new Set(['transfer_money']) });
    expect(result.action).toBe('reconciliation_required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('claims the same invocation before a read retry and saves its exact result', async () => {
    const invocation = { id: 'invocation-1', toolName: 'get_balance', operationKey: 'inv:invocation-1', status: 'interrupted', replaySafety: 'read_only', attempt: 1, maxAttempts: 3 };
    repository.listRunInvocations.mockResolvedValue([invocation]);
    repository.claimInvocationRetry.mockResolvedValue({ ...invocation, attempt: 2, status: 'started' });
    const execute = vi.fn(async () => '{"balance":"0.20"}');
    const result = await recoverInvocation({ runId: 'run-1', sessionId: 'session-1', userId: 'owner-1', token: 'lease-1' }, 'invocation-1', { execute, readVerifiedReceipt: async () => undefined });
    expect(result).toEqual({ action: 'retried', invocationId: 'invocation-1', resultJson: '{"balance":"0.20"}' });
    expect(repository.claimInvocationRetry.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
    expect(repository.settleRecoveredInvocation).toHaveBeenCalledWith(expect.anything(), 'invocation-1', 2, 'completed', '{"balance":"0.20"}', undefined);
  });

  it('treats a supposedly successful write without a committed receipt as unknown', async () => {
    const invocation = { id: 'invocation-1', toolName: 'transfer_money', operationKey: 'inv:invocation-1', status: 'interrupted', replaySafety: 'idempotent', attempt: 1, maxAttempts: 3 };
    repository.listRunInvocations.mockResolvedValue([invocation]);
    repository.claimInvocationRetry.mockResolvedValue({ ...invocation, attempt: 2, status: 'started' });
    const result = await recoverInvocation({ runId: 'run-1', sessionId: 'session-1', userId: 'owner-1', token: 'lease-1' }, 'invocation-1', { execute: async () => '{"ok":true}', readVerifiedReceipt: async () => undefined }, { receiptBackedTools: new Set(['transfer_money']) });
    expect(result).toMatchObject({ action: 'reconciliation_required', reason: 'COMMITTED_RECEIPT_MISSING' });
    expect(repository.settleRecoveredInvocation).toHaveBeenCalledWith(expect.anything(), 'invocation-1', 2, 'needs_reconciliation', undefined, 'COMMITTED_RECEIPT_MISSING');
  });
});

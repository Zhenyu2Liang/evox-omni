import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@prisma/client';
import type { ResumeTurnInput } from '../turns/contracts';

const storage = vi.hoisted(() => ({ action: vi.fn(), invocation: vi.fn(), model: vi.fn(), receipt: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { pendingAction: { findFirst: storage.action }, toolInvocation: { findUnique: storage.invocation }, modelRequest: { findFirst: storage.model } } }));
vi.mock('../command-execution', () => ({ readCommandReceipt: storage.receipt }));
import { verifiedAuthorizationInput } from './authorized-checkpoint';

const run = { id: 'narration-run', sessionId: 'session', userId: 'user' } as AgentRun;
const result = { ok: true, data: { amount: '200.00', sourceAccountId: 'checking' } };
const input: ResumeTurnInput = { sessionId: 'session', actionId: 'action', toolName: 'transfer_money',
  resultToolName: 'transfer_money', sourceAccountId: 'checking', toolResult: result };

beforeEach(() => {
  vi.resetAllMocks();
  storage.action.mockResolvedValue({ id: 'action', sessionId: 'session', userId: 'user', toolName: 'transfer_money', status: 'executed',
    taskId: null, nodeId: null, invocationId: 'original-invocation', argsJson: JSON.stringify({ sourceAccountId: 'checking', amount: '200.00' }), resultJson: JSON.stringify(result) });
  storage.invocation.mockResolvedValue({ id: 'original-invocation', origin: 'pi', callId: 'original-call', toolName: 'transfer_money',
    run: { id: 'source-run', sessionId: 'session', userId: 'user' } });
  storage.model.mockResolvedValue(null);
  storage.receipt.mockResolvedValue(result);
});

describe('authorized narration checkpoint evidence', () => {
  it('resolves the provider call from the original owned action and verifies the command receipt', async () => {
    expect(await verifiedAuthorizationInput(run, input)).toMatchObject({ toolCallId: 'original-call', actionId: 'action' });
    expect(storage.receipt).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user', operationKey: 'action', args: { sourceAccountId: 'checking', amount: '200.00' } }));
  });

  it.each([
    { toolCallId: 'another-call' }, { taskId: 'another-task' }, { nodeId: 'another-node' },
    { sourceAccountId: 'another-account' }, { toolName: 'submit_plan' as const },
  ])('refuses another call, node or account even when the result data is correct: %j', async change => {
    await expect(verifiedAuthorizationInput(run, { ...input, ...change })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(storage.receipt).not.toHaveBeenCalled();
  });

  it('requires the saved model context to answer the original authorized provider call', async () => {
    storage.model.mockResolvedValue({ inputJson: JSON.stringify({ messages: [{ role: 'toolResult', toolCallId: 'another-call', toolName: 'transfer_money', details: result.data }] }) });
    await expect(verifiedAuthorizationInput(run, input)).rejects.toThrow('original authorized call result');
  });

  it('rejects a missing committed receipt without rendering a model supplied success', async () => {
    storage.receipt.mockResolvedValue(undefined);
    await expect(verifiedAuthorizationInput(run, input)).rejects.toThrow('original execution evidence');
  });
});

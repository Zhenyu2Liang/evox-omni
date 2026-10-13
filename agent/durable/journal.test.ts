import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type { ToolInvocation } from '@prisma/client';

const storage = vi.hoisted(() => ({
  appendRuntimeEvent: vi.fn(), beginAgentRun: vi.fn(), finishAgentRun: vi.fn(),
  finishInvocationWithEvent: vi.fn(), renewAgentRunLease: vi.fn(), startInvocationWithEvent: vi.fn(),
  updateInvocationAuthorization: vi.fn(),
}));
vi.mock('@/lib/db/repositories/agentRun', () => storage);
import { AgentRunJournal } from './journal';

const lease = { runId: 'run-1', sessionId: 'session-1', userId: 'user-1', token: 'lease-1' };
function invocation(id: string, callId: string): ToolInvocation {
  return { id, runId: lease.runId, ordinal: 1, callId, toolName: 'get_balance', argsJson: '{}', requestDigest: 'digest', operationKey: `inv:${id}`, replaySafety: 'read_only', status: 'started', resultJson: null, errorCode: null, attempt: 1, maxAttempts: 3, startedAt: new Date(), finishedAt: null };
}

beforeEach(() => {
  vi.resetAllMocks();
  storage.appendRuntimeEvent.mockResolvedValue({});
  storage.finishAgentRun.mockResolvedValue({});
  storage.finishInvocationWithEvent.mockResolvedValue({});
  storage.startInvocationWithEvent.mockImplementation(async (_lease, input: { id: string; callId: string }) => ({ invocation: invocation(input.id, input.callId), event: {} }));
});

describe('persist-first agent journal', () => {
  it('snapshots every event immediately and keeps writes in producer order', async () => {
    let release!: () => void;
    storage.appendRuntimeEvent.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}); }));
    const journal = new AgentRunJournal(lease);
    const payload = { text: 'original' };
    const first = journal.recordEvent('message_update', payload);
    payload.text = 'changed';
    const second = journal.recordEvent('message_update', { text: 'next' });
    await Promise.resolve();
    expect(storage.appendRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(storage.appendRuntimeEvent.mock.calls[0][1].payloadJson).toContain('original');
    release();
    await Promise.all([first, second]);
    expect(storage.appendRuntimeEvent.mock.calls.map(call => JSON.parse(call[1].payloadJson).text)).toEqual(['original', 'next']);
  });

  it('creates new identities when a provider repeats its call ID in another round', async () => {
    const journal = new AgentRunJournal(lease);
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'reused', toolName: 'get_balance', args: {} });
    const first = journal.invocationForCall('reused')!;
    await journal.recordAgentEvent({ type: 'tool_execution_end', toolCallId: 'reused', toolName: 'get_balance', result: { content: [], details: {} }, isError: false });
    expect(JSON.parse(storage.finishInvocationWithEvent.mock.calls[0][1].resultJson)).toEqual({ ok: true, data: {} });
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'reused', toolName: 'get_balance', args: {} });
    const second = journal.invocationForCall('reused')!;
    expect(first.id).not.toBe(second.id);
    expect(first.operationKey).not.toBe(second.operationKey);
  });

  it('stops a real Pi tool before preflight when its start transaction fails', async () => {
    storage.startInvocationWithEvent.mockRejectedValue(new Error('Event storage unavailable'));
    const provider = fauxProvider();
    const models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses([fauxAssistantMessage([fauxToolCall('get_balance', {})], { stopReason: 'toolUse' })]);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const beforeToolCall = vi.fn();
    const agent = new Agent({ streamFn: models.streamSimple.bind(models), initialState: { model: provider.getModel(), tools: [{ name: 'get_balance', label: 'Balance', description: 'Read balance', parameters: Type.Object({}), execute }] }, beforeToolCall });
    const journal = new AgentRunJournal(lease);
    journal.subscribe(agent);
    await expect(agent.prompt('Read balance')).rejects.toThrow('Event storage unavailable');
    expect(beforeToolCall).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await expect(journal.finish('failed')).rejects.toThrow('Event storage unavailable');
    expect(storage.finishAgentRun).toHaveBeenCalledWith(lease, 'failed', 'EVENT_PERSISTENCE_FAILED');
  });

  it('records raw messages before a later listener grounds them', async () => {
    const provider = fauxProvider();
    const models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses([fauxAssistantMessage('Original model text')]);
    const agent = new Agent({ streamFn: models.streamSimple.bind(models), initialState: { model: provider.getModel(), tools: [] } });
    const journal = new AgentRunJournal(lease);
    journal.subscribe(agent);
    agent.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant') event.message.content = [{ type: 'text', text: 'Grounded text' }];
    });
    await agent.prompt('Reply');
    const stored = storage.appendRuntimeEvent.mock.calls.map(call => call[1] as { eventType: string; payloadJson: string });
    expect(stored.find(event => event.eventType === 'message_end' && event.payloadJson.includes('assistant'))?.payloadJson).toContain('Original model text');
    expect(stored.some(event => event.eventType === 'message_update')).toBe(true);
    expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ type: 'text', text: 'Grounded text' }] });
  });
});

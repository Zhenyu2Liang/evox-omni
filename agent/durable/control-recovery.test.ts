import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentRun, ToolInvocation } from '@/lib/db/prisma';
import type { AppConfig } from '@/lib/config';
import type { SessionSnapshot } from '@/agent/session';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
import { encodeCheckpoint, decodeCheckpoint } from './checkpoint';
import { runtimeRequestDigest } from './serialization';
import type { AgentRunJournal } from './journal';

const mocks = vi.hoisted(() => ({ model: vi.fn(), save: vi.fn(), lease: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { modelRequest: { findFirst: mocks.model } } }));
vi.mock('@/lib/db/repositories/agentRun', () => ({ saveRunCheckpoint: mocks.save }));
import { recoverTurnIntentControl } from './control-recovery';

const config = { llmMode: 'mock', llmProvider: 'mock', llmModel: 'mock' } as AppConfig;
const args = { purpose: 'operation', operations: ['transfer_money'] };
const original = advanceConversationIntent(undefined, 'Propose a transfer for my approval.', { id: 'original-intent' });
function fixture(saved = false) {
  const snapshot = { sessionId: 'session', userId: 'user', revision: 0, transcript: [],
    agentState: { messages: [] }, intent: saved ? declareConversationIntent(original, 'operation', ['transfer_money']) : original } as unknown as SessionSnapshot;
  const run = { id: 'run', sessionId: 'session', userId: 'user', baseRevision: 0,
    checkpointJson: encodeCheckpoint(snapshot, config), checkpointStage: 'model_result' } as AgentRun;
  const invocation = { id: 'invocation', runId: 'run', modelRequestId: 'model', origin: 'pi', callId: 'call',
    toolName: 'describe_turn', argsJson: JSON.stringify(args), requestDigest: runtimeRequestDigest('describe_turn', args) } as ToolInvocation;
  const journal = { lease: { runId: 'run', sessionId: 'session', userId: 'user', token: 'lease' },
    assertLeaseOwned: mocks.lease } as unknown as AgentRunJournal;
  mocks.model.mockResolvedValue({ inputJson: JSON.stringify({ requestIntent: original }),
    resultJson: JSON.stringify(fauxAssistantMessage([fauxToolCall('describe_turn', args, { id: 'call' })], { stopReason: 'toolUse' })) });
  return { run, invocation, journal };
}
beforeEach(() => vi.resetAllMocks());

describe('internal interpretation recovery boundary', () => {
  it.each([false, true])('replays the same scope and persists it before returning the result, already saved=%s', async saved => {
    const { run, invocation, journal } = fixture(saved);
    const result = JSON.parse(await recoverTurnIntentControl(invocation, run, journal, config));
    expect(result).toMatchObject({ ok: true, data: { intentId: original.id, purpose: 'operation', operations: ['transfer_money'] } });
    expect(mocks.model).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'model', runId: 'run', run: { userId: 'user', sessionId: 'session' }, status: 'completed' } }));
    expect(mocks.save).toHaveBeenCalledWith(journal.lease, 'turn_intent', run.checkpointJson);
    expect(decodeCheckpoint(run.checkpointJson!, config).snapshot.intent).toMatchObject({ id: original.id, purpose: 'operation' });
    expect(run.checkpointStage).toBe('turn_intent');
    expect(decodeCheckpoint(run.checkpointJson!, config).snapshot.agentState.messages).toEqual([]);
  });

  it('rejects a forged invocation digest before saving interpretation', async () => {
    const { run, invocation, journal } = fixture(); invocation.requestDigest = 'forged';
    await expect(recoverTurnIntentControl(invocation, run, journal, config)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rejects a newer checkpoint turn even with identical user text', async () => {
    const { run, invocation, journal } = fixture();
    const checkpoint = decodeCheckpoint(run.checkpointJson!, config);
    checkpoint.snapshot.intent = { ...original, id: 'newer-turn' };
    run.checkpointJson = encodeCheckpoint(checkpoint.snapshot, config);
    await expect(recoverTurnIntentControl(invocation, run, journal, config)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('uses the actual control schema instead of accepting arbitrary recorded purpose', async () => {
    const { run, invocation, journal } = fixture();
    mocks.model.mockResolvedValue({ inputJson: JSON.stringify({ requestIntent: original }),
      resultJson: JSON.stringify(fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'admin', operations: [] }, { id: 'call' })])) });
    await expect(recoverTurnIntentControl(invocation, run, journal, config)).rejects.toThrow('Validation failed');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('refuses workflow-origin controls before reading a model or saving a checkpoint', async () => {
    const { run, invocation, journal } = fixture(); invocation.origin = 'workflow';
    await expect(recoverTurnIntentControl(invocation, run, journal, config)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

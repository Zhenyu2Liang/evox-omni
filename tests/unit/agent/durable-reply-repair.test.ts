import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@/lib/db/prisma';
import type { SessionSnapshot } from '@/agent/session';
import type { ReplyRepairState } from '@/agent/reply-repair';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { continueDurableRun } from '@/agent/durable/continuation';
import { encodeCheckpoint, decodeCheckpoint } from '@/agent/durable/checkpoint';
import { runtimeRequestDigest, snapshotRuntimeValue } from '@/agent/durable/serialization';
import { repairConversationalReply } from '@/agent/turns/live-prompt';
import { createTurnBuffer } from '@/agent/turns/buffer';
import type { BankingAgentRuntime } from '@/agent/banking-agent';

const mocks = vi.hoisted(() => ({ latest: vi.fn(), completed: vi.fn(), save: vi.fn(), continuation: vi.fn(), checkpoint: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { modelRequest: { findFirst: mocks.latest, findMany: mocks.completed } } }));
vi.mock('@/agent/session', () => ({ saveSession: mocks.save }));
vi.mock('@/agent/banking-agent', () => ({ createBankingAgent: (options: { snapshot: SessionSnapshot }) => {
  const snapshot = options.snapshot;
  const agent = { state: snapshot.agentState, subscribe: () => () => {}, continue: mocks.continuation, prompt: vi.fn() };
  return { agent, planningRejections: new Map(), dispose: vi.fn(), serialize: () => snapshot,
    setReplyCorrection: vi.fn(),
    checkpointReplyRepair: async (state: ReplyRepairState) => { snapshot.replyRepair = state; await mocks.checkpoint(state.phase); } };
} }));

const config = { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'owner' };
const question = 'Explain the default funding account.';
const original = fauxAssistantMessage('{"role":"assistant","content":"Encoded reply"}');
const instruction = { role: 'system' as const, timestamp: 2, content: 'Return one complete corrected answer.' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.completed.mockResolvedValue([]);
  mocks.continuation.mockRejectedValue(new Error('A third model request must not occur.'));
});

describe('durable replay of a completed corrective response', () => {
  it('continues the first correction when its saved candidate has credential redaction', async () => {
    const candidate = fauxAssistantMessage('{"role":"assistant","content":"Encoded reply","note":"Bearer synthetic-secret-token"}');
    const source = { sessionId: 'session', userId: 'owner', revision: 0,
      agentState: { messages: [{ role: 'user', content: question, timestamp: 0 }, candidate, instruction] },
      transcript: [], createdAt: 0, updatedAt: 0,
      replyRepair: { version: 1, phase: 'requested', attempt: 1,
        sourceDigest: runtimeRequestDigest('reply_candidate', snapshotRuntimeValue(candidate)),
        instruction, issues: ['assistant_envelope'] },
    } as unknown as SessionSnapshot;
    const snapshot = decodeCheckpoint(encodeCheckpoint(source, config), config).snapshot;
    const continueReply = vi.fn(async () => {
      snapshot.agentState.messages.push(fauxAssistantMessage('Transfers use the primary checking account by default.'));
    });
    const runtime = { agent: { state: snapshot.agentState, continue: continueReply },
      setReplyCorrection: vi.fn(),
      serialize: () => snapshot, checkpointReplyRepair: async (state: ReplyRepairState) => { snapshot.replyRepair = state; },
    } as unknown as BankingAgentRuntime;
    await repairConversationalReply(runtime, createTurnBuffer(question), () => 4);
    expect(continueReply).toHaveBeenCalledTimes(1);
    expect(snapshot.replyRepair?.phase).toBe('completed');
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-secret-token');
    expect(snapshot.agentState.messages).toHaveLength(4);
  });

  it.each(['requested', 'completed'] as const)('does not spend another repair after a crash in phase %s', async phase => {
    const repeated = { ...fauxAssistantMessage('{"role":"assistant","content":"Invalid envelope"}'), timestamp: 3 };
    const snapshot = { sessionId: 'session', userId: 'owner', revision: 0,
      agentState: { model: { id: 'faux', api: original.api, provider: original.provider }, tools: [],
        messages: [{ role: 'user', content: question, timestamp: 0 }, original, instruction, repeated] },
      transcript: [], createdAt: 0, updatedAt: 0,
      replyRepair: { version: 1, phase, attempt: 1, sourceDigest: runtimeRequestDigest('reply_candidate', original),
        instruction, issues: ['assistant_envelope'], ...(phase === 'completed' ? { resultDigest: runtimeRequestDigest('reply_candidate', repeated) } : {}) },
    } as unknown as SessionSnapshot;
    const run = { id: 'run', sessionId: snapshot.sessionId, userId: snapshot.userId, baseRevision: 0,
      checkpointStage: 'model_completed', checkpointJson: encodeCheckpoint(snapshot, config),
      requestJson: JSON.stringify({ kind: 'input', message: question }),
    } as AgentRun;
    mocks.latest.mockResolvedValue({ id: 'repair-request', status: 'completed', resultJson: JSON.stringify(repeated) });
    const journal = { restoreModelRequestIdentity: vi.fn(), subscribe: () => () => {}, recordPresentationEvent: vi.fn(),
      recordAgentEvent: vi.fn(), checkpoint: vi.fn() };
    const status = await continueDurableRun(run, journal as never, [], { config });
    expect(status).toBe('completed');
    expect(mocks.continuation).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const persisted = mocks.save.mock.calls[0][0] as SessionSnapshot;
    expect(persisted.replyRepair?.phase).toBe('fallback');
    expect(persisted.replyRepair?.attempt).toBe(1);
    expect(persisted.agentState.messages).toEqual(expect.arrayContaining([original, repeated]));
    expect(persisted.transcript.filter(message => message.role === 'user')).toHaveLength(1);
    expect(persisted.transcript.filter(message => message.role === 'assistant')).toHaveLength(1);
    expect(persisted.transcript.at(-1)?.content).not.toContain('"role"');
  });
});

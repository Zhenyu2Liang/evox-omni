import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@/lib/db/prisma';
import type { SessionSnapshot } from '@/agent/session';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { continueDurableRun } from '@/agent/durable/continuation';
import { encodeCheckpoint } from '@/agent/durable/checkpoint';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';

const mocks = vi.hoisted(() => ({ latest: vi.fn(), models: vi.fn(), save: vi.fn(), factory: vi.fn(), original: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { modelRequest: { findFirst: mocks.latest, findMany: mocks.models } } }));
vi.mock('@/agent/session', () => ({ saveSession: mocks.save }));
vi.mock('@/agent/authorization-context', () => ({ readAuthorizationToolContext: mocks.original }));
vi.mock('@/agent/durable/authorized-checkpoint', () => ({ verifiedAuthorizationInput: async (_run: unknown, input: unknown) => input }));
vi.mock('@/agent/banking-agent', () => ({ createBankingAgent: (options: { snapshot: SessionSnapshot }) => {
  mocks.factory(options);
  return { agent: { state: options.snapshot.agentState, subscribe: () => () => {}, continue: vi.fn(), prompt: vi.fn() },
    planningRejections: new Map(), dispose: vi.fn(), serialize: () => options.snapshot };
} }));

const config = { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'owner' };
const requestText = 'Which subscriptions should I cancel?';
const answer = fauxAssistantMessage('Evaluate how frequently you use each subscription before deciding.');
const call = fauxAssistantMessage([fauxToolCall('list_subscriptions', {}, { id: 'query' })]);

function runFixture(latestUserText = requestText, purpose: 'advice' | 'query' | 'conversation' | 'operation' = 'advice',
  continuationPurpose: 'advice' | 'query' | 'operation' = 'advice') {
  const snapshot = { sessionId: 'session', userId: 'owner', revision: 0,
    agentState: { model: { id: 'faux', api: answer.api, provider: answer.provider }, tools: [],
      messages: [{ role: 'user', content: latestUserText, timestamp: 1 }, call,
        { role: 'toolResult', toolCallId: 'query', toolName: 'list_subscriptions', content: [{ type: 'text', text: 'No active subscriptions' }],
          details: [], isError: false, timestamp: 2 }, answer] },
    transcript: [{ id: 'user', role: 'user', content: latestUserText, timestamp: 1 }], createdAt: 0, updatedAt: 0,
    intent: declareConversationIntent(advanceConversationIntent(undefined, latestUserText), purpose, ['list_subscriptions']),
    replyContext: { purpose: continuationPurpose, requestText, sourceModelRequestId: 'source-request' },
  } as unknown as SessionSnapshot;
  const input = { sessionId: snapshot.sessionId, actionId: 'action', toolCallId: 'query', toolName: 'list_subscriptions',
    toolResult: { ok: true, data: [] } };
  return { id: 'run', sessionId: snapshot.sessionId, userId: snapshot.userId, baseRevision: 0,
    checkpointStage: 'model_completed', checkpointJson: encodeCheckpoint(snapshot, config),
    requestJson: JSON.stringify({ kind: 'authorization_result', ...input }),
  } as AgentRun;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.latest.mockResolvedValue({ id: 'continuation-request', status: 'completed', resultJson: JSON.stringify(answer) });
  mocks.models.mockResolvedValue([]);
  mocks.original.mockResolvedValue({ owner: call, sourceModelRequestId: 'source-request', originatingUserText: requestText, originatingPurpose: 'advice' });
});

describe('trusted advice purpose during authorization recovery', () => {
  it('restores complete advice after a successful read without replacing it with a query receipt', async () => {
    const journal = { restoreModelRequestIdentity: vi.fn(), subscribe: () => () => {}, recordPresentationEvent: vi.fn(), checkpoint: vi.fn() };
    expect(await continueDurableRun(runFixture(), journal as never, [], { config })).toBe('completed');
    expect(mocks.factory).toHaveBeenCalledWith(expect.objectContaining({
      replyContext: { purpose: 'advice', requestText, sourceModelRequestId: 'source-request' } }));
    const saved = mocks.save.mock.calls[0][0] as SessionSnapshot;
    expect(saved.transcript.at(-1)?.content).toBe('Evaluate how frequently you use each subscription before deciding.');
    expect(saved.replyContext?.requestText).toBe(requestText);
    expect(saved.transcript.filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('rejects a checkpoint that would revive advice after a different user message', async () => {
    const journal = { restoreModelRequestIdentity: vi.fn() };
    await expect(continueDurableRun(runFixture('Tell me something casual.'), journal as never, [], { config })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.factory).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rejects advice metadata attributed to a different original model request', async () => {
    mocks.original.mockResolvedValue({ owner: call, sourceModelRequestId: 'another-request', originatingUserText: requestText, originatingPurpose: 'advice' });
    const journal = { restoreModelRequestIdentity: vi.fn() };
    await expect(continueDurableRun(runFixture(), journal as never, [], { config })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it('rejects the same wording when its current typed purpose no longer matches the original advice', async () => {
    const journal = { restoreModelRequestIdentity: vi.fn() };
    await expect(continueDurableRun(runFixture(requestText, 'query'), journal as never, [], { config })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.factory).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('restores an operation continuation only from its exact authorized original read', async () => {
    mocks.original.mockResolvedValue({ owner: call, sourceModelRequestId: 'source-request', originatingUserText: requestText, originatingPurpose: 'operation' });
    const journal = { restoreModelRequestIdentity: vi.fn(), subscribe: () => () => {}, recordPresentationEvent: vi.fn(), checkpoint: vi.fn() };
    expect(await continueDurableRun(runFixture(requestText, 'operation', 'operation'), journal as never, [], { config })).toBe('completed');
    expect(mocks.factory).toHaveBeenCalledWith(expect.objectContaining({
      replyContext: { purpose: 'operation', requestText, sourceModelRequestId: 'source-request' },
    }));
    expect((mocks.save.mock.calls[0][0] as SessionSnapshot).intent?.purpose).toBe('operation');
  });
});

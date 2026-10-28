/**
 * Durable-side proof that the `continueDurableRun` "generation already completed with NO tool
 * calls" branch (`calls.length === 0`) now applies the SAME bounded write-continuation policy as
 * the foreground turn: a declared-but-unemitted LIVE write is prodded exactly once through a
 * persisted budget, and the server states the true outcome instead of the model's fabricated panel.
 *
 * Mirrors the FAKE-`BankingAgentRuntime` harness in `durable-reply-repair.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@/lib/db/prisma';
import type { AppConfig } from '@/lib/config';
import type { SessionSnapshot } from '@/agent/session';
import type { ReplyRepairState, WriteContinuationState } from '@/agent/reply-repair';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { continueDurableRun } from '@/agent/durable/continuation';
import { encodeCheckpoint } from '@/agent/durable/checkpoint';
import conversationMessages from '@/agent/messages/conversation.zh-CN.json';

const mocks = vi.hoisted(() => ({
  latest: vi.fn(), completed: vi.fn(), save: vi.fn(), continuation: vi.fn(), checkpoint: vi.fn(),
  /** Interleaved budget/provider journal; the order proves the budget lands before the request. */
  order: [] as string[], phaseWhenContinued: [] as (string | undefined)[],
}));
vi.mock('@/lib/db/client', () => ({ prisma: { modelRequest: { findFirst: mocks.latest, findMany: mocks.completed } } }));
vi.mock('@/agent/session', () => ({ saveSession: mocks.save }));
vi.mock('@/agent/banking-agent', () => ({ createBankingAgent: (options: { snapshot: SessionSnapshot }) => {
  const snapshot = options.snapshot;
  const agent = { state: snapshot.agentState, subscribe: () => () => {}, prompt: vi.fn(),
    continue: async () => { mocks.order.push('continue'); mocks.phaseWhenContinued.push(snapshot.writeContinuation?.phase); await mocks.continuation(); } };
  return { agent, planningRejections: new Map(), dispose: vi.fn(), serialize: () => snapshot,
    setReplyCorrection: vi.fn(),
    checkpointWriteContinuation: async (state: WriteContinuationState) => {
      snapshot.writeContinuation = state; mocks.order.push(`write_${state.phase}`); await mocks.checkpoint(`write_${state.phase}`);
    },
    checkpointReplyRepair: async (state: ReplyRepairState) => {
      snapshot.replyRepair = state; mocks.order.push(`reply_${state.phase}`); await mocks.checkpoint(`reply_${state.phase}`);
    } };
} }));

const config: AppConfig = { llmMode: 'live', llmProvider: 'faux', llmModel: 'faux', demoUserId: 'owner' };
const question = 'Transfer 200.00 to the saved contact.';
const PANEL_CLAIM = '请在上方确认面板中完成这笔转账，操作已提交等待你确认。';
const DECLARED_TRANSFER_UNSUBMITTED = conversationMessages.declared_unsubmitted.replace('{operations}', '转账');

interface Harness { run: AgentRun; snapshot: SessionSnapshot }

/** A decoded checkpoint whose last model response is ordinary prose with no controlled tool call. */
function completedProseRun(declaredTools: readonly string[], claim = PANEL_CLAIM, runConfig: AppConfig = config): Harness {
  const intent = { id: 'intent-1', revision: 1, purpose: 'operation' as const, needsInput: false, requestText: question,
    latestMessage: question, steps: declaredTools.map((tool, index) => ({ key: `step-${index + 1}`, tool })) };
  const source = { sessionId: 'session', userId: 'owner', revision: 0,
    agentState: { model: { id: 'faux', api: 'faux', provider: 'faux', baseUrl: '' }, tools: [],
      messages: [{ role: 'user', content: question, timestamp: 0 }] },
    transcript: [], createdAt: 0, updatedAt: 0, intent } as unknown as SessionSnapshot;
  const run = { id: 'run', sessionId: 'session', userId: 'owner', baseRevision: 0,
    checkpointStage: 'model_completed', checkpointJson: encodeCheckpoint(source, runConfig),
    requestJson: JSON.stringify({ kind: 'input', message: question }) } as AgentRun;
  mocks.latest.mockResolvedValue({ id: 'request-1', status: 'completed', resultJson: JSON.stringify(fauxAssistantMessage(claim)) });
  // The decode inside `continueDurableRun` produces its own snapshot; reuse the same shape here.
  return { run, snapshot: source };
}

function journal() {
  return { restoreModelRequestIdentity: vi.fn(), subscribe: () => () => {}, recordPresentationEvent: vi.fn(),
    recordAgentEvent: vi.fn(), checkpoint: vi.fn() };
}

/** The write-continuation phases only, so unrelated reply-repair checkpoints cannot mask ordering. */
function writeOrder(): string[] {
  return mocks.order.filter(entry => entry.startsWith('write_') || entry === 'continue');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.phaseWhenContinued.length = 0;
  mocks.completed.mockResolvedValue([]);
  mocks.continuation.mockResolvedValue(undefined);
});

describe('durable continuation of a finished declared-write turn', () => {
  it('continues a declared-but-unemitted write exactly once and states the true outcome', async () => {
    const { run } = completedProseRun(['transfer_money']);
    const status = await continueDurableRun(run, journal() as never, [], { config });
    expect(status).toBe('completed');
    // Exactly one bounded continuation for the missing controlled-write call.
    expect(mocks.continuation).toHaveBeenCalledTimes(1);
    // The durable budget is persisted BEFORE the single provider request and closed afterwards.
    expect(writeOrder()).toEqual(['write_requested', 'continue', 'write_completed']);
    expect(mocks.phaseWhenContinued).toEqual(['requested']);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const persisted = mocks.save.mock.calls[0][0] as SessionSnapshot;
    expect(persisted.writeContinuation).toMatchObject({ phase: 'completed', attempt: 1, declaredTools: ['transfer_money'] });
    // The fabricated panel prose is never published; the server-authored state is.
    const published = persisted.transcript.at(-1)?.content ?? '';
    expect(published).toBe(DECLARED_TRANSFER_UNSUBMITTED);
    expect(JSON.stringify(persisted.transcript)).not.toContain(PANEL_CLAIM);
  });

  it('does not engage the write continuation when the completed turn declared no write', async () => {
    const { run } = completedProseRun(['get_balance']);
    const status = await continueDurableRun(run, journal() as never, [], { config });
    expect(status).toBe('completed');
    expect(mocks.continuation).not.toHaveBeenCalled();
    expect(writeOrder()).toEqual([]);
    const persisted = mocks.save.mock.calls[0][0] as SessionSnapshot;
    expect(persisted.writeContinuation).toBeUndefined();
  });

  it('does not engage the write continuation outside LIVE mode', async () => {
    const mockConfig: AppConfig = { ...config, llmMode: 'mock' };
    const { run } = completedProseRun(['transfer_money'], PANEL_CLAIM, mockConfig);
    const status = await continueDurableRun(run, journal() as never, [], { config: mockConfig });
    expect(status).toBe('completed');
    expect(mocks.continuation).not.toHaveBeenCalled();
    expect(writeOrder()).toEqual([]);
    const persisted = mocks.save.mock.calls[0][0] as SessionSnapshot;
    expect(persisted.writeContinuation).toBeUndefined();
  });
});

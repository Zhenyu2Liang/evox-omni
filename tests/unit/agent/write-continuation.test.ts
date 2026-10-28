/**
 * Unit coverage for `agent/write-continuation.ts` — the bounded restart-safe continuation that
 * answers the just-fixed LIVE defect: a turn that DECLARED a banking write through `describe_turn`,
 * replied with ordinary prose claiming a confirmation panel, and emitted NO controlled-write tool
 * call (so no `PendingAction` and no panel ever existed).
 *
 * The pure helpers are exercised directly; the one-shot budget machine is driven through a FAKE
 * `BankingAgentRuntime` (mirroring `durable-reply-repair.test.ts`) and asserted against the
 * persisted `SessionSnapshot.writeContinuation`. The continuation only ever re-asks the model for
 * the missing controlled call — it never fabricates a panel, confirms or executes anything.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { AppConfig } from '@/lib/config';
import type { ConversationIntent } from '@/lib/contracts/intent';
import type { SessionSnapshot } from '@/agent/session';
import type { WriteContinuationState } from '@/agent/reply-repair';
import type { BankingAgentRuntime } from '@/agent/banking-agent';
import type { TurnBuffer } from '@/agent/turns/contracts';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import {
  continueDeclaredWrites,
  declaredWriteTools,
  hasGateEvent,
  hasWriteEvidence,
  pendingDeclaredWrites,
} from '@/agent/write-continuation';
import { createTurnBuffer } from '@/agent/turns/buffer';
import conversationMessages from '@/agent/messages/conversation.zh-CN.json';

const liveConfig: AppConfig = { llmMode: 'live', llmProvider: 'faux', llmModel: 'faux', demoUserId: 'owner' };
const mockConfig: AppConfig = { ...liveConfig, llmMode: 'mock' };

/** The model-authored PROSE this whole continuation exists for: a fabricated panel + submitted claim. */
const PANEL_CLAIM = '请在上方确认面板中完成这笔转账，操作已提交等待你确认。';
/** The server-authored state published when a declared write stayed unsubmitted. */
const DECLARED_TRANSFER_UNSUBMITTED = conversationMessages.declared_unsubmitted.replace('{operations}', '转账');

function intent(tools: readonly string[], allowProtocolExamples = false): ConversationIntent {
  return {
    id: 'intent-1', revision: 1, purpose: 'operation', requestText: 'request', latestMessage: 'request',
    needsInput: false, allowProtocolExamples, steps: tools.map((tool, index) => ({ key: `step-${index + 1}`, tool })),
  };
}

function bufferFor(declared: ConversationIntent): TurnBuffer {
  return createTurnBuffer('request', declared);
}

/** A real gate event is published only by a blocked gateway call; tests synthesize the event shape. */
function gate(kind: 'confirmation_required' | 'mfa_required'): AgentStreamEvent {
  return { type: kind, actionId: 'act-1' } as unknown as AgentStreamEvent;
}

function toolMessage(id: string, toolName: string) {
  return { id, role: 'tool' as const, content: '', timestamp: 0,
    toolEvents: [{ toolCallId: id, toolName, status: 'success' as const }] };
}

/** A fake runtime exposing only what `continueDeclaredWrites` touches, backed by one live snapshot. */
function fakeRuntime(declared: ConversationIntent | undefined, messages: AgentMessage[], onContinue?: () => void) {
  const agentState = { model: { id: 'faux', api: 'faux', provider: 'faux' }, tools: [], messages } as unknown as SessionSnapshot['agentState'];
  const snapshot = { sessionId: 'session', userId: 'owner', revision: 0, agentState, transcript: [],
    createdAt: 0, updatedAt: 0, intent: declared } as unknown as SessionSnapshot;
  const order: string[] = [];
  const checkpointWriteContinuation = vi.fn(async (state: WriteContinuationState) => {
    order.push(`checkpoint:${state.phase}`);
    snapshot.writeContinuation = state;
  });
  const continueRun = vi.fn(async () => { order.push('continue'); onContinue?.(); });
  const setReplyCorrection = vi.fn();
  const runtime = { agent: { state: agentState, continue: continueRun }, setReplyCorrection,
    serialize: () => snapshot, checkpointWriteContinuation } as unknown as BankingAgentRuntime;
  return { runtime, snapshot, continueRun, checkpointWriteContinuation, setReplyCorrection, order };
}

/** The ordinary-prose candidate and the unpublished presentation entry it owns. */
function proseCandidate(claim = PANEL_CLAIM) {
  const buffer = bufferFor(intent(['transfer_money']));
  const message = { id: 'candidate', role: 'assistant' as const, content: claim, timestamp: 1, cards: [], toolEvents: [] };
  buffer.current = message;
  buffer.assistants.push(message);
  buffer.events.push({ type: 'message_start', message: { ...message } }, { type: 'message_end', message });
  return buffer;
}

describe('declaredWriteTools', () => {
  it('keeps only write-effect declared steps', () => {
    expect(declaredWriteTools(intent(['transfer_money', 'get_balance', 'subscribe_investment'])))
      .toEqual(['transfer_money', 'subscribe_investment']);
  });

  it('ignores reads, the workflow tool and an absent intent', () => {
    expect(declaredWriteTools(intent(['get_balance', 'search_contact', 'submit_plan']))).toEqual([]);
    expect(declaredWriteTools(undefined)).toEqual([]);
  });
});

describe('hasGateEvent', () => {
  it('is true only for a real confirmation/mfa gate event', () => {
    const buffer = bufferFor(intent(['transfer_money']));
    expect(hasGateEvent(buffer)).toBe(false);
    buffer.events.push({ type: 'reply_progress', phase: 'generating' });
    expect(hasGateEvent(buffer)).toBe(false);

    const confirm = bufferFor(intent(['transfer_money']));
    confirm.events.push(gate('confirmation_required'));
    expect(hasGateEvent(confirm)).toBe(true);

    const mfa = bufferFor(intent(['transfer_money']));
    mfa.events.push(gate('mfa_required'));
    expect(hasGateEvent(mfa)).toBe(true);
  });
});

describe('hasWriteEvidence', () => {
  it('is false for an empty turn and for read-only facts or tool entries', () => {
    const buffer = bufferFor(intent(['transfer_money']));
    expect(hasWriteEvidence(buffer)).toBe(false);
    buffer.factResults.push({ toolName: 'get_balance', toolCallId: 'c1', result: { ok: true } });
    buffer.toolMessages.set('c2', toolMessage('c2', 'get_balance'));
    expect(hasWriteEvidence(buffer)).toBe(false);
  });

  it('is true for a real gate, a write fact result, a submit_plan entry or a write tool entry', () => {
    const gated = bufferFor(intent(['transfer_money']));
    gated.events.push(gate('confirmation_required'));
    expect(hasWriteEvidence(gated)).toBe(true);

    const fact = bufferFor(intent(['transfer_money']));
    fact.factResults.push({ toolName: 'transfer_money', toolCallId: 'c1', result: { ok: true } });
    expect(hasWriteEvidence(fact)).toBe(true);

    const plan = bufferFor(intent(['transfer_money']));
    plan.toolMessages.set('c3', toolMessage('c3', 'submit_plan'));
    expect(hasWriteEvidence(plan)).toBe(true);

    const write = bufferFor(intent(['transfer_money']));
    write.toolMessages.set('c4', toolMessage('c4', 'transfer_money'));
    expect(hasWriteEvidence(write)).toBe(true);
  });
});

describe('pendingDeclaredWrites', () => {
  const runtimeFor = (declared?: ConversationIntent) =>
    ({ serialize: () => ({ intent: declared }) } as unknown as BankingAgentRuntime);

  it('is undefined outside LIVE mode, without a declared write, or once write evidence exists', () => {
    expect(pendingDeclaredWrites(runtimeFor(intent(['transfer_money'])), bufferFor(intent(['transfer_money'])), mockConfig)).toBeUndefined();
    expect(pendingDeclaredWrites(runtimeFor(undefined), bufferFor(intent(['transfer_money'])), liveConfig)).toBeUndefined();
    expect(pendingDeclaredWrites(runtimeFor(intent(['get_balance'])), bufferFor(intent(['get_balance'])), liveConfig)).toBeUndefined();

    const evidenced = bufferFor(intent(['transfer_money']));
    evidenced.events.push(gate('mfa_required'));
    expect(pendingDeclaredWrites(runtimeFor(intent(['transfer_money'])), evidenced, liveConfig)).toBeUndefined();
  });

  it('returns the declared write tools when a LIVE declared write has no controlled evidence', () => {
    const declared = intent(['transfer_money', 'get_balance']);
    expect(pendingDeclaredWrites(runtimeFor(declared), bufferFor(declared), liveConfig)).toEqual(['transfer_money']);
  });
});

describe('continueDeclaredWrites one-shot budget', () => {
  it('persists the budget before the provider request, continues exactly once and publishes the true state', async () => {
    const declared = intent(['transfer_money']);
    const { runtime, snapshot, continueRun, checkpointWriteContinuation, order } = fakeRuntime(declared, [fauxAssistantMessage(PANEL_CLAIM)]);
    const buffer = proseCandidate();

    await continueDeclaredWrites(runtime, buffer, () => 7, { config: liveConfig });

    expect(continueRun).toHaveBeenCalledTimes(1);
    // The durable budget is recorded BEFORE the single provider request, then closed afterwards.
    expect(order).toEqual(['checkpoint:requested', 'continue', 'checkpoint:completed']);
    expect(checkpointWriteContinuation.mock.calls[0][0]).toMatchObject({ phase: 'requested', attempt: 1, declaredTools: ['transfer_money'] });
    expect(snapshot.writeContinuation).toMatchObject({ phase: 'completed', attempt: 1, declaredTools: ['transfer_money'] });
    // No controlled write ever landed: the server states the true outcome instead of the fabricated panel.
    expect(buffer.current?.content).toBe(DECLARED_TRANSFER_UNSUBMITTED);
    expect(JSON.stringify(buffer.events)).not.toContain('确认面板');
    expect(JSON.stringify(buffer.assistants)).not.toContain(PANEL_CLAIM);
    expect(buffer.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
  });

  it('brackets the request as a correction when applyCorrection is set', async () => {
    const declared = intent(['transfer_money']);
    const { runtime, setReplyCorrection } = fakeRuntime(declared, [fauxAssistantMessage(PANEL_CLAIM)]);
    await continueDeclaredWrites(runtime, proseCandidate(), () => 7, { config: liveConfig, applyCorrection: true });
    expect(setReplyCorrection.mock.calls).toEqual([[true], [false]]);
  });

  it('does not spend the budget twice for the same candidate', async () => {
    const declared = intent(['transfer_money']);
    const { runtime, continueRun } = fakeRuntime(declared, [fauxAssistantMessage(PANEL_CLAIM)]);
    const buffer = proseCandidate();

    await continueDeclaredWrites(runtime, buffer, () => 7, { config: liveConfig });
    expect(continueRun).toHaveBeenCalledTimes(1);
    const published = buffer.current?.content;

    await continueDeclaredWrites(runtime, buffer, () => 8, { config: liveConfig });
    expect(continueRun).toHaveBeenCalledTimes(1);
    expect(buffer.current?.content).toBe(published);
  });

  it('skips a valid guidance envelope without spending the budget', async () => {
    const declared = intent(['subscribe_investment']);
    const guidance = fauxAssistantMessage('{"guidance":{"code":"missing_details","fields":["product","amount"]}}');
    const { runtime, snapshot, continueRun } = fakeRuntime(declared, [guidance]);

    await continueDeclaredWrites(runtime, bufferFor(declared), () => 7, { config: liveConfig });

    expect(continueRun).not.toHaveBeenCalled();
    expect(snapshot.writeContinuation).toBeUndefined();
  });

  it('skips a protocol envelope that needs format repair', async () => {
    const declared = intent(['transfer_money']);
    const envelope = fauxAssistantMessage('{"role":"assistant","content":"Invalid protocol"}');
    const { runtime, snapshot, continueRun } = fakeRuntime(declared, [envelope]);

    await continueDeclaredWrites(runtime, bufferFor(declared), () => 7, { config: liveConfig });

    expect(continueRun).not.toHaveBeenCalled();
    expect(snapshot.writeContinuation).toBeUndefined();
  });

  it('does nothing outside LIVE mode or when the turn already has write evidence', async () => {
    const declared = intent(['transfer_money']);
    const prose = fauxAssistantMessage(PANEL_CLAIM);

    const mockRun = fakeRuntime(declared, [prose]);
    await continueDeclaredWrites(mockRun.runtime, proseCandidate(), () => 7, { config: mockConfig });
    expect(mockRun.continueRun).not.toHaveBeenCalled();
    expect(mockRun.snapshot.writeContinuation).toBeUndefined();

    const evidenced = fakeRuntime(declared, [prose]);
    const buffer = proseCandidate();
    buffer.events.push(gate('confirmation_required'));
    await continueDeclaredWrites(evidenced.runtime, buffer, () => 7, { config: liveConfig });
    expect(evidenced.continueRun).not.toHaveBeenCalled();
    expect(evidenced.snapshot.writeContinuation).toBeUndefined();
  });

  it('does not engage when the turn has no declared write or the candidate is not a stopped assistant reply', async () => {
    const readOnly = intent(['get_balance']);
    const prose = fauxAssistantMessage(PANEL_CLAIM);
    const { runtime, continueRun } = fakeRuntime(readOnly, [prose]);
    await continueDeclaredWrites(runtime, proseCandidate(), () => 7, { config: liveConfig });
    expect(continueRun).not.toHaveBeenCalled();

    const declared = intent(['transfer_money']);
    const toolUse = { ...fauxAssistantMessage(PANEL_CLAIM), stopReason: 'toolUse' as const } as unknown as AgentMessage;
    const incomplete = fakeRuntime(declared, [toolUse]);
    await continueDeclaredWrites(incomplete.runtime, proseCandidate(), () => 7, { config: liveConfig });
    expect(incomplete.continueRun).not.toHaveBeenCalled();
    expect(incomplete.snapshot.writeContinuation).toBeUndefined();
  });
});

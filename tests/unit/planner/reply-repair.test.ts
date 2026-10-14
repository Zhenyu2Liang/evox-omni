import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { BankingAgentRuntime } from '@/agent/banking-agent';
import type { ReplyRepairState } from '@/agent/reply-repair';
import { runtimeRequestDigest } from '@/agent/durable/serialization';
import { repairConversationalReply, retireUnpublishedReply, runLivePrompt } from '@/agent/turns/live-prompt';
import { createTurnBuffer, newAssistantMessage } from '@/agent/turns/buffer';
import { findRunFailure } from '@/agent/turns/message-utils';

const invalid = fauxAssistantMessage('{"role":"assistant","content":"Encoded reply"}');
const question = 'Why does the bank use a checking account by default?';
const instruction: AgentMessage = { role: 'system', timestamp: 2, content: 'Return a complete natural explanation.' };
const requested: ReplyRepairState = { version: 1, phase: 'requested', attempt: 1,
  sourceDigest: runtimeRequestDigest('reply_candidate', invalid), instruction, issues: ['assistant_envelope'] };

function fixture(messages: AgentMessage[], state?: ReplyRepairState, response = fauxAssistantMessage('A complete natural explanation.')) {
  const buffer = createTurnBuffer(question);
  buffer.current = newAssistantMessage(1);
  buffer.assistants.push(buffer.current);
  buffer.events.push({ type: 'message_start', message: buffer.current });
  let persisted = state;
  const phases: string[] = [];
  const agent = { state: { messages, model: { api: 'faux', provider: 'faux', id: 'faux' } },
    continue: vi.fn(async () => { agent.state.messages.push(response); }), prompt: vi.fn() };
  const runtime = { agent, planningRejections: new Map(), serialize: () => ({ replyRepair: persisted }),
    setReplyCorrection: vi.fn(),
    checkpointReplyRepair: vi.fn(async (next: ReplyRepairState) => { persisted = next; phases.push(next.phase); }) } as unknown as BankingAgentRuntime;
  return { runtime, buffer, agent, phases, state: () => persisted };
}

describe('durable corrective generation budget', () => {
  it('does not spend repair requests on amounts, draft wording or internal field terminology', async () => {
    const original = fauxAssistantMessage('Your current balance is $999999.00. For the old draft, provide an amount. sourceAccountId identifies the checking account.');
    const f = fixture([original]);
    await repairConversationalReply(f.runtime, f.buffer, () => 3);
    expect(f.agent.continue).not.toHaveBeenCalled();
    expect(f.state()).toBeUndefined();
    expect(f.agent.state.messages).toEqual([original]);
  });

  it('retires only the unpublished prose owner while retaining independently published tool rows', () => {
    const f = fixture([invalid]);
    const candidateId = f.buffer.current!.id;
    const tool = { id: 'query-row', role: 'tool' as const, content: '', timestamp: 2, cards: [],
      toolEvents: [{ messageId: 'query-row', toolCallId: 'query-call', toolName: 'list_subscriptions', status: 'success' as const }] };
    f.buffer.assistants.push(tool);
    f.buffer.events.push({ type: 'message_start', message: tool },
      { type: 'tool_end', toolEvent: tool.toolEvents[0] },
      { type: 'card', messageId: tool.id, card: { type: 'subscriptions', data: [] } },
      { type: 'message_end', message: tool });
    const published = f.buffer.events.slice(1);
    retireUnpublishedReply(f.buffer);
    expect(f.buffer.events).toEqual(published);
    expect(f.buffer.assistants.map(message => message.id)).toEqual([tool.id]);
    expect(f.buffer.assistants.some(message => message.id === candidateId)).toBe(false);
    expect(f.buffer.current).toBeNull();
  });

  it('records the budget before generation and retains the complete original and corrected messages', async () => {
    const f = fixture([{ role: 'user', content: question, timestamp: 0 }, invalid]);
    f.agent.continue.mockImplementation(async () => {
      expect(f.state()?.phase).toBe('requested');
      f.agent.state.messages.push(fauxAssistantMessage('A complete natural explanation.'));
    });
    await repairConversationalReply(f.runtime, f.buffer, () => 3);
    expect(f.agent.continue).toHaveBeenCalledTimes(1);
    expect(f.phases).toEqual(['requested', 'completed']);
    expect(f.agent.state.messages).toContain(invalid);
    expect(f.agent.state.messages.at(-1)?.role).toBe('assistant');
    expect(f.state()?.attempt).toBe(1);
    expect(f.runtime.setReplyCorrection).toHaveBeenNthCalledWith(1, true);
    expect(f.runtime.setReplyCorrection).toHaveBeenNthCalledWith(2, false);
  });

  it('resumes a checkpointed instruction without duplicating it', async () => {
    const f = fixture([invalid, instruction], requested);
    await repairConversationalReply(f.runtime, f.buffer, () => 3);
    expect(f.agent.continue).toHaveBeenCalledTimes(1);
    expect(f.agent.state.messages.filter(message => message === instruction)).toHaveLength(1);
    expect(f.phases).toEqual(['completed']);
  });

  it('clears the structured correction gate when a provider request fails', async () => {
    const f = fixture([invalid]);
    f.agent.continue.mockRejectedValue(new Error('Provider transport failed'));
    await expect(repairConversationalReply(f.runtime, f.buffer, () => 3)).rejects.toThrow('Provider transport failed');
    expect(f.runtime.setReplyCorrection).toHaveBeenNthCalledWith(1, true);
    expect(f.runtime.setReplyCorrection).toHaveBeenNthCalledWith(2, false);
    expect(f.buffer.repairingReply).toBe(false);
    expect(f.state()?.phase).toBe('requested');
  });

  it('preserves explicitly permitted protocol examples without using a repair budget', async () => {
    const f = fixture([invalid]);
    f.buffer.allowProtocolExamples = true;
    await repairConversationalReply(f.runtime, f.buffer, () => 3);
    expect(f.agent.continue).not.toHaveBeenCalled();
    expect(f.state()).toBeUndefined();
  });

  it('recognizes a completed repair before its phase checkpoint and never generates a third response', async () => {
    const repeated = fauxAssistantMessage('<think>Private reasoning</think>');
    const f = fixture([invalid, instruction, repeated], requested);
    await repairConversationalReply(f.runtime, f.buffer, () => 3);
    expect(f.agent.continue).not.toHaveBeenCalled();
    expect(f.phases).toEqual(['completed', 'fallback']);
    expect(f.buffer.current?.content).not.toContain('<think>');
    expect(f.agent.state.messages).toContain(invalid);
    expect(f.agent.state.messages).toContain(repeated);
  });

  it('keeps the budget exhausted across repeated recovery of a completed candidate', async () => {
    const repeated = fauxAssistantMessage('{"role":"assistant","content":"Invalid envelope"}');
    const state: ReplyRepairState = { ...requested, phase: 'completed',
      resultDigest: runtimeRequestDigest('reply_candidate', repeated) };
    const f = fixture([invalid, instruction, repeated], state);
    await repairConversationalReply(f.runtime, f.buffer, () => 3);
    const fallback = f.state()!.fallbackText;
    const restored = fixture([invalid, instruction, repeated], f.state());
    await repairConversationalReply(restored.runtime, restored.buffer, () => 4);
    expect(f.agent.continue).not.toHaveBeenCalled();
    expect(restored.agent.continue).not.toHaveBeenCalled();
    expect(restored.buffer.current?.content).toBe(fallback);
    expect(restored.state()?.attempt).toBe(1);
  });

  it('treats a length stop as a failed generation with an explicit output-limit reason', async () => {
    const truncated = { ...fauxAssistantMessage('A partial answer'), stopReason: 'length' as const };
    expect(findRunFailure([truncated])).toBe(truncated);
    const f = fixture([]);
    f.agent.prompt.mockImplementation(async () => { f.agent.state.messages.push(truncated); });
    const failure = await runLivePrompt(f.runtime, f.buffer, question, () => 3);
    expect(failure).toBe('Model response reached its output limit.');
    expect(f.agent.continue).not.toHaveBeenCalled();
    expect(f.state()).toBeUndefined();
  });

  it('prompts the original request once without retrying incomplete business planning', async () => {
    const f = fixture([]);
    f.agent.prompt.mockImplementation(async () => { f.agent.state.messages.push(fauxAssistantMessage('Please clarify the request.')); });
    const request = 'Freeze both cards and purchase a product.';
    expect(await runLivePrompt(f.runtime, f.buffer, request, () => 3)).toBeUndefined();
    expect(f.agent.prompt).toHaveBeenCalledExactlyOnceWith(request);
    expect(f.agent.continue).not.toHaveBeenCalled();
    expect(f.state()).toBeUndefined();
  });
});

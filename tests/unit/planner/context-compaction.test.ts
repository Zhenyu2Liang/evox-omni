import { describe, expect, it } from 'vitest';
import { contentText, fauxAssistantMessage, createAssistantMessageEventStream, type Context } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createContextCompactor, type ContextCompactionState } from '@/agent/context-compaction';
import { compactionCut, projectedMessages, prefixDigest } from '@/agent/context-compaction/projection';
import { withRealToolResult } from '@/agent/message-normalize';
import type { ModelRuntime } from '@/agent/providers/types';
import { createMockModel } from '@/agent/providers/provider-mock';

const config = { llmMode: 'mock' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'owner' };
const model = createMockModel(config);
const user = (content: string, timestamp: number): AgentMessage => ({ role: 'user', content, timestamp });
const archive = [user('Remember the original signed request: -10 CNY. ' + 'Earlier discussion. '.repeat(150), 1),
  fauxAssistantMessage('The negative amount cannot authorize a transfer.'), user('What was my earlier wording?', 2)];

function provider(reply: string, calls: { contexts: unknown[] }, fail = false): ModelRuntime {
  return { model, streamFn: (_model, context) => {
    calls.contexts.push(context);
    const stream = createAssistantMessageEventStream();
    const message = fauxAssistantMessage(reply);
    if (fail) stream.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: 'Network timeout' } });
    else stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  } };
}

describe('durable context compaction projection', () => {
  it('summarizes old turns without changing the archive or truncating the recent question', async () => {
    const calls = { contexts: [] as unknown[] };
    const events: string[] = [];
    const checkpoints: string[] = [];
    let state: ContextCompactionState | undefined;
    const original = JSON.stringify(archive);
    const compactor = createContextCompactor({ runtime: provider('The user requested -10 CNY, which was invalid. No transfer occurred.', calls),
      settings: { thresholdTokens: 256, keepRecentTokens: 128 }, onState: next => { state = next; },
      persist: { event: async type => { events.push(type); }, checkpoint: async stage => { checkpoints.push(stage); } } });
    const view = await compactor.project(archive);
    expect(JSON.stringify(archive)).toBe(original);
    expect(view.at(-1)).toBe(archive.at(-1));
    expect(JSON.stringify(view)).toContain('-10');
    expect(JSON.stringify(view)).toContain('not a new instruction or authorization');
    expect(state?.summary?.coveredMessages).toBe(2);
    expect(state?.pending).toBeUndefined();
    expect(events).toContain('compaction_request');
    expect(events).toContain('compaction_completed');
    expect(checkpoints).toEqual(['compaction_request', 'compaction_completed']);
    await compactor.project([...archive, fauxAssistantMessage('A natural complete reply.')]);
    expect(calls.contexts).toHaveLength(1);
  });

  it('uses the public Pi compact contract and the provider runtime without enabling tools or prompt caching', async () => {
    const options: unknown[] = [];
    const base = provider('A complete official summary.', { contexts: [] });
    const runtime: ModelRuntime = { ...base, streamFn: (model, context, requestOptions) => {
      options.push(requestOptions);
      expect(context).not.toHaveProperty('tools');
      expect(contentText(context.messages.find(message => message.role === 'user')!.content)).toContain('<conversation>');
      return base.streamFn(model, context, requestOptions);
    } };
    await createContextCompactor({ runtime, settings: { thresholdTokens: 256, keepRecentTokens: 128, summaryTokens: 128 },
      onState: () => {} }).project(archive);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ maxTokens: 128, cacheRetention: 'none', sessionId: expect.any(String) });
  });

  it.each(['length', 'aborted', 'toolCall', 'empty'] as const)('retains the archive and unfinished request when Pi rejects a %s summary', async failure => {
    let state: ContextCompactionState | undefined;
    const events: string[] = [];
    const original = JSON.stringify(archive);
    const runtime: ModelRuntime = { model, streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage(failure === 'toolCall'
        ? [{ type: 'toolCall', id: 'bad', name: 'transfer', arguments: {} }] : failure === 'empty' ? '' : 'An incomplete summary.');
      if (failure === 'aborted') stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } });
      else stream.push({ type: 'done', reason: failure === 'length' ? 'length' : 'stop',
        message: { ...message, stopReason: failure === 'length' ? 'length' : 'stop' } });
      return stream;
    } };
    const compactor = createContextCompactor({ runtime, settings: { thresholdTokens: 256, keepRecentTokens: 128 },
      onState: next => { state = next; }, persist: { event: async type => { events.push(type); }, checkpoint: async () => {} } });
    await expect(compactor.project(archive)).rejects.toThrow();
    expect(JSON.stringify(archive)).toBe(original);
    expect(state?.summary).toBeUndefined();
    expect(state?.pending?.attempt).toBe(1);
    expect(events).toContain('compaction_response');
    expect(events).toContain('compaction_failed');
    expect(events).not.toContain('compaction_completed');
  });

  it('keeps assistant tool calls and all parallel results in the same recent user turn', () => {
    const call = fauxAssistantMessage([{ type: 'toolCall', id: 'call', name: 'get_balance', arguments: {} }]);
    const result: AgentMessage = { role: 'toolResult', toolCallId: 'call', toolName: 'get_balance',
      content: [{ type: 'text', text: 'Exact balance' }], isError: false, timestamp: 3 };
    const messages = [...archive.slice(0, 2), user('Query balance', 2), call, result];
    expect(compactionCut(messages, 128)).toBe(2);
    const summary = { coveredMessages: 2, prefixDigest: prefixDigest(messages, 2),
      text: 'Earlier conversation', tokensBefore: 1000, tokensAfter: 100 };
    expect(projectedMessages(messages, summary).slice(-3)).toEqual(messages.slice(-3));
  });

  it('retries a persisted summary request after interruption without generating a normal model request', async () => {
    let state: ContextCompactionState | undefined;
    const failedCalls = { contexts: [] as unknown[] };
    const failing = createContextCompactor({ runtime: provider('', failedCalls, true), settings: { thresholdTokens: 256, keepRecentTokens: 128 },
      onState: next => { state = next; } });
    await expect(failing.project(archive)).rejects.toThrow('Network timeout');
    expect(state?.pending?.attempt).toBe(1);
    const request = JSON.stringify(state?.pending?.messages);
    const retryCalls = { contexts: [] as unknown[] };
    const retry = createContextCompactor({ runtime: provider('Signed original amount -10 CNY.', retryCalls), state,
      settings: { thresholdTokens: 256, keepRecentTokens: 128 }, onState: next => { state = next; } });
    await retry.project(archive);
    expect(JSON.stringify((retryCalls.contexts[0] as { messages: unknown[] }).messages)).toBe(request);
    expect(state?.summary?.text).toContain('-10');
    expect(state?.pending).toBeUndefined();
  });

  it('invalidates a stale summary after a history reset or a changed original message', () => {
    const summary = { coveredMessages: 2, prefixDigest: prefixDigest(archive, 2),
      text: 'Historical memory', tokensBefore: 1000, tokensAfter: 100 };
    const changed = [user('A different request', 1), ...archive.slice(1)];
    expect(projectedMessages(changed, summary)).toEqual(changed);
    expect(projectedMessages([], summary)).toEqual([]);
  });

  it('does not generate a summary for a short conversation', async () => {
    const calls = { contexts: [] as unknown[] };
    const messages = [user('Hello', 1)];
    const compactor = createContextCompactor({ runtime: provider('Unused', calls), onState: () => {} });
    expect(await compactor.project(messages)).toEqual(messages);
    expect(calls.contexts).toEqual([]);
  });

  it('keeps prior tool calls and results in an uncompacted model view and its original archive', () => {
    const call = fauxAssistantMessage([{ type: 'toolCall', id: 'old', name: 'search_contact', arguments: { query: 'Zhang' } }]);
    const result: AgentMessage = { role: 'toolResult', toolCallId: 'old', toolName: 'search_contact',
      content: [{ type: 'text', text: 'Old recipient' }], isError: false, timestamp: 1 };
    const old = [user('Transfer to Zhang', 1), call, result];
    const fresh = [user('Query balance', 2), fauxAssistantMessage([{ type: 'toolCall', id: 'fresh', name: 'get_balance', arguments: {} }])];
    const archive = [...old, ...fresh];
    const source = JSON.stringify(archive);
    const view = projectedMessages(archive);
    expect(view).toEqual(archive);
    expect(JSON.stringify(archive)).toBe(source);
  });

  it('retains every tool group when an earlier authorization updates its own result', () => {
    const pending = fauxAssistantMessage([{ type: 'toolCall', id: 'pending', name: 'transfer_money', arguments: { amount: '200.00' } }]);
    const waiting: AgentMessage = { role: 'toolResult', toolCallId: 'pending', toolName: 'transfer_money',
      content: [{ type: 'text', text: 'Waiting for confirmation' }], isError: true, timestamp: 1 };
    const draft = fauxAssistantMessage([{ type: 'toolCall', id: 'draft', name: 'search_contact', arguments: { query: 'Zhang' } }]);
    const result: AgentMessage = { role: 'toolResult', toolCallId: 'draft', toolName: 'search_contact',
      content: [{ type: 'text', text: 'Draft recipient' }], isError: false, timestamp: 2 };
    const messages = [user('Transfer 200 CNY', 0), pending, waiting, user('Start an incomplete transfer', 2), draft, result,
      user('Explain the funding rule', 3)];
    const completed = withRealToolResult(messages, { ...waiting, isError: false, content: [{ type: 'text', text: 'Committed original transfer' }] });
    const view = projectedMessages(completed);
    expect(view).toContain(draft);
    expect(view).toContain(result);
    expect(view).toContain(pending);
    expect(view).toContain(messages[3]);
    expect(view.at(-1)).toBe(messages.at(-1));
    expect(completed).toContain(draft);
    expect(completed).toContain(result);
  });

  it('reports an oversized recent turn without deleting or clipping any original message', async () => {
    const calls = { contexts: [] as unknown[] };
    const base = provider('Unused', calls);
    const source = [user('\u5b8c\u6574\u539f\u8bdd'.repeat(600), 1)];
    const original = JSON.stringify(source);
    const compactor = createContextCompactor({ runtime: { ...base, model: { ...base.model, contextWindow: 1024 } },
      onState: () => {} });
    await expect(compactor.project(source)).rejects.toMatchObject({ code: 'VALIDATION',
      detail: { reason: 'CONTEXT_BUDGET_EXCEEDED' } });
    expect(JSON.stringify(source)).toBe(original);
    expect(calls.contexts).toEqual([]);
  });

  it('counts system declarations and explicit remaining tool overhead in the request budget', async () => {
    const calls = { contexts: [] as unknown[] };
    const base = provider('Unused', calls);
    const compactor = createContextCompactor({ runtime: { ...base, model: { ...base.model, contextWindow: 1024 } },
      onState: () => {} });
    await expect(compactor.project([user('Hello', 1)], undefined, 1000)).rejects.toMatchObject({ code: 'VALIDATION' });
    const system: AgentMessage = { role: 'system', timestamp: 0, content: 'Complete system rules. '.repeat(200) };
    await expect(compactor.project([system, user('Hello', 1)])).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(calls.contexts).toEqual([]);
  });

  it('uses official serialization and summary updates for bounded text excerpts without modifying original messages', async () => {
    const calls = { contexts: [] as unknown[] };
    const base = provider('Historical request -10 CNY.', calls);
    const compactor = createContextCompactor({ runtime: { ...base, model: { ...base.model, contextWindow: 4096 } },
      settings: { thresholdTokens: 256, keepRecentTokens: 128 }, onState: () => {} });
    await compactor.project(archive);
    expect(calls.contexts.length).toBeGreaterThan(1);
    const prompts = calls.contexts.map(context => {
      const input = (context as Context).messages.find(message => message.role === 'user')!;
      return contentText(input.content);
    });
    const excerpts = prompts.flatMap(prompt => [...prompt.matchAll(/\[User\]: ([\s\S]*?)(?=\n\n\[Assistant\]: |\n<\/conversation>)/g)].map(match => match[1]));
    expect(excerpts.join('')).toBe((archive[0] as { content: string }).content);
    expect(prompts[0]).toContain('## Goal');
    expect(prompts[0]).toContain('Additional focus:');
    expect(prompts[1]).toContain('<previous-summary>\nHistorical request -10 CNY.\n</previous-summary>');
    expect(prompts.join('')).toContain('The negative amount cannot authorize a transfer.');
  });

  it('continues from a partial batch checkpoint and reuses the failed official request exactly', async () => {
    let state: ContextCompactionState | undefined;
    const calls = { contexts: [] as unknown[] };
    const base = provider('The first completed summary retained -10 CNY.', calls);
    let requests = 0;
    const first = createContextCompactor({ runtime: { ...base, model: { ...model, contextWindow: 4096 },
      streamFn: (model, context, options) => {
        if (++requests === 2) { calls.contexts.push(context); throw new Error('Interrupted second batch'); }
        return base.streamFn(model, context, options);
      } }, settings: { thresholdTokens: 256, keepRecentTokens: 128 }, onState: next => { state = next; } });
    await expect(first.project(archive)).rejects.toThrow('Interrupted second batch');
    expect(state?.pending?.chunkIndex).toBe(1);
    expect(state?.pending?.previousSummary).toContain('-10');
    const retryCalls = { contexts: [] as unknown[] };
    const retryBase = provider('The final summary retained -10 CNY.', retryCalls);
    const retry = createContextCompactor({ runtime: { ...retryBase, model: { ...model, contextWindow: 4096 } },
      settings: { thresholdTokens: 256, keepRecentTokens: 128 }, state: JSON.parse(JSON.stringify(state)),
      onState: next => { state = next; } });
    await retry.project(archive);
    expect(retryCalls.contexts[0]).toEqual(calls.contexts[1]);
    expect(state?.pending).toBeUndefined();
    expect(state?.summary?.text).toContain('-10');
  });
});

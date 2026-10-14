import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectTranscriptActivity } from '@/agent/transcript-activity';
import { ConfirmationCard } from '@/components/chat/cards/ConfirmationCard';
import type { ChatMessage } from '@/lib/contracts/agent';
import { createTranslator } from '@/lib/i18n/shared';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { toolPresentationId } from '@/agent/tool-presentation-identity';

const invocation = { id: 'inv-1', runId: 'run-1', callId: 'call-1', toolName: 'list_subscriptions',
  status: 'waiting_confirmation', resultJson: null };
const action = { id: 'action-1', invocationId: 'inv-1', toolName: 'list_subscriptions', status: 'executed',
  resultJson: JSON.stringify({ ok: true, summary: 'Six active subscriptions' }) };
const message: ChatMessage = { id: 'message-1', role: 'assistant', content: '', timestamp: 1,
  toolEvents: [{ toolCallId: 'call-1', toolName: 'list_subscriptions', status: 'started' }] };

describe('authoritative historical activity', () => {
  it('restores a completed authorization from its exact invocation without changing the archive', () => {
    const projected = projectTranscriptActivity([message], new Map([['message-1', 'run-1']]), [invocation], [action]);
    expect(projected[0].toolEvents?.[0]).toMatchObject({ actionId: 'action-1', status: 'success', summary: 'Six active subscriptions' });
    expect(message.toolEvents?.[0].status).toBe('started');
  });

  it('does not conflate reused provider call IDs across runs', () => {
    const other: ChatMessage = { ...message, id: 'message-2' };
    const projected = projectTranscriptActivity([message, other], new Map([['message-1', 'run-1'], ['message-2', 'run-2']]),
      [invocation, { ...invocation, id: 'inv-2', runId: 'run-2' }], [action]);
    expect(projected[0].toolEvents?.[0].status).toBe('success');
    expect(projected[1].toolEvents?.[0].status).toBe('blocked');
  });

  it.each(['cancelled', 'failed', 'needs_reconciliation'])('preserves authoritative %s outcomes', status => {
    const projected = projectTranscriptActivity([message], new Map([['message-1', 'run-1']]), [invocation], [{ ...action, status, resultJson: null }]);
    expect(projected[0].toolEvents?.[0].status).toBe(status === 'failed' ? 'error' : status);
    expect(projected[0].toolEvents?.[0].summary).toBeUndefined();
  });

  it('does not infer completion when execution evidence is absent', () => {
    expect(projectTranscriptActivity([message], new Map(), [invocation], [action])[0].toolEvents?.[0].status).toBe('started');
  });

  it('does not expose the journal authorization block payload as a public summary', () => {
    const projected = projectTranscriptActivity([message], new Map([['message-1', 'run-1']]),
      [{ ...invocation, resultJson: JSON.stringify({ summary: 'INTERNAL_BLOCK_PAYLOAD' }) }], []);
    expect(projected[0].toolEvents?.[0]).toMatchObject({ status: 'blocked' });
    expect(projected[0].toolEvents?.[0].summary).toBeUndefined();
  });

  it('does not select an arbitrary execution when one run reused the same call ID', () => {
    const projected = projectTranscriptActivity([message], new Map([['message-1', 'run-1']]),
      [invocation, { ...invocation, id: 'inv-2', status: 'completed' }], [action]);
    expect(projected[0].toolEvents?.[0].status).toBe('started');
  });

  it('removes the obsolete confirmation badge from a settled card', () => {
    const t = createTranslator('zh-CN');
    const markup = renderToStaticMarkup(createElement(ConfirmationCard, {
      action: { actionId: 'action-1', toolName: 'list_subscriptions', title: 'Read active subscriptions.', tier: 'YELLOW', fields: [], requiresMfa: false },
      status: 'executed',
    }));
    expect(markup).toContain(t('cards.terminal.executed'));
    expect(markup).not.toContain(t('ui.riskYellow'));
    expect(markup).not.toContain('<button');
  });

  it('restores an authorized result card on its original call instead of the later narration', () => {
    const narration: ChatMessage = { id: 'narration', role: 'assistant', content: 'Subscriptions read', timestamp: 2 };
    const evidence = { ...action, resultJson: JSON.stringify({ ok: true, data: [] }) };
    const runs = new Map([['message-1', 'run-1'], ['narration', 'authorization-run']]);
    const view = projectTranscriptActivity([message, narration], runs, [invocation], [evidence]);
    expect(view[0].role).toBe('tool');
    expect(view[0].cards).toEqual([{ type: 'subscriptions', data: [] }]);
    expect(view[1].cards).toBeUndefined();
    expect(projectTranscriptActivity(view, runs, [invocation], [evidence])[0].cards).toHaveLength(1);
    expect(narration.cards).toBeUndefined();
  });

  it('uses the original model response identity when one run reused a provider call ID', () => {
    const sources = [10, 20].map(timestamp => fauxAssistantMessage([
      fauxToolCall('list_subscriptions', {}, { id: 'call-1' }),
    ], { timestamp, stopReason: 'toolUse' }));
    const entries: ChatMessage[] = sources.map((source, index) => {
      const id = toolPresentationId('run-1', `model-${index}`, 'call-1');
      return { id, role: 'tool', content: '', timestamp: source.timestamp,
        toolEvents: [{ toolCallId: 'call-1', toolName: 'list_subscriptions', messageId: id, status: 'started' }] };
    });
    const evidence = sources.map((_source, index) => ({ ...invocation, id: `inv-${index}`, status: 'completed',
      modelRequestId: `model-${index}`, resultJson: JSON.stringify({ ok: true, data: [{ id: `result-${index}` }] }) }));
    const view = projectTranscriptActivity(entries, new Map(entries.map(entry => [entry.id, 'run-1'])), evidence, []);
    expect(view[0].cards).toEqual([{ type: 'subscriptions', data: [{ id: 'result-0' }] }]);
    expect(view[1].cards).toEqual([{ type: 'subscriptions', data: [{ id: 'result-1' }] }]);
    expect(view.every(entry => entry.toolEvents?.[0].status === 'success')).toBe(true);
  });

  it('does not select a result when the same durable model/call identity has conflicting invocations', () => {
    const id = toolPresentationId('run-1', 'model-1', 'call-1');
    const row: ChatMessage = { id, role: 'tool', content: '', timestamp: 1,
      toolEvents: [{ toolCallId: 'call-1', toolName: 'list_subscriptions', messageId: id, status: 'started' }] };
    const evidence = { ...invocation, modelRequestId: 'model-1', status: 'completed',
      resultJson: JSON.stringify({ ok: true, data: [] }) };
    const view = projectTranscriptActivity([row], new Map([[id, 'run-1']]), [evidence, { ...evidence, id: 'duplicate' }], []);
    expect(view[0].toolEvents?.[0].status).toBe('started');
    expect(view[0].cards).toBeUndefined();
  });
});

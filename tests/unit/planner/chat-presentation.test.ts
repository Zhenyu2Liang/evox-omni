import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantMarkdown, safeMarkdownUrl } from '@/components/chat/AssistantMarkdown';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { StreamingText } from '@/components/chat/StreamingText';
import { ToolEventList } from '@/components/chat/ToolEventList';
import { groupToolActivity } from '@/components/chat/toolActivity';
import type { ChatMessage, ToolEventView } from '@/lib/contracts/agent';
import { ApprovalRequest } from '@/components/chat/ApprovalRequest';
import chinese from '@/lib/i18n/messages/chat.zh-CN.json';
import displaySources from '@/lib/i18n/messages/display-sources.json';

function renderMarkdown(text: string): string {
  return renderToStaticMarkup(createElement(AssistantMarkdown, { text }));
}

describe('assistant Markdown presentation', () => {
  it('renders structured text and exact financial values without numeric conversion', () => {
    const markup = renderMarkdown([
      '## Account summary', '', '**Available:** 92233720368547758.07', '',
      '- Check transactions', '- Review recipients', '',
      '| Account | Amount |', '| --- | --- |', '| Cash | -0.07 |', '',
      '```text', 'balance = 92233720368547758.07', '```',
    ].join('\n'));
    expect(markup).toContain('<h3');
    expect(markup).toContain('<strong>Available:</strong>');
    expect(markup).toContain('<ul');
    expect(markup).toContain('<table');
    expect(markup).toContain('<pre');
    expect(markup).toContain('92233720368547758.07');
    expect(markup).toContain('-0.07');
  });

  it('disables raw HTML, active URL schemes, protocol-relative links and external images', () => {
    const markup = renderMarkdown([
      '<script>window.exfiltrate()</script>', '',
      '<img src="https://example.test/raw-image" onerror="window.exfiltrate()">', '',
      '[Unsafe](javascript:alert%281%29)', '', '[Network](//example.test/path)', '',
      '![Receipt](https://example.test/tracking-image)',
    ].join('\n'));
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('src=');
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('onerror');
    expect(markup).toContain('Receipt');
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'vbscript:execute(1)', 'file:///secret', '//example.test/path'])
    ('rejects unsafe URL %s', value => {
      expect(safeMarkdownUrl(value)).toBe('');
    });

  it.each(['https://example.test/path', 'http://example.test/path', 'mailto:help@example.test', '/runs', '#details'])
    ('retains supported URL %s', value => {
      expect(safeMarkdownUrl(value)).toBe(value);
    });

  it('opens explicit links with browser isolation and renders disabled task checkboxes', () => {
    const markup = renderMarkdown('[Help](https://example.test/help)\n\n- [x] Reviewed');
    expect(markup).toContain('href="https://example.test/help"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('disabled=""');
  });

  it('keeps user input literal and identifies the assistant text independently of paragraphs', () => {
    const text = '**Keep literal** <script>alert(1)</script>';
    const user = renderToStaticMarkup(createElement(MessageBubble, {
      message: { id: 'user-1', role: 'user', content: text, timestamp: 1 },
    }));
    expect(user).toContain('**Keep literal**');
    expect(user).toContain('&lt;script&gt;');
    expect(user).not.toContain('<strong>');
    expect(user).not.toContain('data-assistant-content');
    const assistant = renderToStaticMarkup(createElement(MessageBubble, {
      message: { id: 'assistant-1', role: 'assistant', content: '**Rendered**', timestamp: 1 },
    }));
    expect(assistant).toContain('data-message-role="assistant"');
    expect(assistant).toContain('data-message-id="assistant-1"');
    expect(assistant).toContain('data-assistant-content="true"');
    expect(assistant).toContain('<strong>Rendered</strong>');
  });

  it('uses the same safe Markdown renderer for partial text and preserves working feedback', () => {
    const streaming = renderToStaticMarkup(createElement(StreamingText, { text: '**Account** 0.07', active: true }));
    expect(streaming).toContain('<strong>Account</strong>');
    expect(streaming).toContain('0.07');
    const empty = renderToStaticMarkup(createElement(StreamingText, { text: '', active: true }));
    expect(empty).toContain(chinese['chat.working']);
  });
});

describe('banking tool activity presentation', () => {
  it('renders a distinct business result entry before the independent Markdown reply', () => {
    const result: ChatMessage = { id: 'query-row', role: 'tool', content: '', timestamp: 1,
      toolEvents: [{ messageId: 'query-row', toolCallId: 'query-call', toolName: 'list_subscriptions', status: 'success',
        debugArguments: { internal: 'private-parameter' } }], cards: [{ type: 'subscriptions', data: [] }] };
    const reply: ChatMessage = { id: 'analysis-row', role: 'assistant', content: '**Separate analysis**', timestamp: 2 };
    const markup = renderToStaticMarkup(createElement('div', null,
      createElement(MessageBubble, { message: result }), createElement(MessageBubble, { message: reply })));
    expect(markup.indexOf('data-message-id="query-row"')).toBeLessThan(markup.indexOf('data-message-id="analysis-row"'));
    const toolMarkup = markup.slice(0, markup.indexOf('data-message-id="analysis-row"'));
    expect(toolMarkup).toContain('data-chat-card-type="subscriptions"');
    expect(toolMarkup).toContain(chinese['chat.tool.list_subscriptions']);
    expect(toolMarkup).not.toContain('data-assistant-content');
    expect(markup).toContain('<strong>Separate analysis</strong>');
    expect(markup).not.toContain('list_subscriptions');
    expect(markup).not.toContain('private-parameter');
  });

  it('does not reinterpret mixed assistant metadata as tool result rows', () => {
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message: {
      id: 'prose', role: 'assistant', content: 'Keep the complete prose.', timestamp: 1,
      cards: [{ type: 'subscriptions', data: [] }],
      toolEvents: [{ toolCallId: 'call', toolName: 'list_subscriptions', status: 'success' }],
    } }));
    expect(markup).toContain('Keep the complete prose.');
    expect(markup).not.toContain('data-chat-card-type');
    expect(markup).not.toContain('data-tool-call-id');
  });

  it('keeps historical authorization read-only and renders the active request separately', () => {
    const summary = { actionId: 'action', title: 'Freeze card', toolName: 'freeze_card' as const,
      tier: 'RED' as const, fields: [], requiresMfa: true };
    const pending = { kind: 'mfa' as const, summary, actionId: 'action' };
    const row: ChatMessage = { id: 'freeze-row', role: 'tool', content: '', timestamp: 1,
      cards: [{ type: 'mfa', actionId: 'action', action: summary }],
      toolEvents: [{ messageId: 'freeze-row', toolCallId: 'freeze-call', toolName: 'freeze_card', status: 'blocked' }] };
    const history = renderToStaticMarkup(createElement(MessageBubble, { message: row, action: { onVerify: () => undefined } }));
    expect(history).toContain('data-approval-history="true"');
    expect(history).toContain('data-status="awaiting_mfa"');
    expect(history).not.toContain('<input');
    expect(history).not.toContain('<button');
    const request = renderToStaticMarkup(createElement(ApprovalRequest, { pending, action: { onVerify: () => undefined } }));
    expect(request).toContain('data-approval-request="true"');
    expect(request).toContain('data-action-id="action"');
    expect(request).toContain('<input');
    expect(request).toContain('<button');
  });

  it('keeps distinct executions and replaces progress by the latest result for each call', () => {
    const events: ToolEventView[] = [
      { toolCallId: 'balance-1', toolName: 'get_balance', status: 'started' },
      { toolCallId: 'payment-1', toolName: 'transfer_money', status: 'blocked', tier: 'YELLOW', actionId: 'payment-action' },
      { toolCallId: 'balance-1', toolName: 'get_balance', status: 'success', summary: 'Balance 92233720368547758.07' },
      { toolCallId: 'balance-2', toolName: 'get_balance', status: 'success', summary: 'Balance -0.07' },
    ];
    const groups = groupToolActivity(events);
    expect(groups.map(group => group.category)).toEqual(['query', 'payment']);
    expect(groups[0].events.map(event => event.toolCallId)).toEqual(['balance-1', 'balance-2']);
    expect(groups[0].events[0].status).toBe('success');
    const markup = renderToStaticMarkup(createElement(ToolEventList, { events }));
    expect(markup).toContain('data-tool-category="query"');
    expect(markup).toContain('data-tool-category="payment"');
    expect(markup).toContain('data-tool-call-id="payment-1"');
    expect(markup).toContain('data-tool-status="blocked"');
    expect(markup).toContain(chinese['chat.activity.status.blocked']);
    expect(markup).toContain('92233720368547758.07');
    expect(markup).toContain('-0.07');
    expect(markup).not.toContain('<details');
  });

  it('shows card and investment activities without exposing arbitrary private fields', () => {
    const events = [
      { toolCallId: 'card-1', toolName: 'freeze_card', status: 'success', summary: 'Card frozen', arguments: { password: 'private-secret' } },
      { toolCallId: 'investment-1', toolName: 'subscribe_investment', status: 'error', summary: 'Purchase failed' },
      { toolCallId: 'workflow-1', toolName: 'submit_plan', status: 'updated' },
    ] as ToolEventView[];
    const markup = renderToStaticMarkup(createElement(ToolEventList, { events }));
    expect(markup).toContain('data-tool-category="card"');
    expect(markup).toContain('data-tool-category="investment"');
    expect(markup).toContain('data-tool-category="workflow"');
    expect(markup).toContain(chinese['chat.activity.status.error']);
    expect(markup).toContain(chinese['chat.activity.status.updated']);
    expect(markup).not.toContain('private-secret');
    expect(markup).not.toContain('arguments');
  });

  it('uses a business fallback for unknown tool metadata and never guesses a monetary result', () => {
    const markup = renderToStaticMarkup(createElement(ToolEventList, { events: [
      { toolCallId: 'unknown-1', toolName: 'future_tool', status: 'started', label: '<script>Unknown</script>' },
    ] }));
    expect(markup).toContain('data-tool-category="workflow"');
    expect(markup).toContain(chinese['chat.activity.unknown']);
    expect(markup).not.toContain('Unknown');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('0.00');
  });

  it('shows an actionable explanation instead of internal conversation guard instructions', () => {
    const source = Object.entries(displaySources.errors).find(([, key]) => key === 'chat.error.newBankingRequest')?.[0];
    expect(source).toBeDefined();
    const markup = renderToStaticMarkup(createElement(ToolEventList, { events: [
      { toolCallId: 'guard-1', toolName: 'submit_plan', status: 'blocked', summary: source },
    ] }));
    expect(markup).toContain(chinese['chat.error.newBankingRequest']);
    expect(markup).not.toContain(source);
    expect(markup).not.toContain('Do not resume an earlier write');
    expect(markup).toContain(chinese['chat.activity.status.notExecuted']);
    expect(markup).not.toContain(chinese['chat.activity.status.blocked']);
  });
});

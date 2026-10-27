import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isVisibleChatMessage, messageDay, MessageDayDivider } from '@/components/chat/message-day';
import type { ChatMessage } from '@/lib/contracts/agent';

describe('chat calendar presentation', () => {
  it('changes date at midnight in Asia/Shanghai instead of UTC', () => {
    expect(messageDay(Date.parse('2026-10-26T15:59:59Z'))).toBe('2026-10-26');
    expect(messageDay(Date.parse('2026-10-26T16:00:00Z'))).toBe('2026-10-27');
    expect(messageDay(Date.parse('2026-10-27T00:00:00Z'))).toBe('2026-10-27');
  });

  it('keeps historical dates absolute instead of depending on the current or simulated clock', () => {
    expect(messageDay(Date.parse('2026-09-25T04:00:00Z'))).toBe('2026-09-25');
    expect(messageDay(NaN)).toBeUndefined();
    expect(messageDay(Infinity)).toBeUndefined();
  });

  it('does not use an empty suppressed authorization as a day boundary', () => {
    const empty: ChatMessage = { id: 'a', role: 'tool', content: '', timestamp: 0, cards: [], toolEvents: [] };
    expect(isVisibleChatMessage(empty)).toBe(false);
    expect(isVisibleChatMessage({ ...empty, cards: [{ type: 'error', message: 'Blocked' }] })).toBe(true);
    expect(isVisibleChatMessage({ ...empty, role: 'system', content: 'Account locked' })).toBe(true);
    expect(isVisibleChatMessage({ ...empty, role: 'assistant', content: 'A reply' })).toBe(true);
  });

  it('exposes a semantic date without impersonating an archived message', () => {
    const html = renderToStaticMarkup(createElement(MessageDayDivider, { day: '2026-10-27' }));
    expect(html).toContain('dateTime="2026-10-27"');
    expect(html).toContain('data-chat-day="2026-10-27"');
    expect(html).not.toContain('data-message-id');
  });
});

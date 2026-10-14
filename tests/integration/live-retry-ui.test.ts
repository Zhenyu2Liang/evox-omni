import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatWindow } from '@/components/chat/ChatWindow';
import type { ChatMessage } from '@/lib/contracts/agent';
import { DEFAULT_LOCALE, translate } from '@/lib/i18n/shared';

const retry: ChatMessage = { id: 'retry-reply', role: 'assistant', content: '规划未完成', timestamp: 1, retryRequest: '给张伟转账200.37元' };
const retryButton = `${translate(DEFAULT_LOCALE, 'chat.retryPlanning')}</button>`;
describe('planning retry presentation (server render)', () => {
  it('offers the server-issued retry on the latest reply, including after refresh', () => {
    expect(renderToStaticMarkup(createElement(ChatWindow, { initialMessages: [retry] }))).toContain(retryButton);
  });
  it('retires the old retry button as soon as another user request starts', () => {
    const next: ChatMessage = { id: 'next-user', role: 'user', content: '查询余额', timestamp: 2 };
    expect(renderToStaticMarkup(createElement(ChatWindow, { initialMessages: [retry, next] }))).not.toContain(retryButton);
  });
  it('does not offer a retry for an ordinary successful server reply', () => {
    const { retryRequest, ...completed } = retry;
    expect(renderToStaticMarkup(createElement(ChatWindow, { initialMessages: [completed] }))).not.toContain(retryButton);
  });
});

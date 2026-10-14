import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '@/components/chat/Composer';

describe('server-rendered composer readiness', () => {
  it('cannot submit a native form before client handlers are ready', () => {
    const send = vi.fn();
    const html = renderToStaticMarkup(createElement(Composer, { onSend: send }));
    expect(html).toMatch(/<textarea[^>]*data-chat-ready="false"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(send).not.toHaveBeenCalled();
  });
});

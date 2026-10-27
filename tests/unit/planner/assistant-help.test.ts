import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUIDE_SEEN_KEY, hasSeenGuide, rememberGuideClosed } from '@/components/help/guide-preference';
import { AssistantHelpButton, AssistantHelpProvider } from '@/components/help/AssistantHelp';

afterEach(() => vi.unstubAllGlobals());

function browserPreference({ stored = null, cookie = '', blocked = false, secure = false }: { stored?: string | null; cookie?: string; blocked?: boolean; secure?: boolean } = {}) {
  const storage = { getItem: vi.fn(() => stored), setItem: vi.fn() };
  const document = { cookie };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', { get localStorage() { if (blocked) throw new Error('Storage blocked'); return storage; }, location: { protocol: secure ? 'https:' : 'http:' } });
  return { storage, document };
}

describe('assistant guide preference', () => {
  it('opens for a new browser and recognizes only the explicit dismissed value', () => {
    browserPreference(); expect(hasSeenGuide()).toBe(false);
    browserPreference({ stored: '0' }); expect(hasSeenGuide()).toBe(false);
    browserPreference({ stored: '1' }); expect(hasSeenGuide()).toBe(true);
  });
  it('uses an exact cookie fallback when local storage is blocked', () => {
    browserPreference({ cookie: 'banking_guide_seen=10', blocked: true }); expect(hasSeenGuide()).toBe(false);
    browserPreference({ cookie: 'locale=en; banking_guide_seen=1', blocked: true }); expect(hasSeenGuide()).toBe(true);
  });
  it('stores only the preference and scopes its fallback to this browser origin', () => {
    const { storage, document } = browserPreference({ secure: true });
    rememberGuideClosed();
    expect(storage.setItem).toHaveBeenCalledWith(GUIDE_SEEN_KEY, '1');
    expect(document.cookie).toBe('banking_guide_seen=1; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  });
  it('still records dismissal if local storage is unavailable', () => {
    const { document } = browserPreference({ blocked: true });
    expect(() => rememberGuideClosed()).not.toThrow();
    expect(document.cookie).toContain('banking_guide_seen=1');
  });
  it('keeps help usable when both preference stores are blocked', () => {
    browserPreference({ blocked: true });
    vi.stubGlobal('document', { get cookie() { throw new Error('Cookies blocked'); }, set cookie(_value: string) { throw new Error('Cookies blocked'); } });
    expect(hasSeenGuide()).toBe(false);
    expect(() => rememberGuideClosed()).not.toThrow();
  });
  it('server-renders a closed semantic guide without accessing browser APIs', () => {
    const html = renderToStaticMarkup(createElement(AssistantHelpProvider, { active: true, children: createElement(AssistantHelpButton) }));
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-labelledby="assistant-guide-title"');
    expect(html).not.toMatch(/<dialog[^>]*\bopen[ =>]/);
    expect(html.match(/data-help-example=/g)).toHaveLength(6);
    expect(html).toContain('检查到期');
    expect(html).toContain('不会转出真实资金');
  });
});

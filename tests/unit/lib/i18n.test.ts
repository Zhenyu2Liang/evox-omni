import { describe, expect, it } from 'vitest';
import appEnglish from '@/lib/i18n/messages/app.en.json';
import appChinese from '@/lib/i18n/messages/app.zh-CN.json';
import chatEnglish from '@/lib/i18n/messages/chat.en.json';
import chatChinese from '@/lib/i18n/messages/chat.zh-CN.json';
import businessEnglish from '@/lib/i18n/messages/business.en.json';
import businessChinese from '@/lib/i18n/messages/business.zh-CN.json';
import pagesEnglish from '@/lib/i18n/messages/pages.en.json';
import pagesChinese from '@/lib/i18n/messages/pages.zh-CN.json';
import { createTranslator, DEFAULT_LOCALE, resolveLocale, translate } from '@/lib/i18n/shared';

const catalogs: { name: string; english: Record<string, string>; chinese: Record<string, string> }[] = [
  { name: 'app', english: appEnglish, chinese: appChinese },
  { name: 'chat', english: chatEnglish, chinese: chatChinese },
  { name: 'business', english: businessEnglish, chinese: businessChinese },
  { name: 'pages', english: pagesEnglish, chinese: pagesChinese },
];

function placeholders(template: string): string[] {
  return Array.from(template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), match => match[1]).sort();
}

describe('localized catalog integrity', () => {
  for (const catalog of catalogs) {
    it(`${catalog.name} provides matching keys and interpolation parameters`, () => {
      const englishKeys = Object.keys(catalog.english).sort();
      const chineseKeys = Object.keys(catalog.chinese).sort();
      expect(chineseKeys).toEqual(englishKeys);
      expect(englishKeys.length).toBeGreaterThan(0);
      for (const key of englishKeys) {
        expect(catalog.english[key].trim(), `${key}: English text`).not.toBe('');
        expect(catalog.chinese[key].trim(), `${key}: Chinese text`).not.toBe('');
        expect(placeholders(catalog.chinese[key]), `${key}: placeholders`).toEqual(placeholders(catalog.english[key]));
      }
    });
  }

  it('does not silently overwrite a key from another catalog', () => {
    const seen = new Set<string>();
    for (const catalog of catalogs) {
      for (const key of Object.keys(catalog.english)) {
        expect(seen.has(key), `${catalog.name}: duplicate ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe('application locale selection', () => {
  it.each([undefined, null, '', 'zh-CN', 'en-US', 'fr', 1, {}])('defaults unsupported or missing locale %j to Chinese', value => {
    expect(resolveLocale(value)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(value)).toBe('zh-CN');
  });

  it('uses English only when explicitly selected', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(createTranslator('en')('app.assistant')).toBe(appEnglish['app.assistant']);
    expect(createTranslator('zh-CN')('app.assistant')).toBe(appChinese['app.assistant']);
  });
});

describe('localized interpolation', () => {
  it.each(['en', 'zh-CN'] as const)('preserves exact financial strings in %s templates', locale => {
    const amount = '92233720368547758.07';
    const text = translate(locale, 'pages.bills.summary', {
      month: '2026-09', transactions: 12, anomalies: 1, total: amount,
    });
    expect(text).toContain(amount);
    expect(text).not.toContain('92233720368547760');
    expect(text).not.toMatch(/\{(?:month|transactions|anomalies|total)\}/);
  });

  it('treats zero as an explicit interpolation value', () => {
    expect(translate('en', 'pages.subscriptions.itemCount', { count: 0 })).toBe('0 items');
  });

  it('preserves missing placeholders instead of substituting undefined', () => {
    expect(translate('en', 'pages.subscriptions.itemCount')).toBe('{count} items');
  });
});

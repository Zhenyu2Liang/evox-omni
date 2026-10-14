import appEnglish from './messages/app.en.json';
import appChinese from './messages/app.zh-CN.json';
import chatEnglish from './messages/chat.en.json';
import chatChinese from './messages/chat.zh-CN.json';
import businessEnglish from './messages/business.en.json';
import businessChinese from './messages/business.zh-CN.json';
import pagesEnglish from './messages/pages.en.json';
import pagesChinese from './messages/pages.zh-CN.json';

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const LOCALE_COOKIE = 'banking_locale';

const english = { ...appEnglish, ...chatEnglish, ...businessEnglish, ...pagesEnglish };
export type MessageKey = keyof typeof english;
export type MessageParams = Record<string, string | number>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;
export const messages: Record<Locale, Record<MessageKey, string>> = {
  en: english,
  'zh-CN': { ...appChinese, ...chatChinese, ...businessChinese, ...pagesChinese },
};

/** Allow known enum display keys while retaining unknown server values as facts. */
export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(english, value);
}

/** The product defaults to Chinese regardless of the browser's preferred language. */
export function resolveLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : DEFAULT_LOCALE;
}

/** Interpolate complete templates without converting financial strings to binary numbers. */
export function translate(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  return messages[locale][key].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
    return Object.hasOwn(params, name) ? String(params[name]) : placeholder;
  });
}

export function createTranslator(locale: Locale): Translator {
  return (key, params) => translate(locale, key, params);
}

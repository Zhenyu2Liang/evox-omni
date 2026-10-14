'use client';

import { createContext, useContext, useEffect, useMemo, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { createTranslator, DEFAULT_LOCALE, LOCALE_COOKIE, resolveLocale, type Locale, type Translator } from './shared';

interface I18nContextValue {
  locale: Locale;
  t: Translator;
  setLocale: (locale: Locale) => void;
  pending: boolean;
}

const DEFAULT_CONTEXT: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  t: createTranslator(DEFAULT_LOCALE),
  setLocale: () => undefined,
  pending: false,
};
const I18nContext = createContext<I18nContextValue>(DEFAULT_CONTEXT);

export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, updateLocale] = useState(initialLocale);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    t: createTranslator(locale),
    pending,
    setLocale: (requestedLocale) => {
      const nextLocale = resolveLocale(requestedLocale);
      if (nextLocale === locale) return;
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${LOCALE_COOKIE}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
      updateLocale(nextLocale);
      // Refresh server components without remounting the chat or resubmitting any operation.
      startTransition(() => router.refresh());
    },
  }), [locale, pending, router]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Standalone presentational components use the product's Chinese default. */
export function useI18n() {
  return useContext(I18nContext);
}

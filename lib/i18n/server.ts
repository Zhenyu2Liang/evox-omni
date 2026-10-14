import { cache } from 'react';
import { cookies } from 'next/headers';
import { createTranslator, LOCALE_COOKIE, resolveLocale } from './shared';

/** Resolve the same validated preference for the document and every server-rendered page. */
export const getServerI18n = cache(async () => {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);
  return { locale, t: createTranslator(locale) };
});

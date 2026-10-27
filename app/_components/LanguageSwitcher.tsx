'use client';

import { useI18n } from '@/lib/i18n/LocaleProvider';
import { resolveLocale } from '@/lib/i18n/shared';

export default function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, t, setLocale, pending } = useI18n();
  return (
    <label className={`flex items-center gap-2 text-xs text-banking-navy ${compact ? '' : 'justify-between'}`}>
      <span className={compact ? 'sr-only' : ''}>{t('app.language')}</span>
      <select aria-label={t('app.language')} data-locale-switcher="true" value={locale} disabled={pending}
        onChange={event => setLocale(resolveLocale(event.target.value))}
        className="min-h-9 rounded-lg border border-banking-border bg-banking-surface px-2 text-xs text-banking-deep outline-hidden focus-visible:ring-2 focus-visible:ring-banking-accent/40 disabled:opacity-60">
        <option value="zh-CN">{t('app.languageChinese')}</option>
        <option value="en">{t('app.languageEnglish')}</option>
      </select>
    </label>
  );
}

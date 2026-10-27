'use client';

import { useI18n } from '@/lib/i18n/LocaleProvider';
import { useTheme } from '@/lib/theme/ThemeProvider';
import { resolveTheme } from '@/lib/theme/shared';

export default function ThemeSwitcher() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  return <label className="flex items-center justify-between gap-2 text-xs text-banking-navy">
    <span>{t('app.appearance')}</span>
    <select data-theme-switcher aria-label={t('app.appearance')} value={theme}
      onChange={event => setTheme(resolveTheme(event.target.value))}
      className="min-h-9 rounded-lg border border-banking-border bg-banking-surface px-2 text-xs text-banking-deep outline-hidden focus-visible:ring-2 focus-visible:ring-banking-accent/40">
      <option value="system">{t('app.themeSystem')}</option>
      <option value="light">{t('app.themeLight')}</option>
      <option value="dark">{t('app.themeDark')}</option>
    </select>
  </label>;
}

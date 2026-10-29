'use client';

import Link from 'next/link';
import { BrandMark } from '@/components/ui/BrandMark';
import ThemeSwitcher from './ThemeSwitcher';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import LanguageSwitcher from './LanguageSwitcher';
import NavigationIcon from './NavigationIcon';
import { isNavigationActive, getNavigationGroups } from './navigation';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import DeveloperTools, { DeveloperModeToggle } from './DeveloperTools';

export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <Link href="/agent" data-brand-link onClick={onNavigate} className="flex min-w-0 items-center gap-3 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent">
      <BrandMark width={44} height={40} className="h-10 w-11 shrink-0 object-contain" />
      <span className="min-w-0">
        <span className="block text-xl font-semibold tracking-[0.08em] text-banking-deep">{t('app.brand')}</span>
        <span className="mt-0.5 block text-[11px] font-semibold tracking-[0.22em] text-banking-navy">{t('app.brandDescription')}</span>
      </span>
    </Link>
  );
}

export default function SidebarNavigation({ pathname, onNavigate, userName }: { pathname: string; onNavigate?: () => void; userName?: string }) {
  const { t } = useI18n();
  const { enabled } = useDeveloperMode();
  const displayName = userName?.trim() || t('app.currentUser');
  return (
    <>
      <nav aria-label={t('app.mainNavigation')} className="min-h-0 flex-1 space-y-7 overflow-y-auto px-4 py-5">
        {getNavigationGroups(enabled).map((group) => (
          <section key={group.labelKey} aria-label={t(group.labelKey)}>
            <p className="mb-2 px-3 text-xs font-semibold tracking-wide text-banking-navy">{t(group.labelKey)}</p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const active = isNavigationActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent ${active ? 'bg-banking-neutral font-semibold text-banking-interactive' : 'font-medium text-banking-navy hover:bg-banking-subtle hover:text-banking-deep'}`}>
                      <NavigationIcon name={item.icon} />
                      <span>{t(item.labelKey)}</span>
                      {active && <span aria-hidden="true" className="ml-auto h-1.5 w-1.5 rounded-full bg-banking-accent" />}
                    </Link>
                  </li>
                );
              })}
            </ul>
            {group.developerOnly && <DeveloperTools onNavigate={onNavigate} />}
          </section>
        ))}
      </nav>
      <div className="space-y-2 border-t border-banking-border px-5 pt-3"><LanguageSwitcher /><ThemeSwitcher /><DeveloperModeToggle /></div>
      <div data-current-user className="m-4 flex min-w-0 items-center gap-3 rounded-2xl border border-banking-border bg-banking-light p-3.5" aria-label={t('app.currentUser')}>
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-banking-blue-soft text-base font-semibold text-banking-blue">{Array.from(displayName)[0]}</span>
        <p className="min-w-0 truncate text-sm font-semibold text-banking-deep" title={displayName}>{displayName}</p>
      </div>
    </>
  );
}

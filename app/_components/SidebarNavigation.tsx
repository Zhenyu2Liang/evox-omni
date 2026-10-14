'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import LanguageSwitcher from './LanguageSwitcher';
import NavigationIcon from './NavigationIcon';
import { isNavigationActive, getNavigationGroups } from './navigation';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import DeveloperTools, { DeveloperModeToggle } from './DeveloperTools';

export function Brand({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <Link href="/agent" onClick={onNavigate} className="flex min-w-0 items-center gap-3 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-banking-deep text-white">
        <NavigationIcon name="assistant" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold tracking-tight text-banking-deep">{t('app.brand')}</span>
        <span className="block text-xs text-banking-navy">{t('app.brandDescription')}</span>
      </span>
    </Link>
  );
}

export default function SidebarNavigation({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const { t } = useI18n();
  const { enabled } = useDeveloperMode();
  return (
    <>
      <nav aria-label={t('app.mainNavigation')} className="min-h-0 flex-1 space-y-7 overflow-y-auto px-4 py-5">
        {getNavigationGroups(enabled).map((group) => (
          <section key={group.labelKey} aria-label={t(group.labelKey)}>
            <p className="mb-2 px-3 text-[11px] font-semibold tracking-wide text-banking-navy/80">{t(group.labelKey)}</p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const active = isNavigationActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent ${active ? 'bg-banking-accent/10 font-semibold text-banking-accent' : 'font-medium text-banking-navy hover:bg-slate-100 hover:text-banking-deep'}`}>
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
      <div className="space-y-2 border-t border-slate-200 px-5 pt-3"><LanguageSwitcher /><DeveloperModeToggle /></div>
      <div className="m-4 rounded-2xl border border-slate-200 bg-banking-light p-3.5">
        <p className="flex items-center gap-2 text-xs font-semibold text-banking-deep"><span aria-hidden="true" className="h-2 w-2 rounded-full bg-banking-accent" />{t('app.demoWorkspace')}</p>
        <p className="mt-1.5 text-xs leading-5 text-banking-navy">{t('app.demoDescription')}</p>
      </div>
    </>
  );
}

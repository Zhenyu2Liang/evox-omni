'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import LanguageSwitcher from './LanguageSwitcher';
import SidebarNavigation, { Brand } from './SidebarNavigation';
import { getNavigationTitle } from './navigation';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const closeMenu = () => dialogRef.current?.close();

  useEffect(() => {
    dialogRef.current?.close();
  }, [pathname]);

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const handleResize = () => {
      if (desktopQuery.matches) dialogRef.current?.close();
    };
    desktopQuery.addEventListener('change', handleResize);
    return () => desktopQuery.removeEventListener('change', handleResize);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => {
      if (viewport.scale === 1) {
        document.documentElement.style.setProperty('--workspace-viewport-height', `${viewport.height}px`);
      }
    };
    resize();
    viewport.addEventListener('resize', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      document.documentElement.style.removeProperty('--workspace-viewport-height');
    };
  }, []);

  return (
    <div className="min-h-dvh lg:flex">
      <a href="#workspace" className="sr-only z-50 rounded-xl bg-white px-4 py-3 text-banking-deep shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-4">{t('app.skipContent')}</a>
      <aside aria-label={t('app.sidebar')} className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-slate-200/80 bg-white lg:flex">
        <div className="px-7 pb-4 pt-7"><Brand /></div>
        <SidebarNavigation pathname={pathname} />
      </aside>

      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur-sm lg:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" aria-label={t('app.openNavigation')} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => { dialogRef.current?.showModal(); setMenuOpen(true); }} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-banking-deep hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="truncate text-sm font-semibold text-banking-deep">{getNavigationTitle(pathname, t)}</span>
        </div>
        <LanguageSwitcher compact />
      </header>

      <dialog id="mobile-navigation" ref={dialogRef} aria-label={t('app.mobileNavigation')} onClose={() => setMenuOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) closeMenu(); }} className="mobile-navigation h-dvh w-[min(20rem,calc(100vw-3rem))] border-r border-slate-200 bg-white p-0 text-banking-deep">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5">
            <Brand onNavigate={closeMenu} />
            <button type="button" aria-label={t('app.closeNavigation')} onClick={closeMenu} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-banking-navy hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
          <SidebarNavigation pathname={pathname} onNavigate={closeMenu} />
        </div>
      </dialog>

      <div id="workspace" tabIndex={-1} className="min-w-0 flex-1 outline-hidden">{children}</div>
    </div>
  );
}

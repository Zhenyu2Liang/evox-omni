'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { hasSeenGuide, rememberGuideClosed } from './guide-preference';

type ExampleHandler = (text: string) => void;
interface HelpContextValue {
  openHelp: () => void;
  registerComposer: (handler: ExampleHandler | undefined) => () => void;
}
const HelpContext = createContext<HelpContextValue | undefined>(undefined);
export function useAssistantHelp() { return useContext(HelpContext); }

export function AssistantHelpButton() {
  const help = useAssistantHelp();
  const { t } = useI18n();
  if (!help) return null;
  return <button type="button" data-assistant-help-trigger aria-haspopup="dialog" onClick={help.openHelp}
    className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-banking-accent hover:bg-banking-accent/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent">
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.4 2.4 0 0 1 4.6 1c0 1.5-2.3 1.7-2.3 3.3M12 17h.01" /></svg>
    {t('help.open')}
  </button>;
}

const FEATURES = ['accounts', 'transfer', 'investment', 'cards', 'subscriptions', 'schedules'] as const;

/** A native modal supplies focus trapping, inert background and Escape handling. */
export function AssistantHelpProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const checked = useRef(false);
  const exampleHandler = useRef<ExampleHandler | undefined>(undefined);
  const [canSelect, setCanSelect] = useState(false);
  const [open, setOpen] = useState(false);
  const [preferenceChecked, setPreferenceChecked] = useState(false);
  const openHelp = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      const body = dialog.querySelector('[data-assistant-guide-body]');
      if (body) body.scrollTop = 0;
      setOpen(true);
    }
  }, []);
  const registerComposer = useCallback((handler: ExampleHandler | undefined) => {
    exampleHandler.current = handler; setCanSelect(Boolean(handler));
    return () => {
      if (exampleHandler.current === handler) { exampleHandler.current = undefined; setCanSelect(false); }
    };
  }, []);
  const value = useMemo(() => ({ openHelp, registerComposer }), [openHelp, registerComposer]);

  useEffect(() => {
    if (!active) { dialogRef.current?.close(); return; }
    if (checked.current) return;
    checked.current = true;
    setPreferenceChecked(true);
    if (!hasSeenGuide()) openHelp();
  }, [active, openHelp]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  function dismiss() { dialogRef.current?.close(); }
  function begin() {
    dismiss();
    document.querySelector<HTMLTextAreaElement>('textarea[data-chat-composer]:enabled')?.focus();
  }
  function selectExample(text: string) {
    const handler = exampleHandler.current;
    if (!handler) return;
    dismiss(); handler(text);
  }

  return <HelpContext.Provider value={value}>
    {children}
    <dialog ref={dialogRef} data-assistant-guide data-guide-ready={preferenceChecked ? 'true' : 'false'} aria-labelledby="assistant-guide-title" aria-describedby="assistant-guide-description"
      onClose={() => { rememberGuideClosed(); setOpen(false); }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        // All interactive guide content is buttons. Cycle boundary focus rather than tabbing into browser chrome.
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const first = buttons[0]; const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      }}
      onClick={event => { if (event.target === event.currentTarget) dismiss(); }}
      className="m-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-3xl overflow-hidden rounded-3xl border border-slate-200 bg-white p-0 text-banking-deep shadow-2xl backdrop:bg-slate-950/35 backdrop:backdrop-blur-sm">
      <div className="flex max-h-[calc(100dvh-1.5rem)] flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-7">
          <div>
            <p className="mb-1 text-xs font-medium text-banking-accent">{t('help.eyebrow')}</p>
            <h2 id="assistant-guide-title" className="text-xl font-semibold tracking-tight">{t('help.title')}</h2>
            <p id="assistant-guide-description" className="mt-2 text-sm leading-6 text-banking-navy">{t('help.description')}</p>
          </div>
          <button type="button" autoFocus aria-label={t('help.close')} onClick={dismiss}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-banking-navy hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div data-assistant-guide-body className="min-h-0 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">
          <section aria-labelledby="guide-start-title">
            <h3 id="guide-start-title" className="font-semibold">{t('help.startTitle')}</h3>
            <ol className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              {(['describe', 'review', 'result'] as const).map((step, index) => <li key={step} className="rounded-2xl bg-banking-light p-3">
                <span className="mb-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs font-semibold text-banking-accent">{index + 1}</span>
                <p className="font-medium">{t(`help.step.${step}.title`)}</p>
                <p className="mt-1 text-xs leading-5 text-banking-navy">{t(`help.step.${step}.body`)}</p>
              </li>)}
            </ol>
          </section>
          <section className="mt-6" aria-labelledby="guide-features-title">
            <h3 id="guide-features-title" className="font-semibold">{t('help.featuresTitle')}</h3>
            <p className="mt-1 text-xs leading-5 text-banking-navy">{t(canSelect ? 'help.exampleHint' : 'help.examplesUnavailable')}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {FEATURES.map(feature => <article key={feature} className="flex flex-col rounded-2xl border border-slate-200/80 p-4">
                <h4 className="text-sm font-semibold">{t(`help.feature.${feature}.title`)}</h4>
                <p className="mt-1.5 flex-1 text-xs leading-5 text-banking-navy">{t(`help.feature.${feature}.body`)}</p>
                <button type="button" data-help-example={feature} disabled={!canSelect} onClick={() => selectExample(t(`help.feature.${feature}.example`))}
                  className="mt-3 min-h-11 rounded-xl bg-banking-accent/5 px-3 py-2 text-left text-xs leading-5 text-banking-accent hover:bg-banking-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent disabled:cursor-not-allowed disabled:opacity-50">
                  <span className="block font-semibold">{t('help.tryExample')}</span>{t(`help.feature.${feature}.example`)}
                </button>
              </article>)}
            </div>
          </section>
          <section className="mt-6" aria-labelledby="guide-security-title">
            <h3 id="guide-security-title" className="font-semibold">{t('help.securityTitle')}</h3>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-banking-navy">
              {(['green', 'yellow', 'red'] as const).map(tier => <li key={tier} className="flex items-start gap-2">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tier === 'green' ? 'bg-emerald-500' : tier === 'yellow' ? 'bg-amber-400' : 'bg-red-500'}`} aria-hidden="true" />
                <span>{t(`help.security.${tier}`)}</span>
              </li>)}
            </ul>
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{t('help.securityResult')}</p>
          </section>
          <aside className="mt-5 rounded-2xl bg-banking-light p-4 text-xs leading-5 text-banking-navy">
            <p className="font-semibold text-banking-deep">{t('help.demoTitle')}</p>
            <p className="mt-1">{t('help.demoBody')}</p>
          </aside>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 sm:px-7">
          <p className="text-xs leading-5 text-banking-navy">{t('help.reopenHint')}</p>
          <button type="button" onClick={begin} className="min-h-11 rounded-xl bg-banking-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-banking-accent">{t('help.begin')}</button>
        </footer>
      </div>
    </dialog>
  </HelpContext.Provider>;
}

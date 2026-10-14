'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import type { MessageKey } from '@/lib/i18n/shared';

export function DeveloperModeToggle() {
  const { t } = useI18n();
  const { enabled, pending, setEnabled } = useDeveloperMode();
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 text-xs text-banking-navy">
      <span>{t('app.developerMode')}</span>
      <button type="button" role="switch" aria-checked={enabled} aria-label={t('app.developerMode')} data-developer-toggle="true" disabled={pending} onClick={() => setEnabled(!enabled)} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent disabled:opacity-60 ${enabled ? 'bg-banking-accent' : 'bg-slate-300'}`}>
        <span aria-hidden="true" className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-xs transition-transform ${enabled ? 'left-1 translate-x-5' : 'left-1'}`} />
      </button>
    </div>
  );
}

export function DeveloperModeRequired({ titleKey = 'app.runs' }: { titleKey?: MessageKey }) {
  const { t } = useI18n();
  const { pending, setEnabled } = useDeveloperMode();
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <h1 className="text-xl font-semibold text-banking-deep">{t(titleKey)}</h1>
      <p className="mt-3 text-sm text-banking-navy">{t('app.developerRequired')}</p>
      <button type="button" disabled={pending} onClick={() => setEnabled(true)} className="mt-5 min-h-11 rounded-xl bg-banking-accent px-4 text-sm font-semibold text-white disabled:opacity-60">{t('app.enableDeveloperMode')}</button>
    </section>
  );
}

export default function DeveloperTools({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const { enabled } = useDeveloperMode();
  const pathname = usePathname();
  const router = useRouter();
  const reloadAfterNavigation = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (pathname === '/agent' && reloadAfterNavigation.current) {
      reloadAfterNavigation.current = false;
      window.location.reload();
    }
  }, [pathname]);

  const reloadConversation = () => {
    if (pathname === '/agent') window.location.reload();
    else { reloadAfterNavigation.current = true; router.push('/agent'); }
  };
  const showReset = () => {
    onNavigate?.();
    setError(null);
    dialogRef.current?.showModal();
  };
  const clearConversation = async () => {
    if (busy || !enabled) return;
    setBusy(true);
    setError(null);
    try {
      const current = await fetch('/api/developer/chat', { cache: 'no-store' });
      if (!current.ok) {
        setError(t(current.status === 403 ? 'app.developerDisabled' : 'app.chatResetFailed'));
        return;
      }
      const payload: unknown = await current.json();
      if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true || !('data' in payload) || !payload.data || typeof payload.data !== 'object' || !('revision' in payload.data) || typeof payload.data.revision !== 'number' || !Number.isSafeInteger(payload.data.revision)) {
        setError(t('app.chatResetFailed'));
        return;
      }
      const result = await fetch('/api/developer/chat/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: payload.data.revision, confirm: true }),
      });
      if (!result.ok) {
        setError(t(result.status === 409 ? 'app.chatResetBlocked' : result.status === 403 ? 'app.developerDisabled' : 'app.chatResetFailed'));
        return;
      }
      const reset: unknown = await result.json();
      if (!reset || typeof reset !== 'object' || !('ok' in reset) || reset.ok !== true) {
        setError(t('app.chatResetFailed'));
        return;
      }
      reloadConversation();
    } catch {
      setError(t('app.chatResetFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {enabled && <div className="mt-2 space-y-1" data-developer-tools="true">
        <button type="button" data-developer-refresh="true" onClick={reloadConversation} className="min-h-11 w-full rounded-xl px-3 text-left text-sm font-medium text-banking-navy hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-banking-accent">{t('app.refreshChat')}</button>
        <button type="button" data-developer-clear="true" onClick={showReset} className="min-h-11 w-full rounded-xl px-3 text-left text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400">{t('app.clearChat')}</button>
      </div>}
      {mounted && createPortal(<dialog ref={dialogRef} aria-labelledby={dialogTitleId} aria-describedby={dialogDescriptionId} data-developer-reset-dialog="true" onCancel={event => { if (busy) event.preventDefault(); }} className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-6 text-banking-deep shadow-xl backdrop:bg-slate-900/40">
        <h2 id={dialogTitleId} className="text-lg font-semibold">{t('app.clearChatTitle')}</h2>
        <p id={dialogDescriptionId} className="mt-3 text-sm leading-6 text-banking-navy">{t('app.clearChatDescription')}</p>
        {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" disabled={busy} onClick={() => dialogRef.current?.close()} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-medium disabled:opacity-60">{t('app.cancel')}</button>
          <button type="button" data-developer-confirm-clear="true" disabled={busy || !enabled} onClick={() => void clearConversation()} className="min-h-11 rounded-xl bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-60">{t(busy ? 'app.clearingChat' : 'app.confirmClearChat')}</button>
        </div>
      </dialog>, document.body)}
    </>
  );
}

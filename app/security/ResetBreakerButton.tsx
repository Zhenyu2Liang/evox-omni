'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey, MessageParams } from '@/lib/i18n/shared';

type ResetStatus =
  | { ok: boolean; key: MessageKey; params?: MessageParams }
  | { ok: false; message: string };

export function ResetBreakerButton({ className }: { className?: string }) {
  const { enabled } = useDeveloperMode();
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ResetStatus | null>(null);

  async function handleClick() {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch('/api/developer/security/reset', { method: 'POST' });
      const body = await response.json() as
        | { ok: true; data: { failures: number; max: number } }
        | { ok: false; error: { message: string } };
      if (body.ok) {
        setStatus({ ok: true, key: 'security.reset.success', params: { count: body.data.failures, max: body.data.max } });
        router.refresh();
      } else {
        setStatus(body.error.message ? { ok: false, message: body.error.message } : { ok: false, key: 'security.reset.failed' });
      }
    } catch {
      setStatus({ ok: false, key: 'security.reset.networkError' });
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  return (
    <div className={['flex flex-col items-start gap-2', className].filter(Boolean).join(' ')}>
      <p className="text-xs text-banking-navy/70">{t('security.reset.developerOnly')}</p>
      <button type="button" data-developer-breaker-reset onClick={handleClick} disabled={busy}
        className="rounded-xl bg-banking-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-banking-accent/90 disabled:cursor-not-allowed disabled:opacity-60">
        {t(busy ? 'security.reset.busy' : 'security.reset.reset')}
      </button>
      {status ? <p role="status" aria-live="polite" className={`text-sm ${status.ok ? 'text-banking-success' : 'text-banking-danger'}`}>
        {'key' in status ? t(status.key, status.params) : status.message}
      </p> : null}
    </div>
  );
}

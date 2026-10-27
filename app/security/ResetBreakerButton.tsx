'use client';

/**
 * `ResetBreakerButton` — the developer-only breaker maintenance entry of the Security Center.
 *
 * Distinct from `UnlockPanel`'s runtime unlock: this is a demo maintenance shortcut with no
 * credential (`POST /api/developer/security/reset`), visible only while developer mode is on. The
 * outer wrapper carries `data-developer-breaker-reset-panel` so browser assertions can scope
 * themselves to this widget ("there is no developer reset here") without relying on structure.
 *
 * Rendering funnel: a failure message never reaches the DOM verbatim — it goes through
 * `safePublicText`, which drops internal diagnostics (`__SECURITY_BLOCK__` payloads, raw JSON, stack
 * traces) and falls back to the catalog key when the message is absent.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { safePublicText } from '@/lib/public-text';
import type { MessageKey, MessageParams } from '@/lib/i18n/shared';

type ResetStatus =
  | { ok: boolean; kind: 'key'; key: MessageKey; params?: MessageParams }
  | { ok: false; kind: 'text'; text: string };

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
        | { ok: false; error?: { message?: string } };
      if (body.ok) {
        setStatus({ ok: true, kind: 'key', key: 'security.reset.success', params: { count: body.data.failures, max: body.data.max } });
        router.refresh();
      } else {
        // Server prose is never printed as-is: `safePublicText` falls back to the catalog key when the
        // message is missing, empty or an internal diagnostic.
        setStatus({ ok: false, kind: 'text', text: safePublicText(body.error?.message, t, 'security.reset.failed') });
      }
    } catch {
      setStatus({ ok: false, kind: 'key', key: 'security.reset.networkError' });
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  return (
    <div data-developer-breaker-reset-panel className={['flex flex-col items-start gap-2', className].filter(Boolean).join(' ')}>
      <p className="text-xs text-banking-navy">{t('security.reset.developerOnly')}</p>
      <button type="button" data-developer-breaker-reset onClick={handleClick} disabled={busy}
        className="rounded-xl bg-banking-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-banking-accent/90 disabled:cursor-not-allowed disabled:opacity-60">
        {t(busy ? 'security.reset.busy' : 'security.reset.reset')}
      </button>
      {status ? <p role="status" aria-live="polite" className={`text-sm ${status.ok ? 'text-banking-success' : 'text-banking-danger'}`}>
        {status.kind === 'key' ? t(status.key, status.params) : status.text}
      </p> : null}
    </div>
  );
}

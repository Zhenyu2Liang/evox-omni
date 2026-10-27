'use client';

/**
 * `UnlockPanel` — the ONE runtime unlock entry of the Security Center.
 *
 * Authority: this panel NEVER decides whether the account is locked. The server component reads
 * `security.circuitBreaker.getState(sessionId)` (`security/circuit-breaker.ts`) and passes the
 * authoritative `locked` / `failures` / `max` down as props; the panel only relays them.
 *
 * Transport: one submit = one `POST /api/security/reset` (`app/api/security/reset/route.ts`), which
 * delegates to the audited, GATED `circuitBreaker.resetSession`. While the account is locked that
 * route REQUIRES the 6-digit mock verification code and answers HTTP 423 (`CIRCUIT_OPEN`) without
 * it, leaving the lock intact — so the Client-side "6 digits" pre-check below is convenience only,
 * never the gate.
 *
 * Rendering funnel: nothing that arrives from the network is printed verbatim. A structured refusal
 * `code` is rendered by `securityNotice` (typed fields → catalog key), any other failure text by
 * `safePublicText` (which drops internal diagnostics such as `__SECURITY_BLOCK__` payloads, raw JSON
 * and stack traces), and the success line comes from the catalog. The route's own `data.message`
 * prose is deliberately ignored.
 *
 * Unlock semantics: clearing the breaker only resets the consecutive-failure counter. It never
 * re-opens a terminal `locked` `PendingAction`, never retries and never executes the original
 * operation — the user must start a new request and confirm it again. Nothing here auto-unlocks,
 * auto-retries or polls, and the code is never persisted (no cookie, no `localStorage`).
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { safePublicText, securityNotice } from '@/lib/public-text';
import type { MessageKey, MessageParams } from '@/lib/i18n/shared';

export interface UnlockPanelProps {
  /** 账户熔断是否处于锁定（服务端权威）。 */
  locked: boolean;
  /** 服务端权威的连续失败次数与上限。 */
  failures: number;
  maxAttempts: number;
  /** 处于终态 `locked` 的操作数量（用于向用户说明影响范围）。 */
  lockedActionCount: number;
  className?: string;
}

/** Success envelope of `POST /api/security/reset` (`ResetData`). */
interface ResetSuccessBody {
  ok: true;
  data: { sessionId: string; locked: boolean; failures: number; max: number; message: string };
}

/** The shared failure envelope (`app/api/_lib/http.ts` `fail`). */
interface ResetFailureBody {
  ok: false;
  error: { code?: string; message?: string };
}

/** A rendered notice: either a catalog key (re-translated on every render) or already-funneled text. */
type Notice =
  | { ok: boolean; kind: 'key'; key: MessageKey; params?: MessageParams }
  | { ok: boolean; kind: 'text'; text: string };

/** Refusal codes with typed semantics — rendered by `securityNotice`, never as free text. */
const STRUCTURED_REFUSALS: ReadonlySet<string> = new Set(['MFA_LOCKED', 'MFA_FAILED', 'CIRCUIT_OPEN']);

/** The mock strong-verification code length (`lib/constants.MFA_CODE`); the value itself is never shown. */
const CODE_LENGTH = 6;

const INPUT_CLASS =
  'mt-1 w-full rounded-xl border border-banking-light px-3 py-2 text-sm tracking-widest text-banking-deep outline-none focus:border-banking-accent';

const BUTTON_CLASS =
  'rounded-xl bg-banking-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-banking-accent/90 disabled:cursor-not-allowed disabled:opacity-60';

export function UnlockPanel({
  locked,
  failures,
  maxAttempts,
  lockedActionCount,
  className,
}: UnlockPanelProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const submitted = code.trim();
    // A locked account cannot be unlocked without the 6-digit code — skip the pointless round trip
    // (the route still re-decides; this is not the gate).
    if (locked && submitted.length !== CODE_LENGTH) {
      setNotice({ ok: false, kind: 'key', key: 'security.reset.codeRequired' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/security/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submitted.length > 0 ? { verificationCode: submitted } : {}),
      });
      const body = (await response.json()) as ResetSuccessBody | ResetFailureBody;
      if (body.ok) {
        setCode('');
        setNotice({
          ok: true,
          kind: 'key',
          key: 'security.reset.success',
          params: { count: body.data.failures, max: body.data.max },
        });
        router.refresh();
        return;
      }
      const errorCode = body.error?.code;
      setNotice({
        ok: false,
        kind: 'text',
        text:
          errorCode !== undefined && STRUCTURED_REFUSALS.has(errorCode)
            ? securityNotice({ code: errorCode }, t)
            : safePublicText(body.error?.message, t, 'security.reset.failed'),
      });
    } catch {
      // Unreachable route, transport failure or an unparseable body — never the raw error text.
      setNotice({ ok: false, kind: 'key', key: 'security.reset.networkError' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-unlock-panel
      data-unlock-locked={locked ? 'true' : 'false'}
      data-unlock-failures={failures}
      data-unlock-max-attempts={maxAttempts}
      data-unlock-locked-actions={lockedActionCount}
      className={[
        'flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-xs sm:p-5',
        locked ? 'border-banking-danger/40' : 'border-banking-light',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <h3 className="text-sm font-semibold text-banking-deep">{t('security.reset.panelTitle')}</h3>
      <p data-security-current-state className={`text-sm leading-5 ${locked ? 'text-banking-danger' : 'text-banking-navy'}`}>
        {t(locked ? 'security.reset.currentLocked' : 'security.reset.currentNormal')}
      </p>
      {locked ? (
        <p className="text-sm leading-5 text-banking-navy">
          {t('security.reset.lockReason', { count: failures, max: maxAttempts })}
        </p>
      ) : null}
      {lockedActionCount > 0 ? (
        <p className="text-sm leading-5 text-banking-navy" data-unlock-impact={lockedActionCount}>
          {locked ? t('security.breaker.lockedDescription') : t('security.reset.historicalImpact', { count: lockedActionCount })}
          <span className="ml-2 whitespace-nowrap rounded-lg bg-banking-neutral px-2 py-0.5 text-xs font-medium">
            {t('pages.activity.status.locked')} · {lockedActionCount}
          </span>
        </p>
      ) : null}

      <details data-unlock-guidance open={locked || failures > 0} className="rounded-xl border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-banking-interactive hover:text-banking-accent">{t('security.reset.helpTitle')}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-5 text-banking-navy">{t('pages.security.unlockDescription')}</p>
          {locked ? <p className="text-sm leading-5 text-banking-navy">{t('chat.error.actionLocked')}</p> : null}
          <p className="text-sm leading-5 text-banking-navy">{t('security.reset.lockedActionState')}</p>
          <p data-unlock-reinitiate className={`text-sm leading-5 ${locked ? 'text-banking-danger' : 'text-banking-navy'}`}>
            {t('security.reset.reinitiate')}
          </p>
          <p className="text-sm leading-5 text-banking-navy">{t('security.reset.recovery')}</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="block flex-1 text-sm text-banking-navy">
          {t('security.reset.codeLabel')}
          <input
            name="verificationCode"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, CODE_LENGTH))}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={CODE_LENGTH}
            placeholder={t('security.reset.codePlaceholder')}
            aria-label={t('security.reset.codeLabel')}
            className={INPUT_CLASS}
          />
        </label>
        <button type="submit" disabled={busy} className={BUTTON_CLASS}>
          {t(busy ? 'security.reset.busy' : 'security.reset.unlock')}
        </button>
      </form>
        </div>
      </details>

      {/* One persistent live region, so a result is announced even though the text starts empty. */}
      <p
        role="status"
        aria-live="polite"
        data-unlock-status={notice === null ? 'idle' : notice.ok ? 'success' : 'error'}
        className={[
          'text-sm leading-5',
          notice === null ? 'text-banking-navy' : notice.ok ? 'text-banking-success' : 'text-banking-danger',
        ].join(' ')}
      >
        {notice === null ? '' : notice.kind === 'key' ? t(notice.key, notice.params) : notice.text}
      </p>
    </section>
  );
}

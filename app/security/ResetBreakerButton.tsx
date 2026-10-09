'use client';

/**
 * ResetBreakerButton — clears the current ACCOUNT's circuit-breaker state (GATED unlock).
 *
 * Client Component (the only interactive part of the Security Center): it POSTs a mock 6-digit
 * verification code to `POST /api/security/reset`, which calls the AUDITED
 * `security.circuitBreaker.resetSession(sessionId, { actor, reason, verificationCode })` on the
 * server, then calls `router.refresh()` so the Server Component re-renders with the fresh breaker
 * state (failure count back to 0, unlocked).
 *
 * The breaker is GATED and PER-ACCOUNT: while the account is locked a correct mock code
 * (default/placeholder `123456`) is REQUIRED — a bare session cookie is REFUSED with HTTP
 * `423 CIRCUIT_OPEN`, and that refusal message is surfaced here verbatim.
 *
 * Label reflects the current state: "解除熔断限制" while locked, "重置熔断计数" otherwise.
 * All errors are surfaced as a SAFE user-facing message — raw internals (stack traces, Prisma
 * errors, the MFA code) must never reach the UI. No Prisma/server imports here: the browser
 * only talks to `/api/*`.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface ResetBreakerButtonProps {
  /** Whether the account breaker is currently tripped (drives the label + colour). */
  locked?: boolean;
  className?: string;
}

/** Success payload of `POST /api/security/reset` (mirrors the route's `ResetData`). */
interface ResetData {
  sessionId: string;
  locked: boolean;
  failures: number;
  max: number;
  message: string;
}

/** The frozen API envelope: `{ ok: true, data }` | `{ ok: false, error: { code, message } }`. */
type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** Demo mock verification code (public in the README) — prefills the unlock input. */
const DEFAULT_VERIFICATION_CODE = '123456';

export function ResetBreakerButton({ locked = false, className }: ResetBreakerButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(DEFAULT_VERIFICATION_CODE);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleClick() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/security/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verificationCode: code }),
      });
      const body = (await res.json()) as ApiEnvelope<ResetData>;
      if (body.ok) {
        setStatus({
          ok: true,
          message: `已解除，当前失败 ${body.data.failures} / ${body.data.max} 次`,
        });
        router.refresh();
      } else {
        // Includes the `423 CIRCUIT_OPEN` refusal when the mock code is missing/wrong while locked.
        setStatus({ ok: false, message: body.error.message || '重置失败，请稍后重试。' });
      }
    } catch {
      setStatus({ ok: false, message: '重置失败，请检查网络后重试。' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={['flex flex-col items-start gap-2', className].filter(Boolean).join(' ')}>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-banking-navy">
          <span>验证码</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            aria-label="6 位验证码"
            placeholder={DEFAULT_VERIFICATION_CODE}
            value={code}
            disabled={busy}
            onChange={(e) => setCode(e.target.value)}
            className="w-24 rounded-xl border border-banking-navy/20 bg-banking-light px-3 py-2 text-center text-sm tracking-widest text-banking-navy outline-none transition focus:border-banking-accent disabled:opacity-60"
          />
        </label>
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className={[
            'rounded-xl px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-60',
            locked ? 'bg-banking-danger hover:bg-banking-danger/90' : 'bg-banking-accent hover:bg-banking-accent/90',
          ].join(' ')}
        >
          {busy ? '处理中…' : locked ? '解除熔断限制' : '重置熔断计数'}
        </button>
      </div>
      {status ? (
        <p
          role="status"
          aria-live="polite"
          className={`text-sm ${status.ok ? 'text-banking-success' : 'text-banking-danger'}`}
        >
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

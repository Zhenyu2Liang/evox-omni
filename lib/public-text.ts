/**
 * `lib/public-text.ts` — the ONE funnel that turns internal diagnostics into public text.
 *
 * Server-side refusals, verifier diagnostics and provider failures carry implementation detail
 * (`__SECURITY_BLOCK__…` payloads, raw JSON fragments, stack traces, `undefined`). NONE of it may
 * reach the user: public text comes from the message catalog, a small allow-list of exact business
 * messages (see `./tool-feedback`) or a catalog fallback. Structured security refusals are rendered
 * from their TYPED fields (`code` / `reason` / `attemptsLeft`), never from string matching.
 *
 * `safePublicText` delegates the allow-listed rendering to `publicToolError` and `publicToolError`
 * imports the diagnostic predicate from `./internal-text`. `./errors` uses the same predicate to
 * derive `AppError.publicMessage` at construction time. Every dependency here is acyclic: the pure
 * predicate lives in its own module precisely so `./errors` never has to import this funnel.
 */
import type { MessageKey, Translator } from './i18n/shared';
import { AppError } from './errors';
import { isInternalDiagnostic, publicSafeMessage } from './internal-text';
import { publicToolError } from './tool-feedback';

/** Re-exported so callers keep importing the predicate from the funnel they already use. */
export { isInternalDiagnostic };

/**
 * Safe public text: a catalog fallback for a missing/internal-diagnostic message, else the
 * allow-listed public rendering of `./tool-feedback` (exact table + closed regexes + catalog keys).
 */
export function safePublicText(text: string | undefined, t: Translator, fallback: MessageKey): string {
  if (!text || isInternalDiagnostic(text)) return t(fallback);
  return publicToolError(text, t, fallback);
}

/**
 * Render an error (typically an `AppError`) without ever exposing its internal message: the
 * pre-sanitised `publicMessage` goes through the SAME funnel, and the server-owned `code` supplies
 * the catalog rendering when the text itself is not allow-listed. An internal diagnostic has no
 * public message at all, so it renders as the catalog fallback.
 */
export function publicErrorMessage(error: unknown, t: Translator, fallback: MessageKey = 'chat.error.toolFailed'): string {
  if (error instanceof AppError) return publicToolError(error.publicMessage, t, fallback, error.code);
  const text = publicSafeMessage(error instanceof Error ? error.message : typeof error === 'string' ? error : undefined);
  return publicToolError(text, t, fallback);
}

/** The typed facts of a security refusal that may be rendered to the user. */
export interface SecurityNoticeInput {
  code?: string;
  reason?: string;
  kind?: string;
  attemptsLeft?: number;
  maxAttempts?: number;
}

/**
 * The catalog key of a structured security refusal, decided from its TYPED fields only (never from
 * message text):
 *  - an exhausted / locked verification → `chat.error.actionLocked`;
 *  - a retryable wrong code → `chat.error.verificationRemaining` (see `securityNoticeParams`);
 *  - a session lock or an open circuit → `chat.error.securityLocked`;
 *  - a MANUAL-REVIEW HOLD (`MANUAL_REVIEW_HOLD` / `manual_review_hold`) → `chat.error.manualReviewHold`:
 *    the operation is intact and unexecuted, it only waits for the open review to be released, so the
 *    generic "state changed, refresh" sentence must never stand in for it;
 *  - any other refusal → `chat.error.securityDenied`.
 *
 * Exported so every layer (gateway, HTTP edge, channel, UI) shares ONE mapping instead of
 * re-deriving it from strings.
 */
export function securityNoticeKey(failure: SecurityNoticeInput | undefined): MessageKey {
  if (failure && (failure.code === 'MFA_LOCKED' || failure.reason === 'mfa_attempts_exhausted')) {
    return 'chat.error.actionLocked';
  }
  if (failure && (failure.reason === 'mfa_code_invalid' || failure.code === 'MFA_FAILED')) {
    return 'chat.error.verificationRemaining';
  }
  if (failure && (failure.code === 'MANUAL_REVIEW_HOLD' || failure.reason === 'manual_review_hold')) {
    return 'chat.error.manualReviewHold';
  }
  if (failure && (failure.code === 'CIRCUIT_OPEN' || failure.reason === 'circuit_open'
    || failure.reason === 'mfa_session_locked')) {
    return 'chat.error.securityLocked';
  }
  return 'chat.error.securityDenied';
}

/** The typed interpolation facts that belong to `securityNoticeKey(failure)` — `attemptsLeft` only. */
export function securityNoticeParams(failure: SecurityNoticeInput | undefined): Record<string, number> | undefined {
  if (securityNoticeKey(failure) !== 'chat.error.verificationRemaining') return undefined;
  return { count: failure?.attemptsLeft ?? 0 };
}

/** Render a structured security refusal through the typed mapping above. */
export function securityNotice(failure: SecurityNoticeInput | undefined, t: Translator): string {
  const params = securityNoticeParams(failure);
  return params ? t(securityNoticeKey(failure), params) : t(securityNoticeKey(failure));
}

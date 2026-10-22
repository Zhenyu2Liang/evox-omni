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
 * imports the diagnostic predicate from here. That single, function-declaration-only cycle is safe
 * (nothing is called at module-evaluation time) and keeps ONE predicate for both entry points.
 */
import type { MessageKey, Translator } from './i18n/shared';
import { publicToolError } from './tool-feedback';

/**
 * The marker the security gateway wraps around a serialized refusal payload. Duplicated (not
 * imported) on purpose: `security/security-gateway.ts` already imports from `lib/`, so importing it
 * back would create a cross-layer cycle.
 */
const BLOCK_REASON_PREFIX = '__SECURITY_BLOCK__';

/** Rendered forms of a missing value — never a business fact. */
const NULLISH_TEXT = new Set(['undefined', 'null', '[object Object]']);

/** A raw JSON fragment (an object start or a serialized property) — never user-facing text. */
const JSON_FRAGMENT = /\{\s*"|":/;

/** A stack-trace frame or an exception header (`Error:` / `TypeError:` / `RangeError:`). */
const DIAGNOSTIC_TRACE = /\n\s+at\s|[A-Za-z]*Error:/;

/**
 * Is this text an internal diagnostic (never user-facing)? Pure, text-shape based — deliberately
 * NOT a business-text allow-list: ordinary business messages (e.g. `Insufficient funds: …`,
 * `Transfer amount must be positive.`) stay renderable.
 */
export function isInternalDiagnostic(text: string | undefined): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (text.includes(BLOCK_REASON_PREFIX)) return true;
  if (NULLISH_TEXT.has(trimmed)) return true;
  return JSON_FRAGMENT.test(text) || DIAGNOSTIC_TRACE.test(text);
}

/**
 * Safe public text: a catalog fallback for a missing/internal-diagnostic message, else the
 * allow-listed public rendering of `./tool-feedback` (exact table + closed regexes + catalog keys).
 */
export function safePublicText(text: string | undefined, t: Translator, fallback: MessageKey): string {
  if (!text || isInternalDiagnostic(text)) return t(fallback);
  return publicToolError(text, t, fallback);
}

/** The typed facts of a security refusal that may be rendered to the user. */
interface SecurityNoticeInput {
  code?: string;
  reason?: string;
  kind?: string;
  attemptsLeft?: number;
  maxAttempts?: number;
}

/**
 * Render a structured security refusal from its TYPED fields (never from message text):
 *  - an exhausted / locked verification → `chat.error.actionLocked`;
 *  - a retryable wrong code → `chat.error.verificationRemaining` with the remaining attempts;
 *  - a session lock or an open circuit → `chat.error.securityLocked`;
 *  - any other refusal → `chat.error.securityDenied`.
 */
export function securityNotice(failure: SecurityNoticeInput | undefined, t: Translator): string {
  if (failure && (failure.code === 'MFA_LOCKED' || failure.reason === 'mfa_attempts_exhausted')) {
    return t('chat.error.actionLocked');
  }
  if (failure && (failure.reason === 'mfa_code_invalid' || failure.code === 'MFA_FAILED')) {
    return t('chat.error.verificationRemaining', { count: failure.attemptsLeft ?? 0 });
  }
  if (failure && (failure.code === 'CIRCUIT_OPEN' || failure.reason === 'circuit_open'
    || failure.reason === 'mfa_session_locked')) {
    return t('chat.error.securityLocked');
  }
  return t('chat.error.securityDenied');
}

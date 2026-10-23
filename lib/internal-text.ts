/**
 * `lib/internal-text.ts` — the pure, dependency-free text-shape predicate shared by the public-text
 * funnel and by `AppError` (`./errors`).
 *
 * Server-side refusals, verifier diagnostics and provider failures carry implementation detail
 * (`__SECURITY_BLOCK__…` payloads, raw JSON fragments, stack traces, `undefined`). NONE of it may
 * reach the user. This module owns the ONE predicate that recognises such text; it lives apart from
 * `./public-text` so `./errors` can sanitise at construction time without depending on the i18n
 * funnel (that would introduce a new module cycle).
 */

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
 * The PUBLIC-SAFE form of an internal message: the original text when it is a renderable value,
 * `undefined` when it is missing, blank or an internal diagnostic — `undefined` means "there is no
 * public message here, the caller must use a catalog fallback".
 */
export function publicSafeMessage(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  return isInternalDiagnostic(text) ? undefined : text;
}

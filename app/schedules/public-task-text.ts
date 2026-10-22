/**
 * `app/schedules/public-task-text.ts` — the single gate for server-originated text on `/schedules`.
 *
 * The schedule inbox carries persisted server text (a task's `dispatchError`, a delivered
 * `notification.message`) and the page holds request-failure messages. Any of them can be an
 * internal diagnostic (`__SECURITY_BLOCK__…`, raw JSON, a stack trace, `undefined`); those must be
 * replaced by a catalog fallback while real business prose (`付款流程未创建：账户不可用`) stays verbatim.
 *
 * This deliberately does NOT use `safePublicText`: that helper renders through `publicToolError`'s
 * allow-list, so a legitimate dispatch error outside the table would be replaced by a generic
 * fallback. Here `isInternalDiagnostic` alone is the gate and any non-diagnostic prose is a real
 * business fact. A text that is itself a catalog key keeps the existing "localize it" behaviour.
 */
import { isMessageKey, type MessageKey, type Translator } from '@/lib/i18n/shared';
import { isInternalDiagnostic } from '@/lib/public-text';

/** Public text for one persisted/request field; `null` stays accepted so callers can pass directly. */
export function publicScheduleText(
  text: string | undefined | null,
  t: Translator,
  fallback: MessageKey,
): string {
  if (typeof text !== 'string') return t(fallback);
  const trimmed = text.trim();
  if (trimmed === '' || isInternalDiagnostic(text)) return t(fallback);
  return isMessageKey(trimmed) ? t(trimmed) : text;
}

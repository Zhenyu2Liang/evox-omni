import type { ToolEventView } from './contracts/agent';
import { localizeChatError } from './i18n/display';
import { isMessageKey, type MessageKey, type Translator } from './i18n/shared';
import type { ErrorCode } from './errors';
import { isInternalDiagnostic, securityNotice, type SecurityNoticeInput } from './public-text';

const PUBLIC_ERROR_CODES: Record<ErrorCode, MessageKey> = {
  VALIDATION: 'chat.error.invalidDetails', NOT_FOUND: 'chat.error.objectUnavailable',
  INSUFFICIENT_FUNDS: 'chat.error.insufficientBalance', LIMIT_EXCEEDED: 'chat.error.limitExceeded',
  SECURITY_DENIED: 'chat.error.securityDenied', MFA_FAILED: 'chat.error.verificationFailed',
  MFA_LOCKED: 'chat.error.actionLocked',
  CIRCUIT_OPEN: 'chat.error.securityLocked', CONFLICT: 'chat.error.stateChanged',
  MANUAL_REVIEW_HOLD: 'chat.error.manualReviewHold',
  TOOL_FAILED: 'chat.error.toolFailed', INTERNAL: 'chat.error.toolFailed',
};

/** Exact SDK-owned messages; never infer safety from a language or a broad substring. */
const PUBLIC_BUSINESS_ERRORS: Record<string, MessageKey> = {
  'Transfer amount must be positive.': 'chat.error.positiveTransfer',
  'Purchase amount must be positive.': 'chat.error.positivePurchase',
  '\u8d26\u6237\u4f59\u989d\u4e0d\u8db3\uff0c\u65e0\u6cd5\u5b8c\u6210\u8ba4\u8d2d': 'chat.error.insufficientBalance',
  '\u7f3a\u5c11\u9650\u989d\u5206\u7c7b': 'chat.error.limitCategoryRequired',
  '\u9650\u989d\u5fc5\u987b\u662f\u4e0d\u5c0f\u4e8e 0 \u7684\u91d1\u989d': 'chat.error.nonNegativeLimit',
  '\u8be5\u5361\u7247\u5df2\u6302\u5931\uff0c\u65e0\u9700\u91cd\u590d\u6302\u5931': 'chat.error.alreadyLost',
  'The banking result could not be displayed. Refresh the saved records to check the outcome.': 'business.results.invalid',
  'This verification challenge has already been consumed.': 'chat.error.verificationConsumed',
  'The verification challenge expired or the operation changed. Request a new challenge.': 'chat.error.verificationExpired',
  '\u9a8c\u8bc1\u7801\u9519\u8bef\u6b21\u6570\u8fc7\u591a\uff0c\u672c\u4f1a\u8bdd\u9ad8\u98ce\u9669\u64cd\u4f5c\u5df2\u88ab\u9501\u5b9a\u3002\u8bf7\u524d\u5f80\u5b89\u5168\u4e2d\u5fc3\u89e3\u9664\u9650\u5236\u540e\u518d\u8bd5\u3002': 'chat.error.actionLocked',
  // COMPATIBILITY ONLY, for refusals already persisted as text (`security/security-gateway.ts`). The
  // authoritative path renders the same refusal from its typed `code`/`failure`
  // (`publicSecurityError`); these entries only keep historical records and untyped callers honest.
  '\u5f53\u524d\u4f1a\u8bdd\u5df2\u89e6\u53d1\u5b89\u5168\u7194\u65ad\uff0c\u64cd\u4f5c\u5df2\u88ab\u62d2\u7edd\u3002\u8bf7\u524d\u5f80\u5b89\u5168\u4e2d\u5fc3\u89e3\u9664\u9650\u5236\u540e\u518d\u8bd5\u3002': 'chat.error.actionLocked',
  '\u5f53\u524d\u4f1a\u8bdd\u5df2\u89e6\u53d1\u5b89\u5168\u7194\u65ad\uff0c\u9ad8\u98ce\u9669\u64cd\u4f5c\u5df2\u88ab\u9501\u5b9a\u3002\u8bf7\u524d\u5f80\u5b89\u5168\u4e2d\u5fc3\u89e3\u9664\u9650\u5236\u540e\u518d\u8bd5\u3002': 'chat.error.securityLocked',
};

/** Provider correction stays in model context and diagnostics, never in public status text. */
export const CONVERSATION_TOOL_REJECTION = 'This banking call is outside the declared purpose and capabilities of the current turn, or is not allowed during output-format correction. Declare the current request before proposing a sensitive read or write. Never resume an earlier write from history or change the declaration to acquire additional permissions. Answer the current question using the available context.';

/** Internal classification for validation completed before any banking side effect. */
export const PARAMETER_PREFLIGHT_PREFIX = '[Banking parameter preflight] ';

/** This adapter receives only server-owned preflight refusals, before any business side effect. */
export function projectToolRejection(reason: string): Pick<ToolEventView, 'summary' | 'debugDetail'> {
  if (reason.startsWith(PARAMETER_PREFLIGHT_PREFIX)) return { summary: 'chat.error.parametersNotSubmitted', debugDetail: reason.slice(PARAMETER_PREFLIGHT_PREFIX.length) };
  return { summary: reason === CONVERSATION_TOOL_REJECTION ? 'chat.error.newBankingRequest' : 'chat.error.planNotSubmitted', debugDetail: reason };
}

/**
 * Public errors are catalog-owned; unexpected diagnostics remain available only to developers.
 * `params` supplies the typed facts a catalog message may interpolate (e.g. remaining attempts).
 * Internal diagnostics (raw payloads, JSON fragments, stack traces) never match anything but the
 * `errorCode` rendering and the fallback.
 */
export function publicToolError(message: string | undefined, t: Translator, fallback: MessageKey = 'chat.error.toolFailed', errorCode?: string, params?: Record<string, string | number>): string {
  if (!isInternalDiagnostic(message) && message) {
    if (Object.hasOwn(PUBLIC_BUSINESS_ERRORS, message)) return t(PUBLIC_BUSINESS_ERRORS[message]);
    const insufficient = /^Insufficient funds: balance (-?\d+\.\d{2}) < amount (\d+\.\d{2})$/.exec(message);
    if (insufficient) return t('chat.error.insufficientFunds', { balance: insufficient[1], amount: insufficient[2] });
    const minimum = /^Purchase amount is below the minimum (\d+\.\d{2})\.$/.exec(message);
    if (minimum) return t('chat.error.purchaseMinimum', { amount: minimum[1] });
    // The gateway renders a retryable wrong code from `chat.error.verificationRemaining`; the older
    // persisted wording is still accepted for stored rows. Anything else (an internal diagnostic, a
    // provider message) must keep reaching the `fallback`.
    const verification = /^(?:\u9a8c\u8bc1\u7801\u9519\u8bef\u3002\u8fd8\u53ef\u5c1d\u8bd5 (\d+) \u6b21\u3002|\u9a8c\u8bc1\u7801\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5\u3002\u5269\u4f59\u5c1d\u8bd5\u6b21\u6570\uff1a(\d+)\u3002)$/.exec(message);
    if (verification) return t('chat.error.verificationRemaining', { count: verification[1] ?? verification[2] });
  }
  if (errorCode && Object.hasOwn(PUBLIC_ERROR_CODES, errorCode)) {
    return params ? t(PUBLIC_ERROR_CODES[errorCode as ErrorCode], params) : t(PUBLIC_ERROR_CODES[errorCode as ErrorCode]);
  }
  if (!message || isInternalDiagnostic(message)) return params ? t(fallback, params) : t(fallback);
  if (message === CONVERSATION_TOOL_REJECTION) return t('chat.error.newBankingRequest');
  if (message.startsWith('chat.error.') && isMessageKey(message)) return params ? t(message, params) : t(message);
  const localized = localizeChatError(message, t);
  return localized !== message && localized !== undefined ? localized : params ? t(fallback, params) : t(fallback);
}

/**
 * Render a STRUCTURED security refusal — the authoritative path every server layer shares.
 *
 * The gateway, the HTTP edge and the channels all hold the TYPED facts of a refusal
 * (`code` / `reason` / `attemptsLeft`), so the public text is decided from those fields by
 * `./public-text#securityNotice` and never from the (untrusted, internal) `message` text:
 * an exhausted / locked verification renders `chat.error.actionLocked`, a session lock or an open
 * circuit renders `chat.error.securityLocked`, a retryable wrong code renders
 * `chat.error.verificationRemaining` with the remaining attempts, anything else is
 * `chat.error.securityDenied`. A missing refusal has no typed facts at all, so `fallback` applies.
 */
export function publicSecurityError(failure: SecurityNoticeInput | undefined, t: Translator, fallback: MessageKey = 'chat.error.securityDenied'): string {
  if (!failure) return t(fallback);
  return securityNotice(failure, t);
}

/** Old persisted diagnostic strings receive the same safe rendering as newly projected refusals. */
export function publicToolSummary(event: ToolEventView, t: Translator): string | undefined {
  if (event.toolName === 'search_conversation_history' && event.status === 'success') return t('chat.activity.historyRead');
  if (event.status === 'blocked') {
    if (!event.actionId && event.summary === 'chat.error.parametersNotSubmitted') return t('chat.error.parametersNotSubmitted');
    if (event.errorCode) return publicToolError(event.summary, t, 'chat.error.operationNotStarted', event.errorCode, event.errorParams);
    if (!event.actionId) return publicToolError(event.summary, t, 'chat.error.operationNotStarted');
    return localizeChatError(event.summary, t);
  }
  if (event.status === 'error') return publicToolError(event.summary, t, 'chat.error.toolFailed', event.errorCode, event.errorParams);
  if (event.status === 'needs_reconciliation') return t('chat.error.unknownOutcome');
  return localizeChatError(event.summary, t);
}

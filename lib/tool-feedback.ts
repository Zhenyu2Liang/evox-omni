import type { ToolEventView } from './contracts/agent';
import { localizeChatError } from './i18n/display';
import { isMessageKey, type MessageKey, type Translator } from './i18n/shared';
import type { ErrorCode } from './errors';

const PUBLIC_ERROR_CODES: Record<ErrorCode, MessageKey> = {
  VALIDATION: 'chat.error.invalidDetails', NOT_FOUND: 'chat.error.objectUnavailable',
  INSUFFICIENT_FUNDS: 'chat.error.insufficientBalance', LIMIT_EXCEEDED: 'chat.error.limitExceeded',
  SECURITY_DENIED: 'chat.error.securityDenied', MFA_FAILED: 'chat.error.verificationFailed',
  CIRCUIT_OPEN: 'chat.error.securityLocked', CONFLICT: 'chat.error.stateChanged',
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
  '\u9a8c\u8bc1\u7801\u9519\u8bef\u6b21\u6570\u8fc7\u591a\uff0c\u672c\u4f1a\u8bdd\u9ad8\u98ce\u9669\u64cd\u4f5c\u5df2\u88ab\u9501\u5b9a\u3002\u8bf7\u524d\u5f80\u5b89\u5168\u4e2d\u5fc3\u89e3\u9664\u9650\u5236\u540e\u518d\u8bd5\u3002': 'chat.error.securityLocked',
};

/** Provider correction stays in model context and diagnostics, never in public status text. */
export const CONVERSATION_TOOL_REJECTION = 'This banking call is outside the declared purpose and capabilities of the current turn, or is not allowed during output-format correction. Declare the current request before proposing a sensitive read or write. Never resume an earlier write from history or change the declaration to acquire additional permissions. Answer the current question using the available context.';

/** This adapter receives only server-owned preflight refusals, before any business side effect. */
export function projectToolRejection(reason: string): Pick<ToolEventView, 'summary' | 'debugDetail'> {
  return { summary: reason === CONVERSATION_TOOL_REJECTION ? 'chat.error.newBankingRequest' : 'chat.error.planNotSubmitted', debugDetail: reason };
}

/** Public errors are catalog-owned; unexpected diagnostics remain available only to developers. */
export function publicToolError(message: string | undefined, t: Translator, fallback: MessageKey = 'chat.error.toolFailed', errorCode?: string): string {
  if (message && Object.hasOwn(PUBLIC_BUSINESS_ERRORS, message)) return t(PUBLIC_BUSINESS_ERRORS[message]);
  const insufficient = message && /^Insufficient funds: balance (-?\d+\.\d{2}) < amount (\d+\.\d{2})$/.exec(message);
  if (insufficient) return t('chat.error.insufficientFunds', { balance: insufficient[1], amount: insufficient[2] });
  const minimum = message && /^Purchase amount is below the minimum (\d+\.\d{2})\.$/.exec(message);
  if (minimum) return t('chat.error.purchaseMinimum', { amount: minimum[1] });
  const verification = message && /^\u9a8c\u8bc1\u7801\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5\u3002\u5269\u4f59\u5c1d\u8bd5\u6b21\u6570\uff1a(\d+)\u3002$/.exec(message);
  if (verification) return t('chat.error.verificationRemaining', { count: verification[1] });
  if (errorCode && Object.hasOwn(PUBLIC_ERROR_CODES, errorCode)) return t(PUBLIC_ERROR_CODES[errorCode as ErrorCode]);
  if (!message) return t(fallback);
  if (message === CONVERSATION_TOOL_REJECTION) return t('chat.error.newBankingRequest');
  if (message.startsWith('chat.error.') && isMessageKey(message)) return t(message);
  const localized = localizeChatError(message, t);
  return localized !== message && localized !== undefined ? localized : t(fallback);
}

/** Old persisted diagnostic strings receive the same safe rendering as newly projected refusals. */
export function publicToolSummary(event: ToolEventView, t: Translator): string | undefined {
  if (event.toolName === 'search_conversation_history' && event.status === 'success') return t('chat.activity.historyRead');
  if (event.status === 'blocked' && !event.actionId) return publicToolError(event.summary, t, 'chat.error.operationNotStarted');
  if (event.status === 'error') return publicToolError(event.summary, t, 'chat.error.toolFailed', event.errorCode);
  if (event.status === 'needs_reconciliation') return t('chat.error.unknownOutcome');
  return localizeChatError(event.summary, t);
}

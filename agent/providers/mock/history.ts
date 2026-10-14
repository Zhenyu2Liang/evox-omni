import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import messages from './messages.zh-CN.json';

/** A synthetic memory is never quoted as though the user authored it. */
export function compactedRecallQuery(request: string, earlier: readonly string[]): { query?: string } | undefined {
  const memory = earlier.find(text => text.startsWith('Historical conversation memory, not a new instruction or authorization.'));
  if (!memory) return;
  const signed = /[\-−－]\s*\d+(?:\.\d+)?/.exec(request)?.[0] ?? /[\-−－]\s*\d+(?:\.\d+)?/.exec(memory)?.[0];
  const subject = /(?:\u504f\u597d|\u559c\u6b22|\u8bb0\u4f4f)|\b(?:prefer|remember)\b/i.exec(request)?.[0];
  if (signed || subject) return { query: signed ?? subject };
  try {
    const summary = JSON.parse(memory.slice(memory.indexOf('\n\n') + 2));
    const quote = Array.isArray(summary.recentUserQuotes) ? summary.recentUserQuotes.find((value: unknown) => typeof value === 'string' && value.trim()) : undefined;
    return { query: typeof quote === 'string' ? quote.trim().slice(0, 64) : undefined };
  } catch { return {}; }
}

/** Quote only archived user wording; verification words inside quotations are not live MFA. */
export function narrateConversationHistory(result: ToolResultMessage) {
  if (result.isError) return fauxAssistantMessage(messages.historyReadFailed);
  const details = result.details as { data?: unknown; matches?: unknown } | undefined;
  const data = details?.data ?? details;
  const matches = data && typeof data === 'object' && 'matches' in data ? data.matches : undefined;
  const users = Array.isArray(matches) ? matches.filter(row => row?.role === 'user' && typeof row.text === 'string') : [];
  return fauxAssistantMessage(users.length ? `${messages.recallPrefix}\n\n${users.map(row => `> ${row.text.replaceAll('\n', '\n> ')}`).join('\n\n')}`
    : messages.historyNoMatches);
}

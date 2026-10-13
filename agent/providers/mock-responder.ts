/** Deterministic offline model entry point. Domain handlers propose calls; the gateway authorizes. */
import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai';
import { parseBankingGuidance, type BankingGuidance } from '../banking-guidance';
import { parseAmount } from './mock/amount-parser';
import { classify } from './mock/classifier';
import { contentToText, findLastUserIndex, findToolCall, lastToolResultAfter } from './mock/conversation';
import { extractProductName } from './mock/investment-intents';
import { narrate } from './mock/narration';
import { plain } from './mock/replies';
import { isTransferIntent, parseTransfer, priorTransferRecipient, refineTransfer } from './mock/transfer-intents';

export interface MockContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: unknown[];
}

export function respond(context: MockContext): AssistantMessage {
  const messages = context.messages ?? [];
  const userIndex = findLastUserIndex(messages);
  const userText = userIndex >= 0 ? contentToText((messages[userIndex] as UserMessage).content).trim() : '';
  const lastResult = lastToolResultAfter(messages, userIndex);
  if (lastResult) {
    const sourceCall = findToolCall(messages, lastResult.toolCallId);
    if (sourceCall?.name === 'search_contact' && isTransferIntent(userText)) return refineTransfer(userText, lastResult);
    return narrate(lastResult);
  }
  return classify(userText, messages);
}

/** Preserve the same closed guidance protocol used by the live model. */
export function respondWithGuidance(context: MockContext): AssistantMessage {
  const reply = respond(context);
  if (reply.content.some(part => part.type === 'toolCall') || parseBankingGuidance(contentToText(reply.content))) return reply;
  const messages = context.messages ?? [];
  const userIndex = findLastUserIndex(messages);
  const text = userIndex < 0 ? '' : contentToText((messages[userIndex] as UserMessage).content);
  const lastResult = lastToolResultAfter(messages, userIndex);
  const guidance = (value: BankingGuidance) => plain(JSON.stringify({ guidance: value }));
  if (isTransferIntent(text)) {
    const intent = parseTransfer(text);
    const fields: ('recipient' | 'amount')[] = [];
    if ((!intent.recipient && !intent.reuseRecipient) || (intent.reuseRecipient && !priorTransferRecipient(messages))) fields.push('recipient');
    if (intent.amount == null) fields.push('amount');
    if (fields.length) return guidance({ code: 'missing_details', fields });
    if (lastResult?.toolName === 'search_contact') return guidance({ code: 'ambiguous_selection', fields: ['recipient'] });
  }
  if (lastResult) return reply;
  if (/(申购|认购|买入|购买)/.test(text) || /买[^\n]{0,6}(理财|基金|产品)/.test(text)) {
    if (!extractProductName(text)) return guidance({ code: 'missing_details', fields: ['product'] });
    if (parseAmount(text) == null) return guidance({ code: 'missing_details', fields: ['amount'] });
  }
  return reply;
}

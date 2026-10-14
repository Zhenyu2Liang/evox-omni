/** Deterministic offline model entry point. Domain handlers propose calls; the gateway authorizes. */
import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai';
import { parseBankingGuidance, type BankingGuidance } from '../banking-guidance';
import { isConversationalRequest } from './mock/conversation-policy';
import { parseAmount } from './mock/amount-parser';
import { classify } from './mock/classifier';
import { contentToText, findLastUserIndex, findToolCall, lastToolResultAfter } from './mock/conversation';
import { extractProductName } from './mock/investment-intents';
import { narrate } from './mock/narration';
import { plain } from './mock/replies';
import { isTransferIntent, parseTransfer, priorTransferRecipient, refineTransfer } from './mock/transfer-intents';
import { declareMockTurn, declareMockReadPreparation, hasDeclarationTool, lastMockTurnDeclaration } from './mock/turn-declaration';
import { resolveMockResources } from './mock/resource-resolution';
import { isBulkCardFreezeRequest } from './mock/card-intents';
import { catalogEntry } from '@/lib/contracts/tool-catalog';

export interface MockContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: unknown[];
}

export function respond(context: MockContext): AssistantMessage {
  const messages = context.messages ?? [];
  const userIndex = findLastUserIndex(messages);
  const userText = userIndex >= 0 ? contentToText((messages[userIndex] as UserMessage).content).trim() : '';
  const lastResult = lastToolResultAfter(messages, userIndex, ['describe_turn']);
  const proposal = classify(userText, messages);
  const resolved = resolveMockResources(proposal, userText, messages, userIndex);
  if (hasDeclarationTool(context.tools, messages)) {
    const declaration = lastMockTurnDeclaration(messages, userIndex);
    const readPreparation = declaration?.purpose === 'operation' && !declaration.workflow &&
      declaration.operations.every(name => catalogEntry(name)?.effect === 'read');
    if (!declaration || readPreparation) {
      const lookup = resolved.content.find(part => part.type === 'toolCall' && catalogEntry(part.name)?.effect === 'read');
      const write = proposal.content.some(part => part.type === 'toolCall' &&
        (catalogEntry(part.name)?.effect === 'write' || part.name === 'submit_plan'));
      if ((write || isBulkCardFreezeRequest(userText)) && !resolved.content.some(part => part.type === 'toolCall')) return resolved;
      const prerequisite = lookup?.type === 'toolCall' && (write || isBulkCardFreezeRequest(userText));
      if (prerequisite) {
        if (lastResult?.toolName === lookup.name && lastResult.isError) return narrate(lastResult);
        if (catalogEntry(lookup.name)?.defaultTier === 'GREEN') return resolved;
        if (!declaration || !declaration.operations.includes(lookup.name)) return declareMockReadPreparation(lookup.name);
        return resolved;
      }
      if (!declaration || resolved.content.some(part => part.type === 'toolCall' &&
          (catalogEntry(part.name)?.effect === 'write' || part.name === 'submit_plan'))) {
        return declareMockTurn(userText, resolved);
      }
    }
  }
  const resourceCalls = proposal.content.filter(part => part.type === 'toolCall');
  const isResourceLookup = lastResult && ['get_cards', 'list_investments', 'get_investment_holdings', 'list_subscriptions'].includes(lastResult.toolName);
  if (!lastResult || isResourceLookup && !lastResult.isError && resourceCalls.some(call => call.name !== lastResult.toolName)) {
    return resolved;
  }
  if (lastResult) {
    const sourceCall = findToolCall(messages, lastResult.toolCallId);
    if (sourceCall?.name === 'search_contact' && isTransferIntent(userText)) return refineTransfer(userText, lastResult);
    return narrate(lastResult);
  }
  return proposal;
}

/** Preserve the same closed guidance protocol used by the live model. */
export function respondWithGuidance(context: MockContext): AssistantMessage {
  const reply = respond(context);
  if (reply.content.some(part => part.type === 'toolCall') || parseBankingGuidance(contentToText(reply.content))) return reply;
  const messages = context.messages ?? [];
  const userIndex = findLastUserIndex(messages);
  const text = userIndex < 0 ? '' : contentToText((messages[userIndex] as UserMessage).content);
  if (isConversationalRequest(text)) return reply;
  const lastResult = lastToolResultAfter(messages, userIndex, ['describe_turn']);
  const guidance = (value: BankingGuidance) => plain(JSON.stringify({ guidance: value }));
  if (isTransferIntent(text)) {
    const intent = parseTransfer(text);
    const fields: ('recipient' | 'amount')[] = [];
    if (!intent.recipient && (!intent.explicitReuse || !priorTransferRecipient(messages))) fields.push('recipient');
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

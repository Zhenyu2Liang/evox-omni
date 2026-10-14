import type { AssistantMessage, JsonObject, JsonValue, Message } from '@earendil-works/pi-ai';
import { toolCall, plain } from './replies';
import messagesText from './messages.zh-CN.json';

export type ResourceKind = 'card' | 'product' | 'holding' | 'subscription';
const LOOKUP: Record<ResourceKind, string> = {
  card: 'get_cards', product: 'list_investments', holding: 'get_investment_holdings', subscription: 'list_subscriptions',
};
const FIELD: Record<ResourceKind, string> = {
  card: 'cardId', product: 'productId', holding: 'holdingId', subscription: 'subscriptionId',
};
const TOOL_RESOURCE: Record<string, ResourceKind> = {
  freeze_card: 'card', unfreeze_card: 'card', report_lost_card: 'card', set_card_limit: 'card',
  subscribe_investment: 'product', redeem_investment: 'holding',
  cancel_subscription: 'subscription', set_subscription_reminder: 'subscription',
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function mockResourceRows(kind: ResourceKind, messages: readonly Message[], userIndex: number): Record<string, unknown>[] | undefined {
  const result = messages.slice(userIndex + 1).findLast(message => message.role === 'toolResult' && message.toolName === LOOKUP[kind]);
  if (result?.role !== 'toolResult' || result.isError) return;
  const data = record(result.details) && Object.hasOwn(result.details, 'data') ? result.details.data : result.details;
  const rows = Array.isArray(data) ? data : record(data) ? kind === 'product' ? data.products : data.holdings : undefined;
  return Array.isArray(rows) ? rows.filter(record).filter(row => typeof row.id === 'string') : [];
}

function select(kind: ResourceKind, selector: unknown, text: string, rows: Record<string, unknown>[]): string | undefined {
  const exact = rows.filter(row => row.id === selector);
  if (exact.length === 1) return exact[0].id as string;
  const named = rows.filter(row => [row.name, row.code, row.productName,
    record(row.product) ? row.product.name : undefined, record(row.product) ? row.product.code : undefined,
    row.numberMasked].some(value => typeof value === 'string' && value.length > 0 &&
      (value === selector || text.includes(value) || kind === 'card' && value.replace(/\D/g, '').length >= 4 &&
        text.includes(value.replace(/\D/g, '').slice(-4)))));
  if (named.length === 1) return named[0].id as string;
  if (kind === 'card') {
    const type = selector === 'card_debit' || /\u501f\u8bb0\u5361|\u50a8\u84c4\u5361/.test(text) ? 'DEBIT'
      : selector === 'card_credit' || /\u4fe1\u7528\u5361/.test(text) ? 'CREDIT' : undefined;
    const typed = type ? rows.filter(row => row.type === type) : rows;
    if (typed.length === 1) return typed[0].id as string;
  }
  return;
}

/** Mock writes bind actual IDs from registered read tools, never product names or seed guesses. */
export function resolveMockResources(proposal: AssistantMessage, text: string, messages: readonly Message[], userIndex: number): AssistantMessage {
  let lookup: string | undefined;
  let unresolved = false;
  const bind = (name: string, argumentsValue: JsonObject): JsonObject => {
    if (name === 'submit_plan' && Array.isArray(argumentsValue.nodes)) return { ...argumentsValue,
      nodes: argumentsValue.nodes.map(node => record(node) && typeof node.tool === 'string' && record(node.args)
        ? { ...node, args: bind(node.tool, node.args as JsonObject) } as JsonValue : node),
    };
    const kind = TOOL_RESOURCE[name];
    if (!kind) return argumentsValue;
    const rows = mockResourceRows(kind, messages, userIndex);
    if (!rows) {
      const failed = messages.slice(userIndex + 1).some(message => message.role === 'toolResult' && message.toolName === LOOKUP[kind] && message.isError);
      if (failed) unresolved = true; else lookup ??= LOOKUP[kind];
      return argumentsValue;
    }
    const id = select(kind, argumentsValue[FIELD[kind]], text, rows);
    if (!id) { unresolved = true; return argumentsValue; }
    return { ...argumentsValue, [FIELD[kind]]: id };
  };
  const content = proposal.content.map(part => part.type === 'toolCall' ? { ...part, arguments: bind(part.name, part.arguments) } : part);
  if (lookup) return toolCall(lookup, {});
  if (unresolved) return plain(messagesText.resourceSelectionRequired);
  return { ...proposal, content };
}

import type { ChatCard, ChatMessage } from '@/lib/contracts/agent';
import { TERMINAL_PENDING_ACTION_STATUSES } from '@/lib/contracts/security';

function decisionId(card: ChatCard): string | undefined {
  return card.type === 'confirmation' ? card.action.actionId : card.type === 'mfa' ? card.actionId : undefined;
}

function decisionStatus(card: ChatCard): string | undefined {
  return card.type === 'confirmation' ? (card.action as typeof card.action & { status?: string }).status
    : card.type === 'mfa' ? card.status : undefined;
}

/** Only the final prose after a fully successful operation may become a disclosure. */
export function canCompactResultExplanation(messages: readonly ChatMessage[], index: number, activeActionId?: string): boolean {
  const message = messages[index];
  let resultIndex = index - 1;
  while (resultIndex >= 0 && messages[resultIndex].role === 'assistant') resultIndex--;
  const result = messages[resultIndex];
  if (activeActionId || message?.role !== 'assistant' || messages[index + 1]?.role === 'assistant' ||
    !message.content || message.retryRequest || result?.role !== 'tool') return false;
  const decisions = result.cards?.filter(card => decisionId(card)) ?? [];
  if (decisions.length !== 1 || decisionStatus(decisions[0]) !== 'executed' ||
    !result.cards?.some(card => ['transfer', 'receipt', 'cards', 'investments', 'subscriptions', 'scheduled'].includes(card.type))) return false;
  if (result.cards.some(card => {
    if (!('data' in card) || !card.data || typeof card.data !== 'object' || Array.isArray(card.data)) return false;
    const data = card.data as Record<string, unknown>;
    return data.success === false || ['failed', 'unknown', 'needs_reconciliation'].includes(String(data.status));
  })) return false;
  let start = index - 1;
  while (start > 0 && messages[start - 1].role !== 'user') start--;
  return messages.slice(start, index).every(entry => entry.role !== 'system' && !entry.retryRequest &&
    (entry.toolEvents ?? []).every(event => event.status === 'success') &&
    (entry.cards ?? []).every(card => card.type !== 'error' &&
      (card.type !== 'plan' || card.plan.status === 'success') &&
      (!decisionId(card) || decisionStatus(card) === 'executed')));
}

/** Display-only coalescing by exact action identity; the stored conversation remains unchanged. */
export function presentationMessages(messages: readonly ChatMessage[], activeActionId?: string): ChatMessage[] {
  const owners = new Map<string, { message: number; card: number; terminal: boolean }>();
  messages.forEach((message, messageIndex) => message.cards?.forEach((card, cardIndex) => {
    const id = decisionId(card);
    const status = card.type === 'mfa' ? card.status : card.type === 'confirmation' ? (card.action as typeof card.action & { status?: string }).status : undefined;
    const terminal = TERMINAL_PENDING_ACTION_STATUSES.some(value => value === status);
    if (id && (!owners.get(id)?.terminal || terminal)) owners.set(id, { message: messageIndex, card: cardIndex, terminal });
  }));
  return messages.map((message, messageIndex) => ({ ...message,
    cards: message.cards?.filter((card, cardIndex) => {
      const id = decisionId(card);
      if (!id) return true;
      const owner = owners.get(id)!;
      return (id !== activeActionId || owner.terminal) && owner.message === messageIndex && owner.card === cardIndex;
    }),
    toolEvents: message.toolEvents?.filter(event => !(activeActionId && event.actionId === activeActionId && event.status === 'blocked')),
  }));
}

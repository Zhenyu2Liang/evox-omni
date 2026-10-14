import type { ChatCard, ChatMessage } from '@/lib/contracts/agent';

function actionId(card: ChatCard): string | undefined {
  return card.type === 'mfa' ? card.actionId : card.type === 'confirmation' ? card.action.actionId : undefined;
}

/** Normalize saved UI projections without deleting or rewriting any model archive message. */
export function normalizePresentationMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.flatMap(message => {
    if (message.role !== 'assistant' || !message.cards?.length && !message.toolEvents?.length) return [message];
    const remaining = new Set(message.cards ?? []);
    const tools = (message.toolEvents ?? []).map((event, index): ChatMessage => {
      const id = `${message.id}:tool:${encodeURIComponent(event.toolCallId)}:${index}`;
      const cards = [...remaining].filter(card => event.actionId && actionId(card) === event.actionId ||
        message.toolEvents?.length === 1 && card.type !== 'plan' && actionId(card) === undefined);
      cards.forEach(card => remaining.delete(card));
      return { id, role: 'tool', content: '', timestamp: message.timestamp, cards,
        toolEvents: [{ ...event, messageId: id }] };
    });
    const cards: ChatMessage[] = remaining.size ? [{ id: `${message.id}:cards`, role: 'system', content: '',
      timestamp: message.timestamp, cards: [...remaining], toolEvents: [] }] : [];
    const prose: ChatMessage[] = message.content || message.retryRequest
      ? [{ ...message, cards: [], toolEvents: [] }] : [];
    return [...tools, ...cards, ...prose];
  });
}

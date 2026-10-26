import type { ChatCard, ChatMessage } from '@/lib/contracts/agent';
import { TERMINAL_PENDING_ACTION_STATUSES } from '@/lib/contracts/security';

function decisionId(card: ChatCard): string | undefined {
  return card.type === 'confirmation' ? card.action.actionId : card.type === 'mfa' ? card.actionId : undefined;
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

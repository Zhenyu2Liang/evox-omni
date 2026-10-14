import type { ChatMessage } from './contracts/agent';
import type { TaskPlan } from './contracts/task';

/** A plan belongs to its tool row or an independent workflow record. */
export function placePlanInHistory(messages: readonly ChatMessage[], plan: TaskPlan, ownerId?: string): ChatMessage[] {
  const existingOwner = messages.find(message => message.cards?.some(card => card.type === 'plan' && card.plan.id === plan.id));
  const owner = existingOwner ?? messages.find(message => message.id === ownerId && message.role === 'tool');
  const projected: ChatMessage[] = messages.map(message => {
    const cards = (message.cards ?? []).filter(card => card.type !== 'plan' || card.plan.id !== plan.id);
    if (message.id === owner?.id) cards.push({ type: 'plan', plan });
    return { ...message, cards };
  });
  if (owner) return projected;
  const record: ChatMessage = { id: `plan-history-${plan.id}`, role: 'system', content: '',
    timestamp: plan.createdAt, cards: [{ type: 'plan', plan }] };
  // Missing provider messages can occur after a crash. Insert a durable record at its creation
  // time without guessing that an unrelated later reply owns this plan.
  const next = projected.findIndex(message => message.timestamp > plan.createdAt);
  projected.splice(next < 0 ? projected.length : next, 0, record);
  return projected;
}

export function historyPlan(messages: readonly ChatMessage[], id: string): TaskPlan | undefined {
  for (const message of messages) {
    const card = message.cards?.find(candidate => candidate.type === 'plan' && candidate.plan.id === id);
    if (card?.type === 'plan') return card.plan;
  }
  return undefined;
}

/** Successful or cancelled plans are records; they must never return as a live footer panel. */
export function isActionablePlan(plan: TaskPlan): boolean {
  return plan.status !== 'success' && plan.status !== 'cancelled';
}

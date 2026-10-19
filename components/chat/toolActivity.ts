import type { ToolEventView } from '@/lib/contracts/agent';
import type { MessageKey } from '@/lib/i18n/shared';

export type ToolActivityCategory = 'query' | 'payment' | 'card' | 'investment' | 'workflow';

export const ACTIVITY_CATEGORY_KEYS: Record<ToolActivityCategory, MessageKey> = {
  query: 'chat.activity.query',
  payment: 'chat.activity.payment',
  card: 'chat.activity.card',
  investment: 'chat.activity.investment',
  workflow: 'chat.activity.workflow',
};

const TOOL_CATEGORIES: Record<string, ToolActivityCategory> = {
  get_balance: 'query', get_transactions: 'query', search_contact: 'query',
  search_conversation_history: 'query',
  analyze_spending: 'query', detect_anomaly: 'query', get_dashboard_summary: 'query',
  list_subscriptions: 'query', transfer_money: 'payment',
  get_cards: 'card', set_card_limit: 'card', freeze_card: 'card', unfreeze_card: 'card',
  report_lost_card: 'card', replace_card: 'card', apply_virtual_card: 'card',
  list_investments: 'investment', compare_investments: 'investment',
  get_investment_holdings: 'investment', subscribe_investment: 'investment', redeem_investment: 'investment',
  reserve_budget: 'workflow', list_scheduled_tasks: 'workflow', create_scheduled_task: 'workflow',
  cancel_subscription: 'workflow', set_subscription_reminder: 'workflow',
  submit_plan: 'workflow',
};

export interface ToolActivityGroup {
  category: ToolActivityCategory;
  events: ToolEventView[];
}

/** Retain call identity and the latest recorded status; never combine separate executions. */
export function groupToolActivity(events: ToolEventView[]): ToolActivityGroup[] {
  const calls = new Map<string, ToolEventView>();
  for (const event of events) calls.set(JSON.stringify([event.messageId, event.toolCallId]), event);
  const groups = new Map<ToolActivityCategory, ToolActivityGroup>();
  for (const event of calls.values()) {
    const category = Object.hasOwn(TOOL_CATEGORIES, event.toolName) ? TOOL_CATEGORIES[event.toolName] : 'workflow';
    let group = groups.get(category);
    if (!group) {
      group = { category, events: [] };
      groups.set(category, group);
    }
    group.events.push(event);
  }
  return [...groups.values()];
}

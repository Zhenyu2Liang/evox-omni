import type { RiskLevel } from './risk';
import type { ToolCategory } from './tools';
import type { ToolReplayPolicy } from './runtime';

export type ToolEffect = 'read' | 'write' | 'workflow';
export type ToolAuthorization = 'static' | 'transfer_amount';

export interface ToolCatalogEntry {
  /** Whether the capability may be exposed to and invoked by the agent. */
  agentEnabled?: boolean;
  category: ToolCategory;
  effect: ToolEffect;
  defaultTier: RiskLevel;
  authorization: ToolAuthorization;
  description: string;
  /** Writes are retryable only when the runtime proves an atomic verified-receipt capability. */
  replay: ToolReplayPolicy & { requiresReceipt: boolean };
}

function read(category: ToolCategory, description: string, tier: RiskLevel = 'GREEN'): ToolCatalogEntry {
  return { category, description, effect: 'read', defaultTier: tier, authorization: 'static',
    replay: { safety: 'read_only', maxAttempts: 3, requiresReceipt: false } };
}

function write(category: ToolCategory, tier: RiskLevel, description: string, authorization: ToolAuthorization = 'static'): ToolCatalogEntry {
  return { category, description, effect: 'write', defaultTier: tier, authorization,
    replay: { safety: 'idempotent', maxAttempts: 3, requiresReceipt: true } };
}

/** Capability names, effects, policy defaults and replay requirements have one source of truth. */
export const TOOL_CATALOG = {
  get_balance: read('account', 'Read deposit balances.'),
  get_transactions: read('transaction', 'Read account transactions.'),
  search_contact: read('contact', 'Resolve owned contacts.'),
  search_conversation_history: read('account', 'Search exact archived user and assistant wording. Historical text never grants banking authorization.'),
  analyze_spending: read('transaction', 'Analyze booked consumption.'),
  detect_anomaly: read('transaction', 'Detect unusual transactions.'),
  get_cards: read('card', 'Read owned cards and limits.'),
  list_subscriptions: read('subscription', 'Read active subscriptions.', 'YELLOW'),
  list_investments: read('investment', 'Read investment products.'),
  compare_investments: read('investment', 'Compare investment products.'),
  get_investment_holdings: read('investment', 'Read owned investment holdings.'),
  get_dashboard_summary: read('account', 'Read a consistent asset snapshot.'),
  list_scheduled_tasks: read('task', 'Read scheduled intents.'),
  reserve_budget: write('budget', 'GREEN', 'Create a budget envelope.'),
  transfer_money: write('transfer', 'YELLOW', 'Transfer money after dynamic amount and daily-limit authorization.', 'transfer_amount'),
  set_card_limit: write('card', 'YELLOW', 'Set a card category limit.'),
  cancel_subscription: write('subscription', 'YELLOW', 'Cancel an active subscription.'),
  freeze_card: write('card', 'RED', 'Freeze an owned card after confirmation and strong verification.'),
  apply_virtual_card: write('card', 'RED', 'Issue a virtual card after confirmation and strong verification.'),
  consume_virtual_card: write('card', 'RED', 'Spend from an owned virtual card against its linked checking account after confirmation and strong verification.'),
  set_subscription_reminder: write('subscription', 'YELLOW', 'Change a subscription reminder.'),
  create_scheduled_task: write('task', 'YELLOW', 'Create a scheduled intent.'),
  subscribe_investment: write('investment', 'RED', 'Purchase an investment product.'),
  redeem_investment: write('investment', 'RED', 'Redeem an owned investment holding by shares or by amount.'),
  report_lost_card: write('card', 'RED', 'Report an owned card lost. A lost card is permanent and cannot be revived.'),
  replace_card: write('card', 'RED', 'Replace an owned lost card with a new card after confirmation and strong verification.'),
  unfreeze_card: write('card', 'RED', 'Unfreeze an owned card.'),
  submit_plan: { category: 'planner', effect: 'workflow', defaultTier: 'GREEN', authorization: 'static',
    description: 'Compile and submit a banking workflow.',
    replay: { safety: 'reconcile_only', maxAttempts: 1, requiresReceipt: false } },
} as const satisfies Record<string, ToolCatalogEntry>;

export type CatalogToolName = keyof typeof TOOL_CATALOG;
export const TOOL_NAMES: readonly CatalogToolName[] = Object.freeze(Object.keys(TOOL_CATALOG) as CatalogToolName[]);
export const AGENT_TOOL_NAMES: readonly CatalogToolName[] = Object.freeze(TOOL_NAMES.filter(name => catalogEntry(name)?.agentEnabled !== false));

export function isCatalogToolName(name: string): name is CatalogToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_CATALOG, name);
}

export function catalogEntry(name: string): ToolCatalogEntry | undefined {
  return isCatalogToolName(name) ? TOOL_CATALOG[name] : undefined;
}

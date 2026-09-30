export type ToolName =
  | 'get_balance' | 'get_transactions' | 'search_contact' | 'analyze_spending' | 'detect_anomaly'
  | 'get_cards' | 'list_subscriptions' | 'list_investments' | 'compare_investments' | 'get_investment_holdings'
  | 'get_dashboard_summary' | 'list_scheduled_tasks' | 'reserve_budget'
  | 'transfer_money' | 'set_card_limit' | 'cancel_subscription' | 'freeze_card' | 'apply_virtual_card'
  | 'set_subscription_reminder' | 'create_scheduled_task'
  | 'subscribe_investment' | 'redeem_investment' | 'report_lost_card' | 'unfreeze_card' | 'change_password'
  | 'submit_plan';
export type ToolCategory =
  | 'account' | 'transaction' | 'contact' | 'transfer' | 'card' | 'subscription'
  | 'investment' | 'task' | 'budget' | 'planner' | 'security';
export interface ToolDescriptor { name: ToolName; category: ToolCategory; description: string; }

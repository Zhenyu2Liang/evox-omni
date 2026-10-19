/** Public business history deliberately excludes execution diagnostics and approval controls. */
export type ActivityType =
  | 'transfer' | 'card_freeze' | 'card_unfreeze' | 'card_lost' | 'card_limit'
  | 'card_replace' | 'card_apply' | 'card_add' | 'card_delete'
  | 'subscription_cancel' | 'subscription_reminder'
  | 'investment_purchase' | 'investment_redemption' | 'budget_reserve'
  | 'scheduled_task_create' | 'contact_add' | 'contact_delete'
  | 'transaction_acknowledgement';

export type ActivityStatus =
  | 'processing' | 'blocked' | 'awaiting_confirmation' | 'awaiting_verification'
  | 'completed' | 'incomplete' | 'cancelled' | 'locked' | 'needs_review';

export type ActivityVerification = 'passed' | 'failed' | 'pending' | 'not_required' | 'unknown';

export interface ActivityRecord {
  id: string;
  timestamp: number;
  type: ActivityType;
  status: ActivityStatus;
  verification: ActivityVerification;
}

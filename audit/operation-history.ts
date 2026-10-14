import type { ActivityRecord, ActivityStatus, ActivityType, ActivityVerification } from '@/lib/contracts/activity';
import { findOperationAuditLogs, type OperationAuditRow } from '@/lib/db/repositories/auditLog';
import { safeParse } from '@/lib/json';

const BUSINESS_OPERATIONS = {
  transfer_money: 'transfer',
  freeze_card: 'card_freeze',
  unfreeze_card: 'card_unfreeze',
  report_lost_card: 'card_lost',
  set_card_limit: 'card_limit',
  manual_add_card: 'card_add',
  manual_delete_card: 'card_delete',
  cancel_subscription: 'subscription_cancel',
  set_subscription_reminder: 'subscription_reminder',
  subscribe_investment: 'investment_purchase',
  redeem_investment: 'investment_redemption',
  reserve_budget: 'budget_reserve',
  create_scheduled_task: 'scheduled_task_create',
  add_contact: 'contact_add',
  delete_contact: 'contact_delete',
  acknowledge_transaction: 'transaction_acknowledgement',
} as const satisfies Record<string, ActivityType>;

const STATUSES: Record<string, ActivityStatus> = {
  allowed: 'processing', blocked: 'blocked', waiting_confirmation: 'awaiting_confirmation',
  waiting_verification: 'awaiting_verification', success: 'completed', failed: 'incomplete',
  cancelled: 'cancelled', locked: 'locked',
};

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function requiresReview(row: OperationAuditRow): boolean {
  // Reconciliation event identities are durable evidence, not a guess from error narration.
  if (row.dedupeKey?.startsWith('reconcile:')) return true;
  const result = object(row.toolResult === null ? undefined : safeParse<unknown>(row.toolResult, undefined));
  const data = object(result?.data);
  return [result, data].some(value => value?.status === 'needs_reconciliation' ||
    value?.outcome === 'unknown' || value?.needsReconciliation === true);
}

function verification(row: OperationAuditRow): ActivityVerification {
  if (!row.mfaRequired) return 'not_required';
  if (row.mfaResult === 'success') return 'passed';
  if (row.mfaResult === 'failed') return 'failed';
  if (row.status === 'waiting_confirmation' || row.status === 'waiting_verification') return 'pending';
  return 'unknown';
}

/** A field allowlist prevents diagnostics from escaping through future audit schema changes. */
export function projectOperationHistory(row: OperationAuditRow): ActivityRecord | undefined {
  if (!Object.hasOwn(BUSINESS_OPERATIONS, row.toolName)) return undefined;
  return {
    id: row.id,
    timestamp: row.timestamp.getTime(),
    type: BUSINESS_OPERATIONS[row.toolName as keyof typeof BUSINESS_OPERATIONS],
    status: requiresReview(row) ? 'needs_review'
      : Object.hasOwn(STATUSES, row.status) ? STATUSES[row.status] : 'incomplete',
    verification: verification(row),
  };
}

/** Read-only event timeline, scoped to the configured owner and conversation. */
export async function listOperationHistory(
  scope: { userId: string; sessionId: string; limit?: number },
): Promise<ActivityRecord[]> {
  const rows = await findOperationAuditLogs(scope, Object.keys(BUSINESS_OPERATIONS));
  return rows.flatMap(row => {
    const entry = projectOperationHistory(row);
    return entry ? [entry] : [];
  });
}

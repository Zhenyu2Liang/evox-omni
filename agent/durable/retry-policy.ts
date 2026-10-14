import { catalogEntry } from '@/lib/contracts/tool-catalog';
import type { ReplaySafety, RetryDecision, ToolInvocationStatus, ToolReplayPolicy } from '@/lib/contracts/runtime';

/** Only commands with owner/digest-checked, atomic receipts may enter this capability set. */
export interface RetryPolicyCapabilities {
  receiptBackedTools?: ReadonlySet<string>;
}

export function toolReplayPolicy(toolName: string, capabilities: RetryPolicyCapabilities = {}): ToolReplayPolicy {
  if (toolName === 'describe_turn') return { safety: 'read_only', maxAttempts: 3 };
  const entry = catalogEntry(toolName);
  if (entry?.replay.safety === 'read_only') return { safety: 'read_only', maxAttempts: entry.replay.maxAttempts };
  if (entry?.replay.requiresReceipt && capabilities.receiptBackedTools?.has(toolName)) {
    return { safety: 'idempotent', maxAttempts: entry.replay.maxAttempts };
  }
  return { safety: 'reconcile_only', maxAttempts: 1 };
}

export interface RetryState {
  status: ToolInvocationStatus;
  replaySafety: ReplaySafety;
  attempt: number;
  maxAttempts: number;
  resultJson?: string | null;
  errorCode?: string | null;
}

const PERMANENT_ERRORS = new Set([
  'VALIDATION', 'SECURITY_DENIED', 'MFA_FAILED', 'CIRCUIT_OPEN', 'CONFLICT',
  'NOT_FOUND', 'INSUFFICIENT_FUNDS', 'LIMIT_EXCEEDED', 'CANCELLED',
]);
const TRANSIENT_ERRORS = new Set(['TIMEOUT', 'RATE_LIMITED', 'UNAVAILABLE', 'CONNECTION_FAILED']);

/** Decide recovery without executing anything; no result or error code is inferred from model prose. */
export function decideInvocationRetry(state: RetryState, currentPolicy: ToolReplayPolicy): RetryDecision {
  if (state.status === 'completed' && state.resultJson != null) return { action: 'replay_result', resultJson: state.resultJson };
  if (state.status === 'completed') return { action: 'reconcile', reason: 'COMPLETED_RESULT_MISSING' };
  if (state.status === 'started') return { action: 'stop', reason: 'INVOCATION_IN_FLIGHT' };
  if (state.status === 'waiting_confirmation' || state.status === 'waiting_verification') return { action: 'wait_for_authorization' };
  if (state.status === 'cancelled' || (state.errorCode != null && PERMANENT_ERRORS.has(state.errorCode))) return { action: 'stop', reason: state.errorCode ?? 'CANCELLED' };
  if (state.replaySafety === 'reconcile_only' || currentPolicy.safety === 'reconcile_only' || state.status === 'needs_reconciliation') return { action: 'reconcile', reason: 'COMMIT_STATE_UNKNOWN' };
  if (state.replaySafety !== currentPolicy.safety) return { action: 'stop', reason: 'REPLAY_POLICY_CHANGED' };
  if (state.attempt >= Math.min(state.maxAttempts, currentPolicy.maxAttempts)) return { action: 'stop', reason: 'RETRY_LIMIT_REACHED' };
  if (state.status === 'failed' && (state.errorCode == null || !TRANSIENT_ERRORS.has(state.errorCode))) return { action: 'stop', reason: state.errorCode ?? 'NON_RETRYABLE_FAILURE' };
  return { action: 'retry', nextAttempt: state.attempt + 1 };
}

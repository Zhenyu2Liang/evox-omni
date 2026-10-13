/** Persisted runtime identities are independent of provider-assigned tool call IDs. */
export const WORKFLOW_EXECUTION_LEASE_MS = 600_000;

export type AgentRunStatus =
  | 'running' | 'waiting_confirmation' | 'waiting_verification'
  | 'completed' | 'failed' | 'interrupted';

export type RuntimeEventChannel = 'raw' | 'ui' | 'internal';
export type ReplaySafety = 'read_only' | 'idempotent' | 'reconcile_only';
export type ToolInvocationStatus =
  | 'started' | 'waiting_confirmation' | 'waiting_verification'
  | 'completed' | 'failed' | 'interrupted' | 'needs_reconciliation' | 'cancelled';

export interface AgentRunLease {
  runId: string;
  sessionId: string;
  userId: string;
  token: string;
}

export interface RuntimeEventRecord {
  id: string;
  runId: string;
  sequence: number;
  channel: RuntimeEventChannel;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface RuntimeEventPage {
  events: RuntimeEventRecord[];
  nextSequence: number;
  hasMore: boolean;
}

export interface ToolReplayPolicy {
  safety: ReplaySafety;
  maxAttempts: number;
}

export type RetryDecision =
  | { action: 'replay_result'; resultJson: string }
  | { action: 'retry'; nextAttempt: number }
  | { action: 'wait_for_authorization' }
  | { action: 'reconcile'; reason: string }
  | { action: 'stop'; reason: string };

/** A committed receipt must already have passed owner, tool, and request-digest checks. */
export interface VerifiedInvocationReceipt {
  operationKey: string;
  invocationId: string;
  resultJson: string;
}

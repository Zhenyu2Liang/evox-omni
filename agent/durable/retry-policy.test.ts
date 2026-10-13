import { describe, expect, it } from 'vitest';
import { decideInvocationRetry, toolReplayPolicy, type RetryState } from './retry-policy';

const interruptedRead: RetryState = { status: 'interrupted', replaySafety: 'read_only', attempt: 1, maxAttempts: 3 };

describe('tool replay policy', () => {
  it('permits reads and requires explicit receipt capability for every write', () => {
    expect(toolReplayPolicy('get_balance')).toEqual({ safety: 'read_only', maxAttempts: 3 });
    expect(toolReplayPolicy('transfer_money').safety).toBe('reconcile_only');
    expect(toolReplayPolicy('reserve_budget').safety).toBe('reconcile_only');
    expect(toolReplayPolicy('submit_plan').safety).toBe('reconcile_only');
    expect(toolReplayPolicy('transfer_money', { receiptBackedTools: new Set(['transfer_money']) }).safety).toBe('idempotent');
  });

  it('replays a completed result even after current policy becomes restrictive', () => {
    expect(decideInvocationRetry({ ...interruptedRead, status: 'completed', resultJson: '{"balance":"0.20"}' }, { safety: 'reconcile_only', maxAttempts: 1 })).toEqual({ action: 'replay_result', resultJson: '{"balance":"0.20"}' });
  });

  it('never upgrades a historical unsafe write to safe', () => {
    expect(decideInvocationRetry({ ...interruptedRead, replaySafety: 'reconcile_only' }, { safety: 'idempotent', maxAttempts: 3 }).action).toBe('reconcile');
  });

  it('bounds attempts and recognizes only structured transient failures', () => {
    const policy = { safety: 'read_only' as const, maxAttempts: 3 };
    expect(decideInvocationRetry(interruptedRead, policy)).toEqual({ action: 'retry', nextAttempt: 2 });
    expect(decideInvocationRetry({ ...interruptedRead, attempt: 3 }, policy).action).toBe('stop');
    expect(decideInvocationRetry({ ...interruptedRead, status: 'failed', errorCode: 'TIMEOUT' }, policy).action).toBe('retry');
    expect(decideInvocationRetry({ ...interruptedRead, status: 'failed', errorCode: 'VALIDATION' }, policy).action).toBe('stop');
    expect(decideInvocationRetry({ ...interruptedRead, status: 'failed', errorCode: 'TOOL_FAILED' }, policy).action).toBe('stop');
  });

  it('waits for confirmation and verification and never retries cancellation', () => {
    const policy = { safety: 'idempotent' as const, maxAttempts: 3 };
    expect(decideInvocationRetry({ ...interruptedRead, status: 'waiting_confirmation' }, policy).action).toBe('wait_for_authorization');
    expect(decideInvocationRetry({ ...interruptedRead, status: 'waiting_verification' }, policy).action).toBe('wait_for_authorization');
    expect(decideInvocationRetry({ ...interruptedRead, status: 'cancelled' }, policy).action).toBe('stop');
  });
});

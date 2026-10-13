import type { ToolInvocation } from '@prisma/client';
import type { AgentRunLease, RetryDecision, RuntimeEventPage, RuntimeEventChannel } from '@/lib/contracts/runtime';
import { claimInvocationRetry, getAgentRunForUser, listPresentationEvents, listRecoverableAgentRuns, listRunInvocations, restoreInvocationFromReceipt, settleRecoveredInvocation, verifyAgentRunLease } from '@/lib/db/repositories/agentRun';
import { AppError } from '@/lib/errors';
import { decideInvocationRetry, toolReplayPolicy, type RetryPolicyCapabilities } from './retry-policy';
import { encodeRuntimeValue } from './serialization';

export interface InvocationRecovery {
  invocation: ToolInvocation;
  decision: RetryDecision;
}

/** Worker inspection produces decisions only; it never retries or grants authorization. */
export async function inspectRunRecovery(runId: string, userId: string, capabilities: RetryPolicyCapabilities = {}): Promise<InvocationRecovery[]> {
  if (!(await getAgentRunForUser(runId, userId))) throw new AppError('NOT_FOUND', 'Agent run not found');
  return (await listRunInvocations(runId)).map(invocation => ({
    invocation,
    decision: decideInvocationRetry({
      status: invocation.status as Parameters<typeof decideInvocationRetry>[0]['status'],
      replaySafety: invocation.replaySafety as Parameters<typeof decideInvocationRetry>[0]['replaySafety'],
      attempt: invocation.attempt,
      maxAttempts: invocation.maxAttempts,
      resultJson: invocation.resultJson,
      errorCode: invocation.errorCode,
    }, toolReplayPolicy(invocation.toolName, capabilities)),
  }));
}

/** Reconnection reads the grounded channel only, leaving raw reasoning and arguments internal. */
export async function readRunPresentation(runId: string, userId: string, afterSequence = 0, limit = 100): Promise<RuntimeEventPage> {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new AppError('VALIDATION', 'Invalid runtime event cursor');
  const records = await listPresentationEvents(runId, userId, afterSequence, limit + 1);
  const hasMore = records.length > limit;
  const page = records.slice(0, limit);
  return {
    events: page.map(record => ({ id: record.id, runId: record.runId, sequence: record.sequence, channel: record.channel as RuntimeEventChannel, eventType: record.eventType, payload: JSON.parse(record.payloadJson) as unknown, createdAt: record.createdAt.toISOString() })),
    nextSequence: page.at(-1)?.sequence ?? afterSequence,
    hasMore,
  };
}

/** Hosts decide when to wake a worker; discovery is bounded and never starts detached work. */
export async function wakeRecoverableRuns(wake: (runId: string) => Promise<void>, limit = 100): Promise<number> {
  const runs = await listRecoverableAgentRuns(new Date(), Math.min(Math.max(limit, 1), 100));
  for (const run of runs) await wake(run.id);
  return runs.length;
}

export interface InvocationRecoveryPort {
  /** Verify the domain receipt's owner, normalized request digest, tool, and operation identity. */
  readVerifiedReceipt(invocation: ToolInvocation): Promise<string | undefined>;
  /** Writes must use the authorization service, operation key, and transaction execution fence. */
  execute(invocation: ToolInvocation): Promise<string>;
  /** Only a trusted command adapter can prove that a failed write committed nothing. */
  classifyFailure?(error: unknown): { code: string; commitState: 'not_committed' | 'unknown' };
}

export type InvocationRecoveryOutcome =
  | { action: 'replayed' | 'recovered' | 'retried'; invocationId: string; resultJson: string }
  | { action: 'waiting' | 'reconciliation_required' | 'stopped'; invocationId: string; reason: string };

/** Recover exactly one original invocation; this never creates another operation identity. */
export async function recoverInvocation(lease: AgentRunLease, invocationId: string, port: InvocationRecoveryPort, capabilities: RetryPolicyCapabilities = {}): Promise<InvocationRecoveryOutcome> {
  await verifyAgentRunLease(lease);
  const invocation = (await listRunInvocations(lease.runId)).find(item => item.id === invocationId);
  if (!invocation) throw new AppError('NOT_FOUND', 'Tool invocation not found');
  if (invocation.status === 'completed' && invocation.resultJson != null) return { action: 'replayed', invocationId, resultJson: invocation.resultJson };
  const restore = async (resultJson: string): Promise<InvocationRecoveryOutcome> => {
    await restoreInvocationFromReceipt({ invocationId, userId: lease.userId, toolName: invocation.toolName, operationKey: invocation.operationKey, resultJson });
    return { action: 'recovered', invocationId, resultJson };
  };
  const receipt = await port.readVerifiedReceipt(invocation);
  if (receipt !== undefined) return restore(receipt);
  const decision = decideInvocationRetry({
    status: invocation.status as Parameters<typeof decideInvocationRetry>[0]['status'], replaySafety: invocation.replaySafety as Parameters<typeof decideInvocationRetry>[0]['replaySafety'],
    attempt: invocation.attempt, maxAttempts: invocation.maxAttempts, resultJson: invocation.resultJson, errorCode: invocation.errorCode,
  }, toolReplayPolicy(invocation.toolName, capabilities));
  if (decision.action === 'wait_for_authorization') return { action: 'waiting', invocationId, reason: 'AUTHORIZATION_REQUIRED' };
  if (decision.action === 'reconcile') return { action: 'reconciliation_required', invocationId, reason: decision.reason };
  if (decision.action === 'stop') return { action: 'stopped', invocationId, reason: decision.reason };
  if (decision.action === 'replay_result') return { action: 'replayed', invocationId, resultJson: decision.resultJson };
  const claimed = await claimInvocationRetry(lease, invocationId, invocation.attempt, {
    channel: 'internal', eventType: 'invocation_retry_started', payloadJson: JSON.stringify({ invocationId, attempt: decision.nextAttempt }),
  });
  try {
    const resultJson = await port.execute(claimed);
    if (claimed.replaySafety === 'idempotent') {
      const committed = await port.readVerifiedReceipt(claimed);
      if (committed === undefined) {
        await settleRecoveredInvocation(lease, invocationId, claimed.attempt, 'needs_reconciliation', undefined, 'COMMITTED_RECEIPT_MISSING');
        return { action: 'reconciliation_required', invocationId, reason: 'COMMITTED_RECEIPT_MISSING' };
      }
      return restore(committed);
    }
    const safeResult = encodeRuntimeValue(JSON.parse(resultJson) as unknown);
    await settleRecoveredInvocation(lease, invocationId, claimed.attempt, 'completed', safeResult, undefined);
    return { action: 'retried', invocationId, resultJson: safeResult };
  } catch (error) {
    // A command can commit and lose its HTTP/event response. Check the receipt before calling it a failure.
    const committed = await port.readVerifiedReceipt(claimed);
    if (committed !== undefined) return restore(committed);
    const failure = port.classifyFailure?.(error) ?? { code: errorCode(error), commitState: 'unknown' as const };
    const unknownWrite = claimed.replaySafety === 'idempotent' && failure.commitState === 'unknown';
    await settleRecoveredInvocation(lease, invocationId, claimed.attempt, unknownWrite ? 'needs_reconciliation' : 'failed', undefined, failure.code);
    return { action: unknownWrite ? 'reconciliation_required' : 'stopped', invocationId, reason: failure.code };
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'TOOL_FAILED';
}

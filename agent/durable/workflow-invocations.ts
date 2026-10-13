import type { GatewayContext } from '@/security/security-gateway';
import { TOOL_NAMES } from '@/lib/contracts/tool-catalog';
import { isWriteTool } from '@/security/permission-engine';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { beginWorkflowInvocation, assertWorkflowInvocationClaim, retryWorkflowInvocation, finishWorkflowInvocation } from '@/lib/db/repositories/workflowInvocation';
import { toolReplayPolicy, decideInvocationRetry } from './retry-policy';
import { encodeRuntimeValue, runtimeRequestDigest } from './serialization';
import type { GatedToolOutcome } from '../confirmation/contracts';
import { currentWorkflowExecutionClaim } from '../workflows/execution-context';
import { prepareBankingCommand } from '@/lib/contracts/command';
import { readCommandReceipt } from '../command-execution';
import { decideConvergence, buildRecoveryAudit, convergenceAuditKey } from '../execution-convergence';
import { settlePendingAction } from '../confirmation-recovery';
import { idempotentTransferTxId } from '@/lib/ledger';

const capabilities = { receiptBackedTools: new Set(TOOL_NAMES.filter(isWriteTool)) };
export { resumeOriginalRunTask } from './workflow-resumption';

/** All Pi, HTTP and scheduler DAG drivers share the same durable child invocation. */
export async function runWorkflowInvocation(context: GatewayContext, execute: (context: GatewayContext) => Promise<GatedToolOutcome>): Promise<GatedToolOutcome> {
  if (context.taskId === undefined && context.nodeId === undefined) return execute(context);
  if (!context.taskId || !context.nodeId) throw new AppError('CONFLICT', 'Workflow invocation identity is incomplete');
  const input = {
    sessionId: context.sessionId, userId: context.userId, taskId: context.taskId, nodeId: context.nodeId,
    toolName: context.toolName, argsJson: encodeRuntimeValue(context.args), requestDigest: runtimeRequestDigest(context.toolName, context.args),
    policy: toolReplayPolicy(context.toolName, capabilities),
    expectedClaim: currentWorkflowExecutionClaim(),
  };
  let claim = await beginWorkflowInvocation(input, context.runtimeFence);
  if (claim.invocation.status === 'completed') {
    const result = safeParse<GatedToolOutcome | null>(claim.invocation.resultJson, null);
    if (!result || typeof result.ok !== 'boolean') throw new AppError('CONFLICT', 'Completed workflow invocation has no valid result');
    if (isWriteTool(context.toolName)) {
      const action = await prisma.pendingAction.findFirst({ where: { invocationId: claim.invocation.id,
        userId: context.userId, sessionId: context.sessionId }, orderBy: { createdAt: 'desc' } });
      const args = action ? safeParse<Record<string, unknown> | null>(action.argsJson, null) : context.args;
      if (!args) throw new AppError('CONFLICT', 'Workflow command arguments are missing');
      const verified = await readCommandReceipt(prepareBankingCommand(context.userId, claim.invocation.operationKey, context.toolName, args));
      if (!verified || runtimeRequestDigest('workflow_result', verified.data) !== runtimeRequestDigest('workflow_result', result.data)) {
        throw new AppError('CONFLICT', 'Completed workflow invocation has no matching verified receipt');
      }
      // The bank transaction may be complete while the action's terminal status was lost.
      // Reconcile that exact action without returning through a gate or another SDK call.
      if (action?.status === 'confirmed') {
        const decision = await decideConvergence(action);
        if (decision.write) await settlePendingAction({ actionId: action.id, status: decision.status, result: decision.result,
          from: ['confirmed'], audit: buildRecoveryAudit(action, decision), dedupeKey: convergenceAuditKey(action.id, decision.status) });
      }
    }
    return result;
  }
  if (['cancelled', 'needs_reconciliation'].includes(claim.invocation.status)) throw new AppError('CONFLICT', 'Workflow invocation requires an explicit human decision');
  if (claim.invocation.status === 'failed' || claim.invocation.status === 'interrupted' || (!claim.created && claim.invocation.status === 'started')) {
    const status = claim.invocation.status === 'started' ? 'interrupted' : claim.invocation.status;
    const decision = decideInvocationRetry({ ...claim.invocation, status, replaySafety: claim.invocation.replaySafety as 'read_only' | 'idempotent' | 'reconcile_only' }, input.policy);
    let userRetry = false;
    if (input.expectedClaim?.explicitRetry && claim.invocation.status === 'failed') {
      if (!isWriteTool(context.toolName)) userRetry = true;
      else {
        const failedAction = await prisma.pendingAction.findFirst({ where: { invocationId: claim.invocation.id,
          userId: context.userId, sessionId: context.sessionId, status: 'failed' }, orderBy: { createdAt: 'desc' } });
        const failedResult = safeParse<{ ok?: boolean } | null>(failedAction?.resultJson, null);
        const receipt = await prisma.executionReceipt.findUnique({ where: { userId_key: { userId: context.userId, key: claim.invocation.operationKey } } });
        const ledger = context.toolName === 'transfer_money'
          ? await prisma.transaction.findUnique({ where: { id: idempotentTransferTxId(context.userId, claim.invocation.operationKey) } }) : null;
        // A settled negative command outcome proves the SDK transaction rolled back. The retry
        // re-enters the gateway and still requires a fresh human decision before any bank write.
        userRetry = failedResult?.ok === false && receipt === null && ledger === null;
      }
    }
    if (decision.action !== 'retry' && !userRetry) throw new AppError('CONFLICT', 'Workflow invocation is not eligible for retry');
    claim = await retryWorkflowInvocation(input, claim);
  }
  await assertWorkflowInvocationClaim(input, claim, prisma);
  const result = await execute({ ...context, invocationId: claim.invocation.id, runtimeFence: async client => {
    await context.runtimeFence?.(client);
    await assertWorkflowInvocationClaim(input, claim, client);
  } });
  const action = result.pendingActionId ? await prisma.pendingAction.findUnique({ where: { id: result.pendingActionId }, select: { requiresMfa: true } }) : null;
  const status = result.requiresConfirmation ? action?.requiresMfa ? 'waiting_verification' : 'waiting_confirmation' : result.ok ? 'completed' : 'failed';
  await finishWorkflowInvocation(input, claim, status, encodeRuntimeValue(result), result.ok || result.requiresConfirmation ? undefined : result.errorCode ?? 'TOOL_FAILED', context.runtimeFence);
  return result;
}

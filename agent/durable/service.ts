import type { AgentRun, ToolInvocation } from '@prisma/client';
import { AppError } from '@/lib/errors';
import { safeParse, toJson } from '@/lib/json';
import { prepareBankingCommand } from '@/lib/contracts/command';
import type { ToolName } from '@/lib/contracts/tools';
import type { AgentRunStatus } from '@/lib/contracts/runtime';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { beginAgentRun, finalizeReceiptedAgentRun, getAgentRun, listRunInvocations, restoreInvocationFromReceipt, runPendingActionWhere, synchronizeRunActionInvocations, scheduleRunRecovery, settlePlanInvocation, stopObsoleteRun, parkRunRecovery } from '@/lib/db/repositories/agentRun';
import { prisma } from '@/lib/db/client';
import { createToolRegistry, TOOL_NAMES } from '@/agent/tools';
import { isWriteTool } from '@/security/permission-engine';
import { readCommandReceipt } from '@/agent/command-execution';
import { AgentRunJournal } from './journal';
import { recoverInvocation, type InvocationRecoveryOutcome } from './recovery';
import { toolReplayPolicy } from './retry-policy';
import { continueDurableRun, restoreWaitingCheckpoint, type ContinuationDependencies } from './continuation';
import { resumeOriginalRunTask } from './workflow-resumption';
import type { TaskPlan } from '@/lib/contracts/task';
import { runtimeRequestDigest } from './serialization';
import { security } from '@/security';
import { recoverStandaloneWorkflowRun } from './standalone-workflow';

export interface RunIdentity { sessionId: string; userId: string; }
export interface InvocationSummary {
  id: string;
  ordinal: number;
  toolName: string;
  status: string;
  replaySafety: string;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  finishedAt: string | null;
  origin: string;
  parentInvocationId: string | null;
  taskId: string | null;
  nodeId: string | null;
  modelRequestId: string | null;
}
export interface AgentRunSummary {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  lastSequence: number;
  invocations: InvocationSummary[];
}
export interface RunRecoveryResponse {
  run: AgentRunSummary;
  message: string;
  outcomes: Array<{ invocationId: string; action: InvocationRecoveryOutcome['action']; reason?: string }>;
}

async function ownedRun(runId: string, identity: RunIdentity): Promise<AgentRun> {
  const run = await getAgentRun(runId);
  if (!run) throw new AppError('NOT_FOUND', 'Agent run not found');
  if (run.sessionId !== identity.sessionId || run.userId !== identity.userId) throw new AppError('SECURITY_DENIED', 'This session does not own the agent run');
  return run;
}

/** Public metadata never contains model messages, reasoning, arguments, request text, or lease tokens. */
export async function getOwnedRunSummary(runId: string, identity: RunIdentity): Promise<AgentRunSummary> {
  const run = await ownedRun(runId, identity);
  const invocations = await listRunInvocations(runId);
  return {
    id: run.id, status: run.status, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
    errorCode: run.errorCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(run.errorCode) ? run.errorCode : null,
    lastSequence: run.nextSequence,
    invocations: invocations.map(invocation => ({
      id: invocation.id, ordinal: invocation.ordinal, toolName: TOOL_NAMES.includes(invocation.toolName as ToolName) ? invocation.toolName : 'unknown_tool',
      status: invocation.status, replaySafety: invocation.replaySafety, attempt: invocation.attempt, maxAttempts: invocation.maxAttempts,
      startedAt: invocation.startedAt.toISOString(), finishedAt: invocation.finishedAt?.toISOString() ?? null,
      origin: invocation.origin, parentInvocationId: invocation.parentInvocationId, taskId: invocation.taskId,
      nodeId: invocation.nodeId, modelRequestId: invocation.modelRequestId,
    })),
  };
}

/** Use immutable server-resolved command arguments for gated calls, avoiding mutable entity lookup. */
async function commandArgs(invocation: ToolInvocation, run: AgentRun): Promise<Record<string, unknown>> {
  let action = await prisma.pendingAction.findFirst({ where: { invocationId: invocation.id, sessionId: run.sessionId, userId: run.userId } });
  if (!action) action = await prisma.pendingAction.findFirst({ where: { id: invocation.operationKey, sessionId: run.sessionId, userId: run.userId } });
  if (!action && invocation.operationKey.startsWith('nxe:')) {
    const [, taskId, nodeId] = invocation.operationKey.split(':');
    if (taskId && nodeId) action = await prisma.pendingAction.findFirst({ where: { taskId, nodeId, sessionId: run.sessionId, userId: run.userId }, orderBy: { createdAt: 'desc' } });
  }
  return safeParse<Record<string, unknown>>(action?.argsJson ?? invocation.argsJson, {});
}

async function verifiedResponse(invocation: ToolInvocation, run: AgentRun): Promise<string | undefined> {
  if (!TOOL_NAMES.includes(invocation.toolName as ToolName) || invocation.toolName === 'submit_plan') return;
  const command = prepareBankingCommand(run.userId, invocation.operationKey, invocation.toolName as ToolName, await commandArgs(invocation, run));
  const result = await readCommandReceipt(command);
  return result ? toJson(result) : undefined;
}

/** Explicit recovery restores facts or retries reads. It never authorizes or replays a bank write. */
export async function recoverOwnedRun(runId: string, identity: RunIdentity, invocationId?: string, deps: ContinuationDependencies = {}): Promise<RunRecoveryResponse> {
  const original = await ownedRun(runId, identity);
  if (original.checkpointStage === 'workflow_only') {
    const result = await recoverStandaloneWorkflowRun(original, deps.onEvent, invocationId);
    return { ...result, run: await getOwnedRunSummary(runId, identity) };
  }
  await synchronizeRunActionInvocations(runId, identity.sessionId, identity.userId);
  const invocations = await listRunInvocations(runId);
  const selected = invocationId ? invocations.filter(invocation => invocation.id === invocationId) : invocations;
  if (invocationId && selected.length === 0) throw new AppError('NOT_FOUND', 'Tool invocation not found');
  const outcomes: RunRecoveryResponse['outcomes'] = [];
  const planResumeIds = new Set<string>();
  // Receipt facts are safe to recover even when a confirmation run currently owns the session.
  // Every completed fact used by model continuation must be verified, even for a selected retry.
  for (const invocation of invocations.filter(item => selected.includes(item) || item.status === 'completed')) {
    if (invocation.status === 'completed' && invocation.resultJson !== null) {
      if (invocation.toolName === 'submit_plan' && original.checkpointJson && original.checkpointStage !== 'session_committed') {
        const tasks = await prisma.agentTask.findMany({ where: { runId, parentInvocationId: invocation.id }, select: { id: true, status: true } });
        const result = safeParse<{ data?: { id?: unknown; status?: unknown } }>(invocation.resultJson, {});
        if (tasks.length !== 1 || result.data?.id !== tasks[0]?.id || ['paused', 'cancelled', 'failed'].includes(tasks[0].status)) {
          outcomes.push({ invocationId: invocation.id, action: 'reconciliation_required', reason: 'WORKFLOW_REQUIRES_ATTENTION' });
          continue;
        }
        if (tasks[0].status !== 'success' || result.data.status !== 'success') { planResumeIds.add(invocation.id); continue; }
      }
      if (catalogEntry(invocation.toolName)?.effect === 'write') {
        try {
          const response = await verifiedResponse(invocation, original);
          const stored = safeParse<{ ok?: boolean; data?: unknown }>(invocation.resultJson, {});
          const verified = safeParse<{ ok?: boolean; data?: unknown }>(response, {});
          if (verified.ok !== true || stored.ok !== true || runtimeRequestDigest('tool_result', verified.data) !== runtimeRequestDigest('tool_result', stored.data)) throw new AppError('CONFLICT', 'The completed tool outcome has no matching committed receipt');
        } catch {
          outcomes.push({ invocationId: invocation.id, action: 'reconciliation_required', reason: 'COMMITTED_RECEIPT_INVALID' });
          continue;
        }
      }
      outcomes.push({ invocationId: invocation.id, action: 'replayed' }); continue;
    }
    if (invocation.status === 'cancelled') { outcomes.push({ invocationId: invocation.id, action: 'stopped', reason: 'CANCELLED' }); continue; }
    try {
      const resultJson = await verifiedResponse(invocation, original);
      if (resultJson !== undefined) {
        await restoreInvocationFromReceipt({ invocationId: invocation.id, userId: original.userId, toolName: invocation.toolName, operationKey: invocation.operationKey, resultJson });
        outcomes.push({ invocationId: invocation.id, action: 'recovered' });
      }
    } catch {
      outcomes.push({ invocationId: invocation.id, action: 'reconciliation_required', reason: 'COMMITTED_RECEIPT_INVALID' });
    }
  }
  if (!outcomes.some(item => item.action === 'reconciliation_required')) await finalizeReceiptedAgentRun(runId, identity.sessionId, identity.userId);
  const current = await ownedRun(runId, identity);
  if (current.status === 'completed') {
    if (outcomes.some(item => item.action === 'reconciliation_required')) throw new AppError('CONFLICT', 'The saved completed outcome requires manual receipt reconciliation');
    return { run: await getOwnedRunSummary(runId, identity), outcomes, message: 'Previously committed results were recovered. No bank write was repeated.' };
  }
  if (current.status === 'failed' && current.errorCode === 'CANCELLED') return { run: await getOwnedRunSummary(runId, identity), outcomes, message: 'The original operation was cancelled. No operation was repeated.' };
  if (current.status === 'waiting_confirmation' || current.status === 'waiting_verification') {
    for (const invocation of selected.filter(invocation => !outcomes.some(outcome => outcome.invocationId === invocation.id))) outcomes.push({ invocationId: invocation.id, action: 'waiting', reason: 'AUTHORIZATION_REQUIRED' });
    return { run: await getOwnedRunSummary(runId, identity), outcomes, message: 'The original confirmation or verification is still required.' };
  }
  if (current.checkpointJson && await stopObsoleteRun(runId)) throw new AppError('CONFLICT', 'A newer conversation revision prevents continuation');
  const admitted = await beginAgentRun({ sessionId: current.sessionId, userId: current.userId,
    requestId: current.requestId ?? undefined, requestDigest: current.requestDigest, requestJson: current.requestJson,
    existingRunId: current.id, recover: true });
  if (!admitted.lease) throw new AppError('CONFLICT', 'This agent run is already owned by a live execution');
  const journal = new AgentRunJournal(admitted.lease, { receiptBackedTools: new Set(TOOL_NAMES.filter(isWriteTool)) });
  const stopHeartbeat = journal.startHeartbeat();
  try {
    const registry = createToolRegistry(identity.userId);
    for (const invocation of invocations.filter(item => (selected.includes(item) || planResumeIds.has(item.id)) && !outcomes.some(outcome => outcome.invocationId === item.id))) {
      if (invocation.origin === 'workflow') continue;
      if (invocation.toolName === 'submit_plan') {
        const result = await resumeOriginalRunTask(runId, invocation.id, client => journal.assertLeaseOwned(client), async plan => {
          const event = { type: 'plan_update' as const, plan };
          await journal.recordPresentationEvent(event); await deps.onEvent?.(event);
        });
        if (result) {
          const plan = result.data as TaskPlan;
          const waiting = plan.results.some(node => node.status === 'waiting_verification') ? 'waiting_verification' as const
            : plan.status === 'waiting_confirmation' ? 'waiting_confirmation' as const : undefined;
          if (!result.ok || ['failed', 'cancelled', 'paused'].includes(plan.status)) {
            outcomes.push({ invocationId: invocation.id, action: 'reconciliation_required', reason: 'WORKFLOW_REQUIRES_ATTENTION' });
          } else {
            await settlePlanInvocation(admitted.lease, invocation.id, toJson(result), waiting);
            outcomes.push({ invocationId: invocation.id, action: waiting ? 'waiting' : 'recovered' });
          }
          continue;
        }
      }
      const definition = catalogEntry(invocation.toolName);
      if (definition?.effect === 'read' && definition.defaultTier !== 'GREEN') {
        outcomes.push({ invocationId: invocation.id, action: 'waiting', reason: 'AUTHORIZATION_REQUIRED' });
        continue;
      }
      const outcome = await recoverInvocation(admitted.lease, invocation.id, {
        readVerifiedReceipt: item => verifiedResponse(item, current),
        execute: async item => {
          if (toolReplayPolicy(item.toolName).safety !== 'read_only' || catalogEntry(item.toolName)?.defaultTier !== 'GREEN') throw new AppError('SECURITY_DENIED', 'This tool requires its original authorization workflow');
          await journal.assertLeaseOwned(prisma);
          const args = safeParse<Record<string, unknown>>(item.argsJson, {});
          const auth = await security.gateway.securityGateway.handleToolCall({ sessionId: identity.sessionId, userId: identity.userId,
            toolName: item.toolName as ToolName, args, userRequest: safeParse<{ message?: string }>(current.requestJson, {}).message ?? '', invocationId: item.id });
          if (auth.evaluation.blocked || auth.action) throw new AppError('SECURITY_DENIED', 'The original read is no longer authorized for automatic recovery');
          const result = await registry.executeDirect(item.toolName as ToolName, args);
          if (!result.ok) throw new AppError('TOOL_FAILED', 'The read operation failed during recovery');
          return toJson(result);
        },
      });
      outcomes.push({ invocationId: outcome.invocationId, action: outcome.action, ...('reason' in outcome ? { reason: outcome.reason } : {}) });
    }
    const remaining = await listRunInvocations(runId);
    const pending = await prisma.pendingAction.findMany({ where: { ...runPendingActionWhere(identity.sessionId, identity.userId, remaining), status: { in: ['pending', 'awaiting_mfa', 'confirmed', 'needs_reconciliation'] } }, select: { status: true } });
    let status: Exclude<AgentRunStatus, 'running'>;
    if (remaining.some(invocation => invocation.status === 'waiting_verification') || pending.some(action => action.status === 'awaiting_mfa')) status = 'waiting_verification';
    else if (remaining.some(invocation => invocation.status === 'waiting_confirmation') || pending.some(action => action.status === 'pending') || outcomes.some(outcome => outcome.action === 'waiting')) status = 'waiting_confirmation';
    else if (outcomes.some(item => item.action === 'reconciliation_required') || remaining.length === 0 || remaining.some(invocation => invocation.status === 'needs_reconciliation' || invocation.status === 'interrupted' || (invocation.status === 'completed' && invocation.resultJson === null)) || pending.length !== 0) status = 'interrupted';
    else if (remaining.some(invocation => invocation.status === 'failed' || invocation.status === 'cancelled')) status = 'failed';
    else status = 'completed';
    // Tool result recovery is only the first phase. Resume the same checkpoint and model input.
    if (current.checkpointJson && !status.startsWith('waiting_') &&
        !outcomes.some(item => item.action === 'reconciliation_required') &&
        !remaining.some(item => item.origin === 'pi' && item.status !== 'completed') && pending.length === 0) {
      status = await continueDurableRun(current, journal, remaining, deps);
    }
    if (current.checkpointJson && status.startsWith('waiting_')) await restoreWaitingCheckpoint(current, journal, remaining, deps);
    await journal.finish(status);
    if (status === 'interrupted' && current.checkpointJson) await parkRunRecovery(runId,
      outcomes.some(item => item.reason === 'WORKFLOW_REQUIRES_ATTENTION') ? 'WORKFLOW_REQUIRES_ATTENTION' : 'RECONCILIATION_REQUIRED');
    return { run: await getOwnedRunSummary(runId, identity), outcomes,
      message: current.checkpointJson && status === 'completed' ? 'The original model execution resumed from its saved checkpoint.'
        : remaining.length === 0 ? 'The run has no complete model checkpoint.'
        : status === 'interrupted' ? 'Some outcomes require reconciliation. No bank write was repeated.'
          : status.startsWith('waiting_') ? 'The original confirmation or verification is still required.' : 'The saved tool results were recovered.' };
  } catch (error) {
    const failure = AppError.from(error);
    const retryable = typeof failure.detail === 'object' && failure.detail !== null && (failure.detail as { retryable?: unknown }).retryable === true;
    try { await journal.finish(retryable ? 'interrupted' : 'failed', retryable ? 'MODEL_TRANSIENT' : failure.code); } catch { /* A lost lease belongs to the replacement owner. */ }
    await scheduleRunRecovery(runId, retryable ? 'MODEL_TRANSIENT' : failure.code, retryable);
    throw error;
  } finally { stopHeartbeat(); }
}

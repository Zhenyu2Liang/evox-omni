import type { AgentRun, ToolInvocation } from '@/lib/db/prisma';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { AgentRunStatus } from '@/lib/contracts/runtime';
import type { ToolName } from '@/lib/contracts/tools';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { prepareBankingCommand } from '@/lib/contracts/command';
import { prisma } from '@/lib/db/client';
import { getTask, type AgentTaskWithNodes } from '@/lib/db/repositories/task';
import {
  beginAgentRun, listRunInvocations, parkRunRecovery, restoreInvocationFromReceipt,
  synchronizeRunActionInvocations,
} from '@/lib/db/repositories/agentRun';
import { synchronizeStandaloneWorkflowRun } from '@/lib/db/repositories/workflowRun';
import { AppError } from '@/lib/errors';
import { safeParse, toJson } from '@/lib/json';
import { idempotentTransferTxId, nodeExecutionKey } from '@/lib/ledger';
import { readCommandReceipt } from '../command-execution';
import { executeGatedTool } from '../confirmation/gated-execution';
import { resumeTask } from '../task-control';
import { staleExecutionClaimBefore } from '../workflows/claims';
import { synchronizeScheduledWorkflow } from '../scheduled-dispatcher';
import { AgentRunJournal } from './journal';
import { runtimeRequestDigest } from './serialization';
import type { InvocationRecoveryOutcome } from './recovery';
import { isOpenActionStatus, OPEN_ACTION_STATUSES } from '../action-status';

export interface StandaloneWorkflowRecovery {
  message: string;
  outcomes: Array<{ invocationId: string; action: InvocationRecoveryOutcome['action']; reason?: string }>;
}

/** Standalone graphs do not have an LLM checkpoint; their complete graph is the saved input. */
async function loadSource(run: AgentRun): Promise<AgentTaskWithNodes> {
  const request = safeParse<{ kind?: string; workflowTaskId?: string; input?: string }>(run.requestJson, {});
  if (run.checkpointStage !== 'workflow_only' || request.kind !== 'workflow' || !request.workflowTaskId ||
      run.requestDigest !== `workflow:${request.workflowTaskId}`) {
    throw new AppError('CONFLICT', 'Standalone workflow source is invalid');
  }
  const task = await getTask(request.workflowTaskId);
  if (!task || task.runId !== run.id || task.parentInvocationId !== null || task.sessionId !== run.sessionId ||
      task.userId !== run.userId || task.goal !== request.input || task.nodes.length === 0) {
    throw new AppError('CONFLICT', 'Standalone workflow graph does not match its saved source');
  }
  return task;
}

function claimIsLive(task: AgentTaskWithNodes): boolean {
  return task.executionToken !== null &&
    (task.executionClaimedAt === null || task.executionClaimedAt >= staleExecutionClaimBefore());
}

/** Validate every saved predecessor before downstream decisions can consume its output. */
async function verifyGraphEvidence(run: AgentRun, task: AgentTaskWithNodes,
  invocations: ToolInvocation[]): Promise<StandaloneWorkflowRecovery['outcomes']> {
  const outcomes: StandaloneWorkflowRecovery['outcomes'] = [];
  for (const node of task.nodes) {
    if (node.kind !== 'tool' || !node.tool) continue;
    const definition = catalogEntry(node.tool);
    if (!definition) throw new AppError('CONFLICT', 'Workflow contains an unknown tool');
    const invocation = invocations.find(item => item.taskId === task.id && item.nodeId === node.nodeId);
    if (invocation && (invocation.origin !== 'workflow' || invocation.runId !== run.id ||
        invocation.toolName !== node.tool || invocation.operationKey !== nodeExecutionKey(task.id, node.nodeId))) {
      throw new AppError('CONFLICT', 'Workflow invocation identity does not match its node');
    }
    const stored = safeParse<{ ok?: boolean; data?: unknown } | null>(invocation?.resultJson, null);
    if (definition.effect !== 'write') {
      if (node.status === 'success' && (!invocation || invocation.status !== 'completed' || stored?.ok !== true ||
          runtimeRequestDigest('node_result', stored.data) !== runtimeRequestDigest('node_result', safeParse(node.output, undefined)))) {
        throw new AppError('CONFLICT', 'Saved query predecessor does not match its invocation result');
      }
      continue;
    }
    const key = nodeExecutionKey(task.id, node.nodeId);
    const receipt = await prisma.executionReceipt.findUnique({ where: { userId_key: { userId: run.userId, key } } });
    const ledger = node.tool === 'transfer_money'
      ? await prisma.transaction.findUnique({ where: { id: idempotentTransferTxId(run.userId, key) } }) : null;
    const claimsSuccess = node.status === 'success' || invocation?.status === 'completed';
    if (!claimsSuccess && !receipt && !ledger) continue;
    if (!invocation) throw new AppError('CONFLICT', 'A workflow write has no original invocation');
    const action = await prisma.pendingAction.findFirst({ where: { invocationId: invocation.id,
      sessionId: run.sessionId, userId: run.userId }, orderBy: { createdAt: 'desc' } });
    const args = safeParse<Record<string, unknown> | null>(action?.argsJson ?? invocation.argsJson, null);
    if (!args) throw new AppError('CONFLICT', 'Original workflow command arguments are missing');
    const verified = await readCommandReceipt(prepareBankingCommand(run.userId, key, node.tool as ToolName, args));
    if (!verified || verified.ok !== true || (invocation.status === 'completed' &&
        (stored?.ok !== true || runtimeRequestDigest('node_result', stored.data) !== runtimeRequestDigest('node_result', verified.data))) ||
        (node.status === 'success' && runtimeRequestDigest('node_result', safeParse(node.output, undefined)) !== runtimeRequestDigest('node_result', verified.data))) {
      throw new AppError('CONFLICT', 'Workflow predecessor has no matching committed command receipt');
    }
    if (invocation.status !== 'completed') {
      await restoreInvocationFromReceipt({ invocationId: invocation.id, userId: run.userId,
        toolName: invocation.toolName, operationKey: key, resultJson: toJson(verified) });
    }
    outcomes.push({ invocationId: invocation.id, action: invocation.status === 'completed' ? 'replayed' : 'recovered' });
  }
  return outcomes;
}

/** An independent graph can outlive conversation revisions, but never a live session owner. */
async function prepareRecoveryAdmission(run: AgentRun, task: AgentTaskWithNodes): Promise<number> {
  return prisma.$transaction(async tx => {
    const current = await tx.agentTask.findUnique({ where: { id: task.id }, include: { manualReviews: { where: { status: 'open' } } } });
    const session = await tx.agentSession.findUnique({ where: { id: run.sessionId } });
    if (!current || !session || current.runId !== run.id || current.userId !== run.userId ||
        session.userId !== run.userId || current.manualReviews.length !== 0 || !['pending', 'running'].includes(current.status)) {
      throw new AppError('CONFLICT', 'Standalone workflow requires an explicit control decision');
    }
    if (session.status !== 'active') throw new AppError('SECURITY_DENIED', 'Standalone workflow session is not active');
    if (current.executionToken !== null &&
        (current.executionClaimedAt === null || current.executionClaimedAt >= staleExecutionClaimBefore())) {
      throw new AppError('CONFLICT', 'A live workflow executor still owns the graph');
    }
    const now = new Date();
    if (session.activeRunId && session.runLeaseExpiresAt && session.runLeaseExpiresAt > now) {
      throw new AppError('CONFLICT', 'A live agent run still owns the workflow session');
    }
    const aligned = await tx.agentRun.updateMany({ where: { id: run.id, checkpointStage: 'workflow_only',
      status: { in: ['running', 'interrupted'] }, OR: [{ leaseToken: null }, { leaseExpiresAt: { lte: now } }] },
      data: { baseRevision: session.revision } });
    if (aligned.count !== 1) throw new AppError('CONFLICT', 'Standalone recovery was already claimed');
    return session.revision;
  });
}

/** Resume the same graph, keys and approval records; never regenerate a model or retry failed work. */
export async function recoverStandaloneWorkflowRun(run: AgentRun, onEvent?: (event: AgentStreamEvent) => void | Promise<void>,
  invocationId?: string): Promise<StandaloneWorkflowRecovery> {
  let task: AgentTaskWithNodes;
  try { task = await loadSource(run); }
  catch (error) {
    await parkRunRecovery(run.id, 'WORKFLOW_REQUIRES_ATTENTION');
    throw error;
  }
  let invocations = await listRunInvocations(run.id);
  if (invocationId && !invocations.some(item => item.id === invocationId)) throw new AppError('NOT_FOUND', 'Tool invocation not found');
  if (claimIsLive(task)) throw new AppError('CONFLICT', 'A live workflow executor still owns the graph');
  let outcomes: StandaloneWorkflowRecovery['outcomes'];
  try { outcomes = await verifyGraphEvidence(run, task, invocations); }
  catch (error) {
    await prisma.agentRun.updateMany({ where: { id: run.id, checkpointStage: 'workflow_only', leaseToken: null },
      data: { status: 'interrupted', recoveryErrorCode: 'RECONCILIATION_REQUIRED', errorCode: 'COMMITTED_RECEIPT_INVALID' } });
    throw error;
  }
  const manual = await prisma.manualReview.count({ where: { taskId: task.id, status: 'open' } });
  if (!['pending', 'running'].includes(task.status) || manual !== 0 || task.nodes.some(node => node.status === 'failed' || node.status === 'cancelled')) {
    await synchronizeStandaloneWorkflowRun(task.id, prisma);
    if (task.nodes.some(node => node.status === 'failed' || node.status === 'cancelled') && ['pending', 'running'].includes(task.status)) {
      await parkRunRecovery(run.id, 'WORKFLOW_REQUIRES_ATTENTION');
    }
    return { outcomes, message: task.status === 'success' ? 'The complete original workflow outcome was verified.'
      : 'The saved workflow remains at its original human or terminal control decision.' };
  }
  let revision: number;
  try { revision = await prepareRecoveryAdmission(run, task); }
  catch (error) {
    if (error instanceof AppError && error.code === 'SECURITY_DENIED') await parkRunRecovery(run.id, 'WORKFLOW_REQUIRES_ATTENTION');
    throw error;
  }
  const admitted = await beginAgentRun({ sessionId: run.sessionId, userId: run.userId,
    existingRunId: run.id, recover: true, requestDigest: run.requestDigest, requestJson: run.requestJson, expectedRevision: revision });
  if (!admitted.lease) throw new AppError('CONFLICT', 'Standalone recovery was already claimed');
  const journal = new AgentRunJournal(admitted.lease);
  const stopHeartbeat = journal.startHeartbeat();
  try {
    await synchronizeRunActionInvocations(run.id, run.sessionId, run.userId);
    const plan = await resumeTask(task.sessionId, task.id, { runTool: (toolName, args, context) => executeGatedTool({
      ...context, sessionId: task.sessionId, userId: task.userId, toolName: toolName as ToolName, args,
      userRequest: task.goal, runtimeFence: client => journal.assertLeaseOwned(client),
    }) });
    await synchronizeScheduledWorkflow(plan.id);
    const event = { type: 'plan_update' as const, plan };
    await journal.recordPresentationEvent(event);
    await onEvent?.(event);
    invocations = await listRunInvocations(run.id);
    outcomes = await verifyGraphEvidence(run, await loadSource(run), invocations);
    const pending = await prisma.pendingAction.findMany({ where: { taskId: task.id, sessionId: run.sessionId,
      userId: run.userId, status: { in: [...OPEN_ACTION_STATUSES, 'confirmed', 'needs_reconciliation', 'locked'] } }, select: { status: true } });
    // The same shared vocabulary as the Pi path: only an OPEN action is still a decision. A `locked` (or otherwise
    // closed) row is settled, so the graph stops for reconciliation instead of re-presenting an approval.
    const openActions = pending.filter(action => isOpenActionStatus(action.status));
    const closedActions = pending.filter(action => !isOpenActionStatus(action.status));
    const status: Exclude<AgentRunStatus, 'running'> = closedActions.length !== 0 ? 'interrupted'
      : plan.status === 'success' && pending.length === 0 ? 'completed'
        : openActions.some(action => action.status === 'awaiting_mfa') || plan.results.some(node => node.status === 'waiting_verification') ? 'waiting_verification'
          : openActions.some(action => action.status === 'pending') || plan.status === 'waiting_confirmation' ? 'waiting_confirmation'
            : plan.status === 'failed' || plan.status === 'cancelled' ? 'failed' : 'interrupted';
    await journal.finish(status, status === 'failed' ? 'WORKFLOW_FAILED' : undefined);
    if (status === 'interrupted') await parkRunRecovery(run.id, 'WORKFLOW_REQUIRES_ATTENTION');
    // A closed action is never reported back as an outstanding authorization request.
    if (status.startsWith('waiting_')) for (const item of invocations.filter(item => item.status.startsWith('waiting_'))) {
      outcomes.push({ invocationId: item.id, action: 'waiting', reason: 'AUTHORIZATION_REQUIRED' });
    }
    return { outcomes, message: status === 'completed' ? 'The original workflow resumed from its saved graph.'
      : status.startsWith('waiting_') ? 'The original human approval is still required.' : 'The workflow requires an explicit control or reconciliation decision.' };
  } catch (error) {
    try { await journal.finish('interrupted', 'WORKFLOW_REQUIRES_ATTENTION'); } catch { /* A replacement owner may have won the lease. */ }
    await parkRunRecovery(run.id, 'WORKFLOW_REQUIRES_ATTENTION');
    throw error;
  } finally { stopHeartbeat(); }
}

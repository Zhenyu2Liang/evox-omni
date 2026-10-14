import { randomUUID } from 'node:crypto';
import type { AgentRun, AgentRunEvent, ToolInvocation, ModelRequest, Prisma } from '@/lib/db/prisma';
import { prisma, type DbClient } from '../client';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import type { AgentRunLease, AgentRunStatus, RuntimeEventChannel, ToolInvocationStatus, ToolReplayPolicy } from '@/lib/contracts/runtime';
import { WORKFLOW_EXECUTION_LEASE_MS } from '@/lib/contracts/runtime';

const DEFAULT_LEASE_MS = 120_000;

export interface BeginAgentRunInput {
  sessionId: string;
  userId: string;
  requestId?: string;
  requestDigest: string;
  requestJson: string;
  now?: Date;
  leaseMs?: number;
  /** Explicit owner-requested recovery; ordinary duplicate failed requests remain settled. */
  recover?: boolean;
  /** Persisted run identity used by explicit recovery, independently of a transport request ID. */
  existingRunId?: string;
  expectedRevision?: number;
  checkpointJson?: string;
}

export interface BegunAgentRun {
  run: AgentRun;
  reused: boolean;
  lease?: AgentRunLease;
}

/** Admit input and acquire the session execution lease in one database transaction. */
export async function beginAgentRun(input: BeginAgentRunInput): Promise<BegunAgentRun> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  return prisma.$transaction(async tx => {
    const session = await tx.agentSession.findUnique({ where: { id: input.sessionId } });
    if (!session || session.userId !== input.userId) throw new AppError('NOT_FOUND', 'Session not found');
    if (session.status !== 'active') throw new AppError('SECURITY_DENIED', 'Session is not active');
    if (input.expectedRevision !== undefined && session.revision !== input.expectedRevision) throw new AppError('CONFLICT', 'The conversation changed before execution admission');
    const existing = input.existingRunId
      ? await tx.agentRun.findUnique({ where: { id: input.existingRunId } })
      : input.requestId === undefined ? null : await tx.agentRun.findUnique({ where: { sessionId_requestId: { sessionId: input.sessionId, requestId: input.requestId } } });
    if (input.existingRunId && (!input.recover || !existing || existing.sessionId !== input.sessionId || existing.userId !== input.userId)) throw new AppError('SECURITY_DENIED', 'Run recovery identity is not valid');
    if (existing && existing.requestDigest !== input.requestDigest) throw new AppError('CONFLICT', 'Request identity was reused with different input');
    if (input.recover && existing && existing.baseRevision !== session.revision) throw new AppError('CONFLICT', 'A newer conversation revision prevents continuation');
    if (input.recover && existing && existing.recoveryAttempts >= existing.maxRecoveryAttempts) throw new AppError('CONFLICT', 'Run recovery attempts are exhausted');
    if (existing && existing.status !== 'running' && existing.status !== 'interrupted' && !(input.recover && existing.status === 'failed')) return { run: existing, reused: true };
    if (session.activeRunId && session.runLeaseExpiresAt && session.runLeaseExpiresAt > now) {
      if (existing?.id === session.activeRunId) return { run: existing, reused: true };
      throw new AppError('CONFLICT', 'Another agent run owns this session');
    }
    if (session.activeRunId && session.activeRunId !== existing?.id) {
      await tx.agentRun.updateMany({ where: { id: session.activeRunId, status: 'running' }, data: { status: 'interrupted', leaseToken: null, leaseExpiresAt: null } });
      await markInterruptedInvocations(session.activeRunId, tx);
    }
    const token = randomUUID();
    const expiresAt = new Date(now.getTime() + leaseMs);
    const run = existing
      ? await tx.agentRun.update({ where: { id: existing.id }, data: { status: 'running', leaseToken: token, leaseExpiresAt: expiresAt, finishedAt: null, errorCode: null, ...(input.recover ? { recoveryAttempts: { increment: 1 }, nextRecoveryAt: null } : {}) } })
      : await tx.agentRun.create({ data: { sessionId: input.sessionId, userId: input.userId, requestId: input.requestId, requestDigest: input.requestDigest, requestJson: input.requestJson, leaseToken: token, leaseExpiresAt: expiresAt, startedAt: now, baseRevision: session.revision,
        checkpointJson: input.checkpointJson, checkpointStage: input.checkpointJson ? 'input' : null } });
    const claimed = await tx.agentSession.updateMany({
      where: { id: input.sessionId, userId: input.userId, activeRunId: session.activeRunId, runLeaseToken: session.runLeaseToken, runLeaseExpiresAt: session.runLeaseExpiresAt },
      data: { activeRunId: run.id, runLeaseToken: token, runLeaseExpiresAt: expiresAt },
    });
    if (claimed.count !== 1) throw new AppError('CONFLICT', 'Session execution lease changed');
    if (existing) await markInterruptedInvocations(existing.id, tx);
    await appendInTransaction(run.id, { channel: 'internal', eventType: existing ? 'run_reclaimed' : 'run_admitted', payloadJson: JSON.stringify({ runId: run.id, requestId: input.requestId ?? null }) }, tx);
    return { run, reused: Boolean(existing), lease: { runId: run.id, sessionId: run.sessionId, userId: run.userId, token } };
  });
}

async function markInterruptedInvocations(runId: string, tx: Prisma.TransactionClient): Promise<void> {
  await tx.toolInvocation.updateMany({ where: { runId, status: 'started', replaySafety: 'reconcile_only' }, data: { status: 'needs_reconciliation', errorCode: 'COMMIT_STATE_UNKNOWN' } });
  await tx.toolInvocation.updateMany({ where: { runId, status: 'started', replaySafety: { in: ['read_only', 'idempotent'] } }, data: { status: 'interrupted', errorCode: 'PROCESS_INTERRUPTED' } });
}

export async function assertAgentRunLease(lease: AgentRunLease, client: DbClient, now = new Date(), allowExpired = false): Promise<AgentRun> {
  const run = await client.agentRun.findUnique({ where: { id: lease.runId } });
  const session = await client.agentSession.findUnique({ where: { id: lease.sessionId } });
  if (!run || run.sessionId !== lease.sessionId || run.userId !== lease.userId || run.leaseToken !== lease.token || run.status !== 'running' || !run.leaseExpiresAt || (!allowExpired && run.leaseExpiresAt <= now) ||
      !session || session.userId !== lease.userId || session.revision !== run.baseRevision || session.activeRunId !== lease.runId || session.runLeaseToken !== lease.token || !session.runLeaseExpiresAt || (!allowExpired && session.runLeaseExpiresAt <= now)) {
    throw new AppError('CONFLICT', 'Agent run execution lease is no longer valid');
  }
  return run;
}

export async function renewAgentRunLease(lease: AgentRunLease, leaseMs = DEFAULT_LEASE_MS): Promise<void> {
  await prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const expiresAt = new Date(Date.now() + leaseMs);
    await tx.agentRun.update({ where: { id: lease.runId }, data: { leaseExpiresAt: expiresAt } });
    await tx.agentSession.update({ where: { id: lease.sessionId }, data: { runLeaseExpiresAt: expiresAt } });
  });
}

export async function verifyAgentRunLease(lease: AgentRunLease): Promise<void> {
  await assertAgentRunLease(lease, prisma);
}

export interface AppendRuntimeEventInput {
  channel: RuntimeEventChannel;
  eventType: string;
  payloadJson: string;
}

async function appendInTransaction(runId: string, input: AppendRuntimeEventInput, tx: Prisma.TransactionClient): Promise<AgentRunEvent> {
  const run = await tx.agentRun.update({ where: { id: runId }, data: { nextSequence: { increment: 1 } }, select: { nextSequence: true } });
  return tx.agentRunEvent.create({ data: { runId, sequence: run.nextSequence, ...input } });
}

/** Persist a raw or presentation event; callers must await this before publishing it. */
export async function appendRuntimeEvent(lease: AgentRunLease, input: AppendRuntimeEventInput): Promise<AgentRunEvent> {
  return prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    return appendInTransaction(lease.runId, input, tx);
  });
}

export interface StartInvocationInput {
  id: string;
  callId: string;
  toolName: string;
  argsJson: string;
  requestDigest: string;
  policy: ToolReplayPolicy;
  modelRequestId?: string;
  origin?: string;
  parentInvocationId?: string;
  taskId?: string;
  nodeId?: string;
}

/** A started event and the stable tool identity become durable together before tool preflight. */
export async function startInvocationWithEvent(lease: AgentRunLease, input: StartInvocationInput, event: AppendRuntimeEventInput): Promise<{ invocation: ToolInvocation; event: AgentRunEvent }> {
  return prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const allocated = await tx.agentRun.update({ where: { id: lease.runId }, data: { nextOrdinal: { increment: 1 } }, select: { nextOrdinal: true } });
    const invocation = await tx.toolInvocation.create({ data: {
      id: input.id, runId: lease.runId, ordinal: allocated.nextOrdinal,
      callId: input.callId, toolName: input.toolName, argsJson: input.argsJson, requestDigest: input.requestDigest,
      operationKey: `inv:${input.id}`, replaySafety: input.policy.safety, maxAttempts: input.policy.maxAttempts,
      modelRequestId: input.modelRequestId, origin: input.origin ?? 'pi', parentInvocationId: input.parentInvocationId,
      taskId: input.taskId, nodeId: input.nodeId,
    } });
    return { invocation, event: await appendInTransaction(lease.runId, event, tx) };
  });
}

export interface FinishInvocationInput {
  invocationId: string;
  status: ToolInvocationStatus;
  resultJson?: string;
  errorCode?: string;
}

export async function finishInvocationWithEvent(lease: AgentRunLease, input: FinishInvocationInput, event: AppendRuntimeEventInput): Promise<AgentRunEvent> {
  return prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const invocation = await tx.toolInvocation.findUnique({ where: { id: input.invocationId } });
    if (!invocation || invocation.runId !== lease.runId) throw new AppError('NOT_FOUND', 'Tool invocation not found');
    // Persisted receipt or action decisions cannot be rewritten by a late provider event.
    if ((invocation.status === 'completed' && invocation.resultJson !== null) || invocation.status === 'cancelled' || invocation.status === 'failed' || invocation.status === 'needs_reconciliation') return appendInTransaction(lease.runId, event, tx);
    const waiting = invocation.status === 'waiting_confirmation' || invocation.status === 'waiting_verification';
    await tx.toolInvocation.update({ where: { id: invocation.id }, data: {
      status: waiting ? invocation.status : input.status,
      resultJson: input.resultJson,
      errorCode: input.errorCode,
      finishedAt: waiting ? null : new Date(),
    } });
    return appendInTransaction(lease.runId, event, tx);
  });
}

/** Bind a pending bank command while the active run still owns its invocation. */
export async function updateInvocationAuthorization(lease: AgentRunLease, invocationId: string, status: 'waiting_confirmation' | 'waiting_verification', operationKey?: string): Promise<ToolInvocation> {
  return prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const invocation = await tx.toolInvocation.findUnique({ where: { id: invocationId } });
    if (!invocation || invocation.runId !== lease.runId || invocation.status !== 'started') throw new AppError('CONFLICT', 'Tool invocation cannot be parked');
    return tx.toolInvocation.update({ where: { id: invocationId }, data: { status, ...(operationKey ? { operationKey } : {}) } });
  });
}

/** Finalize the run and release only its own lease, including failure paths. */
export async function finishAgentRun(lease: AgentRunLease, status: Exclude<AgentRunStatus, 'running'>, errorCode?: string): Promise<AgentRun> {
  return prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx, new Date(), true);
    const model = await tx.modelRequest.findFirst({ where: { runId: lease.runId }, orderBy: { ordinal: 'desc' } });
    if (status === 'failed' && model?.status === 'failed' && model.errorCode === 'MODEL_TRANSIENT' && model.attempt < model.maxAttempts) {
      status = 'interrupted';
      errorCode = 'MODEL_TRANSIENT';
    }
    if (status === 'interrupted' || status === 'failed') await markInterruptedInvocations(lease.runId, tx);
    const run = await tx.agentRun.update({ where: { id: lease.runId }, data: { status, errorCode: errorCode ?? null, finishedAt: new Date(), leaseToken: null, leaseExpiresAt: null,
      ...(errorCode === 'MODEL_TRANSIENT' && status === 'interrupted' ? { nextRecoveryAt: new Date(Date.now() + 2000) } : {}) } });
    await appendInTransaction(lease.runId, { channel: 'internal', eventType: 'run_finished', payloadJson: JSON.stringify({ status, errorCode: errorCode ?? null }) }, tx);
    await tx.agentSession.updateMany({ where: { id: lease.sessionId, activeRunId: lease.runId, runLeaseToken: lease.token }, data: { activeRunId: null, runLeaseToken: null, runLeaseExpiresAt: null } });
    return run;
  });
}

export function getAgentRunForUser(runId: string, userId: string): Promise<AgentRun | null> {
  return prisma.agentRun.findFirst({ where: { id: runId, userId } });
}

export function getAgentRun(runId: string): Promise<AgentRun | null> {
  return prisma.agentRun.findUnique({ where: { id: runId } });
}

/** Only actions linked to this run may determine its recovery state. */
export function runPendingActionWhere(sessionId: string, userId: string, invocations: readonly ToolInvocation[]): Prisma.PendingActionWhereInput {
  const taskIds = new Set<string>();
  for (const invocation of invocations) {
    if (invocation.operationKey.startsWith('nxe:')) {
      const taskId = invocation.operationKey.split(':')[1];
      if (taskId) taskIds.add(taskId);
    }
    if (invocation.toolName === 'submit_plan') {
      const result = safeParse<{ data?: { id?: unknown } } | null>(invocation.resultJson, null);
      if (typeof result?.data?.id === 'string') taskIds.add(result.data.id);
    }
  }
  return { sessionId, userId, OR: [
    { invocationId: { in: invocations.map(invocation => invocation.id) } },
    { id: { in: invocations.map(invocation => invocation.operationKey) } },
    { taskId: { in: [...taskIds] } },
  ] };
}

/** Synchronize persisted action decisions without authorizing or executing another operation. */
export async function synchronizeRunActionInvocations(runId: string, sessionId: string, userId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.sessionId !== sessionId || run.userId !== userId) throw new AppError('SECURITY_DENIED', 'Run recovery identity is not valid');
    const invocations = await tx.toolInvocation.findMany({ where: { runId }, select: { id: true } });
    const actions = await tx.pendingAction.findMany({ where: {
      sessionId, userId, invocationId: { in: invocations.map(invocation => invocation.id) },
      status: { in: ['executed', 'cancelled', 'failed', 'needs_reconciliation'] },
    }, select: { id: true } });
    for (const action of actions) await settleInvocationFromAction(action.id, tx);
  });
}

/** A paused run can settle from stored terminal facts without disturbing a newer session run. */
export async function finalizeReceiptedAgentRun(runId: string, sessionId: string, userId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.sessionId !== sessionId || run.userId !== userId) throw new AppError('SECURITY_DENIED', 'Run recovery identity is not valid');
    if (run.status === 'running' || run.status === 'completed' || run.checkpointStage === 'workflow_only') return;
    if (run.checkpointJson && run.checkpointStage !== 'session_committed') return;
    const invocations = await tx.toolInvocation.findMany({ where: { runId } });
    if (invocations.length === 0 || invocations.some(invocation => !['completed', 'cancelled', 'failed'].includes(invocation.status))) return;
    if (invocations.some(invocation => invocation.status === 'completed' && invocation.resultJson === null)) return;
    const outstanding = await tx.pendingAction.count({ where: { ...runPendingActionWhere(sessionId, userId, invocations), status: { in: ['pending', 'awaiting_mfa', 'confirmed', 'needs_reconciliation'] } } });
    if (outstanding !== 0) return;
    const failed = invocations.find(invocation => invocation.status === 'failed');
    const cancelled = invocations.some(invocation => invocation.status === 'cancelled');
    const status = failed || cancelled ? 'failed' : 'completed';
    const errorCode = failed ? failed.errorCode ?? 'TOOL_FAILED' : cancelled ? 'CANCELLED' : null;
    if (run.status === status && run.errorCode === errorCode) return;
    await tx.agentRun.update({ where: { id: runId }, data: { status, finishedAt: new Date(), errorCode } });
    await appendInTransaction(runId, { channel: 'internal', eventType: 'run_reconciled', payloadJson: JSON.stringify({ runId, status, errorCode }) }, tx);
  });
}

/** This read deliberately exposes only the server-grounded presentation channel. */
export async function listPresentationEvents(runId: string, userId: string, afterSequence = 0, limit = 100): Promise<AgentRunEvent[]> {
  if (!(await getAgentRunForUser(runId, userId))) throw new AppError('NOT_FOUND', 'Agent run not found');
  return prisma.agentRunEvent.findMany({ where: { runId, channel: 'ui', sequence: { gt: afterSequence } }, orderBy: { sequence: 'asc' }, take: Math.min(Math.max(limit, 1), 501) });
}

export function listRunInvocations(runId: string, client: DbClient = prisma): Promise<ToolInvocation[]> {
  return client.toolInvocation.findMany({ where: { runId }, orderBy: { ordinal: 'asc' } });
}

/** Internal worker discovery; all subsequent mutations still require a freshly acquired lease. */
export async function listRecoverableAgentRuns(now = new Date(), limit = 100): Promise<AgentRun[]> {
  const workflows = await prisma.agentTask.findMany({ where: {
    runId: { not: null }, parentInvocationId: null, status: { in: ['pending', 'running'] },
    manualReviews: { none: { status: 'open' } },
    OR: [{ executionToken: null }, { executionClaimedAt: { lt: new Date(now.getTime() - WORKFLOW_EXECUTION_LEASE_MS) } }],
  }, select: { runId: true } });
  return prisma.agentRun.findMany({ where: { AND: [
    { OR: [{ checkpointStage: null }, { checkpointStage: { not: 'workflow_only' } },
      { checkpointStage: 'workflow_only', id: { in: workflows.flatMap(task => task.runId ? [task.runId] : []) } }] },
    { OR: [{ nextRecoveryAt: null }, { nextRecoveryAt: { lte: now } }] },
    { recoveryAttempts: { lt: prisma.agentRun.fields.maxRecoveryAttempts } },
    { OR: [{ recoveryErrorCode: null }, { recoveryErrorCode: { notIn: ['RECONCILIATION_REQUIRED', 'WORKFLOW_REQUIRES_ATTENTION', 'CHECKPOINT_MISSING'] } }] },
    { OR: [{ status: 'interrupted' }, { status: 'running', OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }] },
  ] }, orderBy: { startedAt: 'asc' }, take: limit });
}

/** Store only complete execution boundaries; partial provider output remains event evidence. */
export async function saveRunCheckpoint(lease: AgentRunLease, stage: string, checkpointJson: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    await tx.agentRun.update({ where: { id: lease.runId }, data: { checkpointJson, checkpointStage: stage } });
    await appendInTransaction(lease.runId, { channel: 'internal', eventType: 'checkpoint', payloadJson: JSON.stringify({ stage }) }, tx);
  });
}

/** The provider is called only after its input and bounded retry identity have committed. */
export async function startModelRequest(lease: AgentRunLease, requestDigest: string, inputJson: string, checkpointJson: string): Promise<ModelRequest> {
  return prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const previous = await tx.modelRequest.findFirst({ where: { runId: lease.runId }, orderBy: { ordinal: 'desc' } });
    let request: ModelRequest;
    if (previous && previous.status !== 'completed') {
      if (previous.requestDigest !== requestDigest && previous.status !== 'failed') throw new AppError('CONFLICT', 'An unfinished model request cannot be replaced');
      if (previous.status === 'failed' && previous.errorCode !== 'MODEL_TRANSIENT') throw new AppError('CONFLICT', 'The model request failure is permanent');
      if (previous.attempt >= previous.maxAttempts) throw new AppError('CONFLICT', 'Model request retry limit reached');
      request = await tx.modelRequest.update({ where: { id: previous.id }, data: { attempt: { increment: 1 }, status: 'started', errorCode: null, finishedAt: null, requestDigest, inputJson } });
    } else {
      request = await tx.modelRequest.create({ data: { runId: lease.runId, ordinal: (previous?.ordinal ?? 0) + 1, requestDigest, inputJson } });
    }
    await tx.agentRun.update({ where: { id: lease.runId }, data: { checkpointJson, checkpointStage: 'model_intent' } });
    await appendInTransaction(lease.runId, { channel: 'internal', eventType: 'model_request_started', payloadJson: JSON.stringify({ modelRequestId: request.id, ordinal: request.ordinal, attempt: request.attempt }) }, tx);
    return request;
  });
}

export async function completeModelRequest(lease: AgentRunLease, requestId: string, resultJson: string, checkpointJson: string, errorCode?: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const updated = await tx.modelRequest.updateMany({ where: { id: requestId, runId: lease.runId, status: 'started' }, data: {
      status: errorCode ? 'failed' : 'completed', resultJson: errorCode ? null : resultJson, errorCode: errorCode ?? null, finishedAt: new Date(),
    } });
    if (updated.count !== 1) throw new AppError('CONFLICT', 'Model request completion is no longer owned');
    // Error and aborted messages are not complete model results and cannot authorize tool calls.
    if (!errorCode) await tx.agentRun.update({ where: { id: lease.runId }, data: { checkpointJson, checkpointStage: 'model_result' } });
    await appendInTransaction(lease.runId, { channel: 'internal', eventType: errorCode ? 'model_request_failed' : 'model_request_completed', payloadJson: JSON.stringify({ modelRequestId: requestId, errorCode: errorCode ?? null }) }, tx);
  });
}

/** Session writes check both revision and execution ownership in the same SQLite transaction. */
export async function commitRunSession(lease: AgentRunLease, expectedRevision: number, stateJson: string, intentJson: string | null, checkpointJson: string): Promise<number> {
  return prisma.$transaction(async tx => {
    const run = await assertAgentRunLease(lease, tx);
    const updated = await tx.agentSession.updateMany({ where: { id: lease.sessionId, userId: lease.userId, revision: expectedRevision, activeRunId: lease.runId, runLeaseToken: lease.token }, data: { stateJson, intentJson, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new AppError('CONFLICT', 'The conversation changed during this execution');
    const latest = await tx.modelRequest.findFirst({ where: { runId: lease.runId }, orderBy: { ordinal: 'desc' } });
    let savedCheckpoint = checkpointJson;
    let checkpointStage = 'session_committed';
    if (latest?.status === 'failed' && run.checkpointJson) {
      const retained = JSON.parse(run.checkpointJson) as { snapshot: { revision: number; transcript: unknown[] }; inputMessagePersisted?: boolean };
      retained.snapshot.revision = expectedRevision + 1;
      retained.snapshot.transcript = (JSON.parse(stateJson) as { transcript: unknown[] }).transcript;
      retained.inputMessagePersisted = true;
      savedCheckpoint = JSON.stringify(retained);
      checkpointStage = 'model_intent';
    } else {
      const saved = JSON.parse(checkpointJson) as { snapshot: { revision: number } };
      saved.snapshot.revision = expectedRevision + 1;
      savedCheckpoint = JSON.stringify(saved);
    }
    await tx.agentRun.update({ where: { id: lease.runId }, data: { baseRevision: expectedRevision + 1, checkpointJson: savedCheckpoint, checkpointStage } });
    return expectedRevision + 1;
  });
}

/** Only a resumed, owner-checked graph may settle its original outer Pi invocation. */
export async function settlePlanInvocation(lease: AgentRunLease, invocationId: string, resultJson: string, waiting?: 'waiting_confirmation' | 'waiting_verification'): Promise<void> {
  await prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const item = await tx.toolInvocation.findUnique({ where: { id: invocationId } });
    if (!item || item.runId !== lease.runId || item.toolName !== 'submit_plan' || item.origin !== 'pi') throw new AppError('CONFLICT', 'Workflow continuation does not match its outer invocation');
    await tx.toolInvocation.update({ where: { id: item.id }, data: { status: waiting ?? 'completed', resultJson, errorCode: null, finishedAt: waiting ? null : new Date() } });
    await appendInTransaction(lease.runId, { channel: 'internal', eventType: 'workflow_result_recovered', payloadJson: JSON.stringify({ invocationId, status: waiting ?? 'completed' }) }, tx);
  });
}

/** Recovery backoff is persisted so each worker process observes the same retry schedule. */
export async function scheduleRunRecovery(runId: string, errorCode: string, transient: boolean): Promise<void> {
  await prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status === 'running' || run.status === 'completed' || run.status.startsWith('waiting_')) return;
    const retryable = transient && run.recoveryAttempts < run.maxRecoveryAttempts;
    await tx.agentRun.update({ where: { id: runId }, data: { status: retryable ? 'interrupted' : 'failed', recoveryErrorCode: errorCode, errorCode,
      nextRecoveryAt: retryable ? new Date(Date.now() + 1000 * 2 ** run.recoveryAttempts) : null } });
  });
}

export async function parkRunRecovery(runId: string, reason: string): Promise<void> {
  await prisma.agentRun.updateMany({ where: { id: runId, status: 'interrupted', leaseToken: null }, data: { recoveryErrorCode: reason, nextRecoveryAt: null } });
}

/** An obsolete checkpoint is terminal; workers must not repeatedly attempt an unsafe resume. */
export async function stopObsoleteRun(runId: string): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    const session = await tx.agentSession.findUnique({ where: { id: run.sessionId } });
    if (session?.revision === run.baseRevision || run.status === 'completed') return false;
    await tx.agentRun.update({ where: { id: runId }, data: { status: 'failed', errorCode: 'CONVERSATION_CHANGED', recoveryErrorCode: 'CONVERSATION_CHANGED', leaseToken: null, leaseExpiresAt: null, finishedAt: new Date() } });
    await tx.agentSession.updateMany({ where: { id: run.sessionId, activeRunId: run.id, runLeaseToken: run.leaseToken }, data: { activeRunId: null, runLeaseToken: null, runLeaseExpiresAt: null } });
    await appendInTransaction(runId, { channel: 'internal', eventType: 'continuation_stopped', payloadJson: JSON.stringify({ reason: 'CONVERSATION_CHANGED' }) }, tx);
    return true;
  });
}

export interface RestoreReceiptInput {
  invocationId: string;
  userId: string;
  toolName: string;
  operationKey: string;
  /** A domain-validated original receipt, never a model or user-provided result. */
  resultJson: string;
}

/** Recover a committed bank result without executing the operation again. */
export async function restoreInvocationFromReceipt(input: RestoreReceiptInput, client?: Prisma.TransactionClient): Promise<ToolInvocation> {
  if (!client) return prisma.$transaction(tx => restoreInvocationFromReceipt(input, tx));
  const invocation = await client.toolInvocation.findUnique({ where: { id: input.invocationId }, include: { run: true } });
  if (!invocation || invocation.run.userId !== input.userId || invocation.toolName !== input.toolName || invocation.operationKey !== input.operationKey) throw new AppError('CONFLICT', 'Execution receipt does not match the tool invocation');
  const receipt = await client.executionReceipt.findUnique({ where: { userId_key: { userId: input.userId, key: input.operationKey } } });
  if (!receipt || receipt.toolName !== input.toolName || receipt.responseJson !== input.resultJson) throw new AppError('CONFLICT', 'Committed execution receipt is missing or different');
  if (invocation.status === 'completed') {
    if (invocation.resultJson !== input.resultJson) throw new AppError('CONFLICT', 'Committed tool result cannot be replaced');
    return invocation;
  }
  const restored = await client.toolInvocation.update({ where: { id: invocation.id }, data: { status: 'completed', resultJson: input.resultJson, errorCode: null, finishedAt: new Date() } });
  await appendInTransaction(invocation.runId, { channel: 'internal', eventType: 'invocation_recovered', payloadJson: JSON.stringify({ invocationId: invocation.id, operationKey: invocation.operationKey, receiptId: receipt.id }) }, client);
  return restored;
}

/** Claim the next attempt under the stored policy; callers supply a previously checked decision. */
export async function claimInvocationRetry(lease: AgentRunLease, invocationId: string, expectedAttempt: number, event?: AppendRuntimeEventInput): Promise<ToolInvocation> {
  return prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const claimed = await tx.toolInvocation.updateMany({ where: { id: invocationId, runId: lease.runId, attempt: expectedAttempt, status: { in: ['interrupted', 'failed'] }, replaySafety: { in: ['read_only', 'idempotent'] }, maxAttempts: { gt: expectedAttempt } }, data: { attempt: { increment: 1 }, status: 'started', errorCode: null, finishedAt: null } });
    if (claimed.count !== 1) throw new AppError('CONFLICT', 'Tool retry is no longer eligible');
    if (event) await appendInTransaction(lease.runId, event, tx);
    return tx.toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });
  });
}

/** Save a recovery result and its event with the attempt compare-and-set in one transaction. */
export async function settleRecoveredInvocation(lease: AgentRunLease, invocationId: string, attempt: number, status: 'completed' | 'failed' | 'needs_reconciliation', resultJson: string | undefined, errorCode: string | undefined): Promise<ToolInvocation> {
  return prisma.$transaction(async tx => {
    await assertAgentRunLease(lease, tx);
    const updated = await tx.toolInvocation.updateMany({ where: { id: invocationId, runId: lease.runId, attempt, status: 'started' }, data: { status, resultJson: resultJson ?? null, errorCode: errorCode ?? null, finishedAt: status === 'needs_reconciliation' ? null : new Date() } });
    if (updated.count !== 1) throw new AppError('CONFLICT', 'Recovery attempt no longer owns the invocation');
    await appendInTransaction(lease.runId, { channel: 'internal', eventType: 'invocation_retry_finished', payloadJson: JSON.stringify({ invocationId, attempt, status, errorCode: errorCode ?? null }) }, tx);
    return tx.toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });
  });
}

/** Settle approved read results or terminal decisions in the action's existing transaction. */
export async function settleInvocationFromAction(actionId: string, client: Prisma.TransactionClient): Promise<void> {
  const action = await client.pendingAction.findUnique({ where: { id: actionId } });
  if (!action?.invocationId) return;
  const invocation = await client.toolInvocation.findUnique({ where: { id: action.invocationId }, include: { run: true } });
  if (!invocation || invocation.status === 'completed') return;
  if (invocation.run.sessionId !== action.sessionId || invocation.run.userId !== action.userId || invocation.toolName !== action.toolName) throw new AppError('CONFLICT', 'Action and invocation identities do not match');
  let status: ToolInvocationStatus | undefined;
  let resultJson: string | undefined;
  if (action.status === 'executed' && catalogEntry(action.toolName)?.effect === 'read') {
    const result = safeParse<{ ok?: boolean } | null>(action.resultJson, null);
    if (result?.ok !== true || action.resultJson === null) throw new AppError('CONFLICT', 'An executed read action requires its original successful result');
    status = 'completed';
    resultJson = action.resultJson;
  } else if (action.status === 'cancelled') status = 'cancelled';
  else if (action.status === 'failed') status = 'failed';
  else if (action.status === 'needs_reconciliation') status = 'needs_reconciliation';
  if (!status) return;
  if (invocation.status === status && (resultJson === undefined || invocation.resultJson === resultJson)) return;
  const updated = await client.toolInvocation.updateMany({ where: { id: invocation.id, status: { not: 'completed' } }, data: {
    status, ...(resultJson ? { resultJson } : {}), finishedAt: status === 'needs_reconciliation' ? null : new Date(),
    errorCode: status === 'failed' ? 'TOOL_FAILED' : status === 'needs_reconciliation' ? 'COMMIT_STATE_UNKNOWN' : null,
  } });
  if (updated.count === 1) await appendInTransaction(invocation.runId, { channel: 'internal', eventType: 'invocation_settled_from_action', payloadJson: JSON.stringify({ invocationId: invocation.id, actionId, status }) }, client);
}

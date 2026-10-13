import { randomUUID } from 'node:crypto';
import type { AgentRun, AgentRunEvent, ToolInvocation, Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../client';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import type { AgentRunLease, AgentRunStatus, RuntimeEventChannel, ToolInvocationStatus, ToolReplayPolicy } from '@/lib/contracts/runtime';

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
    const existing = input.existingRunId
      ? await tx.agentRun.findUnique({ where: { id: input.existingRunId } })
      : input.requestId === undefined ? null : await tx.agentRun.findUnique({ where: { sessionId_requestId: { sessionId: input.sessionId, requestId: input.requestId } } });
    if (input.existingRunId && (!input.recover || !existing || existing.sessionId !== input.sessionId || existing.userId !== input.userId)) throw new AppError('SECURITY_DENIED', 'Run recovery identity is not valid');
    if (existing && existing.requestDigest !== input.requestDigest) throw new AppError('CONFLICT', 'Request identity was reused with different input');
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
      ? await tx.agentRun.update({ where: { id: existing.id }, data: { status: 'running', leaseToken: token, leaseExpiresAt: expiresAt, finishedAt: null, errorCode: null } })
      : await tx.agentRun.create({ data: { sessionId: input.sessionId, userId: input.userId, requestId: input.requestId, requestDigest: input.requestDigest, requestJson: input.requestJson, leaseToken: token, leaseExpiresAt: expiresAt, startedAt: now } });
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
      !session || session.userId !== lease.userId || session.activeRunId !== lease.runId || session.runLeaseToken !== lease.token || !session.runLeaseExpiresAt || (!allowExpired && session.runLeaseExpiresAt <= now)) {
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
    // A bank receipt may already have recovered the result; raw end events cannot rewrite that fact.
    if (invocation.status === 'completed' && invocation.resultJson !== null) return appendInTransaction(lease.runId, event, tx);
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
    if (status === 'interrupted' || status === 'failed') await markInterruptedInvocations(lease.runId, tx);
    const run = await tx.agentRun.update({ where: { id: lease.runId }, data: { status, errorCode: errorCode ?? null, finishedAt: new Date(), leaseToken: null, leaseExpiresAt: null } });
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

/** A paused run can settle from receipts without owning or disturbing a newer session run. */
export async function finalizeReceiptedAgentRun(runId: string, sessionId: string, userId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.sessionId !== sessionId || run.userId !== userId) throw new AppError('SECURITY_DENIED', 'Run recovery identity is not valid');
    if (run.status === 'running' || run.status === 'completed') return;
    const invocations = await tx.toolInvocation.findMany({ where: { runId } });
    if (invocations.length === 0 || invocations.some(invocation => invocation.status !== 'completed')) return;
    const outstanding = await tx.pendingAction.count({ where: { sessionId, userId, status: { in: ['pending', 'awaiting_mfa', 'confirmed', 'needs_reconciliation'] } } });
    if (outstanding !== 0) return;
    await tx.agentRun.update({ where: { id: runId }, data: { status: 'completed', finishedAt: new Date(), errorCode: null } });
    await appendInTransaction(runId, { channel: 'internal', eventType: 'run_reconciled', payloadJson: JSON.stringify({ runId, status: 'completed' }) }, tx);
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
export function listRecoverableAgentRuns(now = new Date(), limit = 100): Promise<AgentRun[]> {
  return prisma.agentRun.findMany({ where: { OR: [{ status: 'interrupted' }, { status: 'running', OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }] }, orderBy: { startedAt: 'asc' }, take: limit });
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
  const updated = await client.toolInvocation.updateMany({ where: { id: invocation.id, status: { not: 'completed' } }, data: {
    status, ...(resultJson ? { resultJson } : {}), finishedAt: status === 'needs_reconciliation' ? null : new Date(),
    errorCode: status === 'failed' ? 'TOOL_FAILED' : status === 'needs_reconciliation' ? 'COMMIT_STATE_UNKNOWN' : null,
  } });
  if (updated.count === 1) await appendInTransaction(invocation.runId, { channel: 'internal', eventType: 'invocation_settled_from_action', payloadJson: JSON.stringify({ invocationId: invocation.id, actionId, status }) }, client);
}

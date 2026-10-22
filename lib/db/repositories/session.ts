import type { AgentSession } from '@/lib/db/prisma';
import { prisma, type DbClient } from '../client';
import { AppError } from '../../errors';
import { MANUAL_CARD_COMMAND_NAMES } from '../../contracts/card-management';
import { RUN_BLOCKING_PENDING_ACTION_STATUSES } from '../../contracts/security';

export interface CreateSessionInput {
  userId: string;
  stateJson: string;
  status?: string;
  locked?: boolean;
}

export function createSession(input: CreateSessionInput): Promise<AgentSession> {
  return prisma.agentSession.create({
    data: {
      userId: input.userId,
      stateJson: input.stateJson,
      status: input.status ?? 'active',
      locked: input.locked ?? false,
    },
  });
}

export function getSession(id: string, client?: DbClient): Promise<AgentSession | null> {
  return (client ?? prisma).agentSession.findUnique({ where: { id } });
}

/** Atomically create the shared demo session without resetting existing state or leases. */
export function ensureDemoSession(id: string, input: CreateSessionInput): Promise<AgentSession> {
  return prisma.agentSession.upsert({
    where: { id },
    create: { id, userId: input.userId, stateJson: input.stateJson },
    update: {},
  });
}

export function listSessions(userId: string): Promise<AgentSession[]> {
  return prisma.agentSession.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateSessionState(
  id: string,
  stateJson: string,
  options: { expectedRevision?: number; intentJson?: string | null } = {},
): Promise<AgentSession> {
  const result = await prisma.agentSession.updateMany({
    where: { id, ...(options.expectedRevision !== undefined ? { revision: options.expectedRevision } : {}) },
    data: { stateJson, revision: { increment: 1 }, ...(options.intentJson !== undefined ? { intentJson: options.intentJson } : {}) },
  });
  if (result.count !== 1) throw new AppError('CONFLICT', 'The conversation changed while this turn was running.');
  return prisma.agentSession.findUniqueOrThrow({ where: { id } });
}

export function setSessionLocked(
  id: string,
  locked: boolean,
): Promise<AgentSession> {
  return prisma.agentSession.update({ where: { id }, data: { locked } });
}

export function updateSessionStatus(
  id: string,
  status: string,
): Promise<AgentSession> {
  return prisma.agentSession.update({ where: { id }, data: { status } });
}

export function deleteSession(id: string): Promise<void> {
  return prisma.agentSession.delete({ where: { id } }).then(() => undefined);
}

/** Acquire the session write fence before inspecting dependent work; conflicts roll back the reset. */
export async function resetConversation(input: { sessionId: string; userId: string; expectedRevision: number; stateJson: string }): Promise<void> {
  await prisma.$transaction(async client => {
    const claimed = await client.agentSession.updateMany({
      where: { id: input.sessionId, userId: input.userId, revision: input.expectedRevision, activeRunId: null },
      data: { stateJson: input.stateJson, intentJson: null, revision: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new AppError('CONFLICT', 'The conversation is active or has changed. Finish pending work, refresh and try again.');
    const scope = { sessionId: input.sessionId, userId: input.userId };
    const run = await client.agentRun.findFirst({ where: { ...scope, status: { in: ['running', 'interrupted'] } }, select: { id: true } });
    const invocation = await client.toolInvocation.findFirst({ where: { run: scope,
      status: { in: ['started', 'interrupted', 'needs_reconciliation'] } }, select: { id: true } });
    const action = await client.pendingAction.findFirst({ where: { ...scope,
      toolName: { notIn: [...MANUAL_CARD_COMMAND_NAMES] },
      // A reset is blocked by every decision that still needs the user: an open prompt, an
      // authorized command in flight, a locked refusal (the user must unlock the security center)
      // and an outcome only a human can settle.
      status: { in: [...RUN_BLOCKING_PENDING_ACTION_STATUSES, 'locked'] } }, select: { id: true } });
    const task = await client.agentTask.findFirst({ where: { ...scope,
      OR: [{ status: { in: ['pending', 'running', 'paused', 'waiting_confirmation'] } }, { executionToken: { not: null } }] }, select: { id: true } });
    const review = await client.manualReview.findFirst({ where: { ...scope, status: 'open' }, select: { id: true } });
    if (run || invocation || action || task || review) throw new AppError('CONFLICT', 'The conversation has unfinished work. Finish pending operations and retry.');
  });
}

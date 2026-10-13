import type { AgentSession } from '@prisma/client';
import { prisma, type DbClient } from '../client';
import { AppError } from '../../errors';

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

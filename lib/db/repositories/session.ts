import type { AgentSession } from '@prisma/client';
import { prisma } from '../client';

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

export function getSession(id: string): Promise<AgentSession | null> {
  return prisma.agentSession.findUnique({ where: { id } });
}

export function listSessions(userId: string): Promise<AgentSession[]> {
  return prisma.agentSession.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export function updateSessionState(
  id: string,
  stateJson: string,
): Promise<AgentSession> {
  return prisma.agentSession.update({ where: { id }, data: { stateJson } });
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

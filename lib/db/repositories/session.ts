import type { AgentSession } from '@prisma/client';

export interface CreateSessionInput {
  userId: string;
  stateJson: string;
  status?: string;
  locked?: boolean;
}

export function createSession(input: CreateSessionInput): Promise<AgentSession> {
  throw new Error('not implemented');
}

export function getSession(id: string): Promise<AgentSession | null> {
  throw new Error('not implemented');
}

export function listSessions(userId: string): Promise<AgentSession[]> {
  throw new Error('not implemented');
}

export function updateSessionState(
  id: string,
  stateJson: string,
): Promise<AgentSession> {
  throw new Error('not implemented');
}

export function setSessionLocked(
  id: string,
  locked: boolean,
): Promise<AgentSession> {
  throw new Error('not implemented');
}

export function updateSessionStatus(
  id: string,
  status: string,
): Promise<AgentSession> {
  throw new Error('not implemented');
}

export function deleteSession(id: string): Promise<void> {
  throw new Error('not implemented');
}

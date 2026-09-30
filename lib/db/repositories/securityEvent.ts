import type { SecurityEvent } from '@prisma/client';

export interface SecurityEventInput {
  sessionId: string;
  userId?: string | null;
  kind: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  detail?: string | null;
  timestamp?: Date;
}

export interface SecurityEventQuery {
  userId?: string;
  sessionId?: string;
  kind?: string;
  limit?: number;
}

export function createSecurityEvent(
  input: SecurityEventInput,
): Promise<SecurityEvent> {
  throw new Error('not implemented');
}

export function listSecurityEvents(
  query?: SecurityEventQuery,
): Promise<SecurityEvent[]> {
  throw new Error('not implemented');
}

export function countSecurityEvents(
  query?: Omit<SecurityEventQuery, 'limit'>,
): Promise<number> {
  throw new Error('not implemented');
}

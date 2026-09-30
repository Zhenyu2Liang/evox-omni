import type { AuditLog } from '@prisma/client';
import type { RiskLevel } from '../../contracts/risk';

export interface AuditLogInput {
  sessionId: string;
  userId?: string | null;
  userRequest: string;
  intent?: string | null;
  toolName: string;
  riskLevel: RiskLevel | string;
  confirmationRequired?: boolean;
  confirmed?: boolean;
  mfaRequired?: boolean;
  mfaResult?: string | null;
  toolResult?: unknown;
  status: string;
  detail?: string | null;
  timestamp?: Date;
}

export interface AuditLogQuery {
  userId?: string;
  sessionId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export function createAuditLog(input: AuditLogInput): Promise<AuditLog> {
  throw new Error('not implemented');
}

export function getAuditLog(id: string): Promise<AuditLog | null> {
  throw new Error('not implemented');
}

export function listAuditLogs(query?: AuditLogQuery): Promise<AuditLog[]> {
  throw new Error('not implemented');
}

export function countAuditLogs(
  query?: Omit<AuditLogQuery, 'limit'>,
): Promise<number> {
  throw new Error('not implemented');
}

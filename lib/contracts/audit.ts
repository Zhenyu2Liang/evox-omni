import type { RiskLevel } from './risk';

export type AuditStatus = 'allowed' | 'blocked' | 'waiting_confirmation' | 'waiting_verification' | 'success' | 'failed' | 'cancelled' | 'locked';

export interface AuditEntry {
  id?: string;
  timestamp: number;
  sessionId: string;
  userRequest: string;
  intent?: string;
  toolName: string;
  riskLevel: RiskLevel;
  confirmationRequired: boolean;
  confirmed: boolean;
  mfaRequired: boolean;
  mfaResult?: 'success' | 'failed' | 'not_required';
  toolResult?: unknown;
  status: AuditStatus;
  detail?: string;
}

export type SecurityEventKind = 'INJECTION_ATTEMPT' | 'MFA_FAILURE' | 'CIRCUIT_BREAKER_TRIPPED' | 'HIGH_RISK_BLOCKED' | 'LIMIT_EXCEEDED' | 'ANOMALY_FLAGGED' | 'SECURITY_RESET';

export interface SecurityEvent {
  id?: string;
  timestamp: number;
  sessionId: string;
  kind: SecurityEventKind;
  severity: 'low' | 'medium' | 'high';
  message: string;
  detail?: unknown;
}

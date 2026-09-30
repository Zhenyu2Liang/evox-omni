import type { RiskLevel } from './risk';
import type { ToolName } from './tools';

export type SecurityDecisionKind = 'allow' | 'require_confirmation' | 'require_mfa' | 'deny';

export interface SecurityEvaluation {
  toolName: ToolName;
  tier: RiskLevel;
  requiresConfirmation: boolean;
  requiresMfa: boolean;
  reasons: string[];
  amount?: number;
  dailyTotal?: number;
  blocked: boolean;
  blockReason?: string;
}

export type PendingActionStatus = 'pending' | 'awaiting_mfa' | 'confirmed' | 'executed' | 'failed' | 'cancelled' | 'locked';

export interface PendingActionSummary {
  title: string;
  toolName: ToolName;
  tier: RiskLevel;
  fields: Array<{ label: string; value: string }>;
  amount?: number;
  requiresMfa: boolean;
  mfaHint?: string;
}

export interface PendingAction {
  id: string;
  sessionId: string;
  toolName: ToolName;
  args: Record<string, unknown>;
  tier: RiskLevel;
  requiresMfa: boolean;
  status: PendingActionStatus;
  summary: PendingActionSummary;
  createdAt: number;
  updatedAt: number;
}

export interface SecurityDecision {
  kind: SecurityDecisionKind;
  tier: RiskLevel;
  evaluation: SecurityEvaluation;
  pendingActionId?: string;
  message: string;
}

import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { ToolExecutionResult } from '../tools';
import type { RunTurnDeps } from '../run-turn';

/** Request identity is an assertion against persisted ownership, never a grant. */
export interface ConfirmOptions {
  deps?: RunTurnDeps;
  onEvent?: (event: AgentStreamEvent) => void;
  userId?: string;
  sessionId?: string;
}

export interface ConfirmationOutcome {
  ok: boolean;
  actionId: string;
  status: PendingActionStatus;
  tier: RiskLevel;
  requiresMfa: boolean;
  message: string;
  result?: ToolExecutionResult;
  events: AgentStreamEvent[];
}

/** The planner's gateway execution port reports failures as values. */
export interface GatedToolOutcome {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  errorCode?: import('@/lib/errors').ErrorCode;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
}

export interface TrustedIdentity {
  userId: string;
  sessionId: string;
}

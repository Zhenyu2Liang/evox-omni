import type { PendingAction, MfaChallenge } from '@prisma/client';
import type { RiskLevel } from '../../contracts/risk';
import type { PendingActionSummary } from '../../contracts/security';

export type PendingActionWithMfa = PendingAction & { mfa: MfaChallenge | null };

export interface CreatePendingActionInput {
  sessionId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  tier: RiskLevel | string;
  requiresMfa: boolean;
  summary: PendingActionSummary;
  status?: string;
}

export interface CreateMfaChallengeInput {
  actionId: string;
  code: string;
  maxAttempts?: number;
  expiresAt?: Date | null;
}

export function createPendingAction(
  input: CreatePendingActionInput,
): Promise<PendingAction> {
  throw new Error('not implemented');
}

export function getPendingAction(
  id: string,
): Promise<PendingActionWithMfa | null> {
  throw new Error('not implemented');
}

export function listPendingActions(query: {
  sessionId?: string;
  status?: string;
  limit?: number;
}): Promise<PendingAction[]> {
  throw new Error('not implemented');
}

export function updatePendingActionStatus(
  id: string,
  status: string,
): Promise<PendingAction> {
  throw new Error('not implemented');
}

export function createMfaChallenge(
  input: CreateMfaChallengeInput,
): Promise<MfaChallenge> {
  throw new Error('not implemented');
}

export function getMfaChallenge(
  actionId: string,
): Promise<MfaChallenge | null> {
  throw new Error('not implemented');
}

export function incrementMfaAttempts(actionId: string): Promise<MfaChallenge> {
  throw new Error('not implemented');
}

export function updateMfaChallengeStatus(
  actionId: string,
  status: string,
): Promise<MfaChallenge> {
  throw new Error('not implemented');
}

export function resetMfaAttempts(actionId: string): Promise<MfaChallenge> {
  throw new Error('not implemented');
}

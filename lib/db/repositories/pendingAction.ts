import type { PendingAction, MfaChallenge } from '@prisma/client';
import { prisma } from '../client';
import { toJson } from '../../json';
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
  /** The user's original natural-language request, persisted for audit. */
  userRequest?: string;
  /** Derived intent label persisted for audit. */
  intent?: string;
}

export interface CreateMfaChallengeInput {
  actionId: string;
  code: string;
  maxAttempts?: number;
  expiresAt?: Date | null;
}

const DEFAULT_LIMIT = 100;

export function createPendingAction(
  input: CreatePendingActionInput,
): Promise<PendingAction> {
  return prisma.pendingAction.create({
    data: {
      sessionId: input.sessionId,
      userId: input.userId,
      toolName: input.toolName,
      argsJson: toJson(input.args),
      riskLevel: input.tier,
      requiresMfa: input.requiresMfa,
      summaryJson: toJson(input.summary),
      status: input.status ?? 'pending',
      userRequest: input.userRequest ?? null,
      intent: input.intent ?? null,
    },
  });
}

export function getPendingAction(
  id: string,
): Promise<PendingActionWithMfa | null> {
  return prisma.pendingAction.findUnique({
    where: { id },
    include: { mfa: true },
  });
}

export function listPendingActions(query: {
  sessionId?: string;
  status?: string;
  limit?: number;
}): Promise<PendingAction[]> {
  return prisma.pendingAction.findMany({
    where: {
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit ?? DEFAULT_LIMIT,
  });
}

export function updatePendingActionStatus(
  id: string,
  status: string,
): Promise<PendingAction> {
  return prisma.pendingAction.update({ where: { id }, data: { status } });
}

export function createMfaChallenge(
  input: CreateMfaChallengeInput,
): Promise<MfaChallenge> {
  return prisma.mfaChallenge.create({
    data: {
      actionId: input.actionId,
      code: input.code,
      maxAttempts: input.maxAttempts ?? 3,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

export function getMfaChallenge(
  actionId: string,
): Promise<MfaChallenge | null> {
  return prisma.mfaChallenge.findUnique({ where: { actionId } });
}

export function incrementMfaAttempts(actionId: string): Promise<MfaChallenge> {
  return prisma.mfaChallenge.update({
    where: { actionId },
    data: { attempts: { increment: 1 } },
  });
}

export function updateMfaChallengeStatus(
  actionId: string,
  status: string,
): Promise<MfaChallenge> {
  return prisma.mfaChallenge.update({ where: { actionId }, data: { status } });
}

export function resetMfaAttempts(actionId: string): Promise<MfaChallenge> {
  return prisma.mfaChallenge.update({ where: { actionId }, data: { attempts: 0 } });
}

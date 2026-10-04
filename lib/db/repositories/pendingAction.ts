import type { PendingAction, MfaChallenge } from '@prisma/client';
import { prisma } from '../client';
import { toJson } from '../../json';
import type { RiskLevel } from '../../contracts/risk';
import type { PendingActionSummary, PendingActionStatus } from '../../contracts/security';

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

/**
 * Input for `claimPendingAction` — a compare-and-set (CAS) transition of a `PendingAction`'s
 * status, optionally scoped to its owning `userId` / `sessionId`.
 */
export interface ClaimPendingActionInput {
  actionId: string;
  from: PendingActionStatus[];
  to: PendingActionStatus;
  userId?: string;
  sessionId?: string;
}

/** Ownership view of a `PendingAction` (no args/summary/MFA) — used to authorize callers. */
export interface PendingActionOwnership {
  id: string;
  userId: string;
  sessionId: string;
  status: string;
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

/**
 * Unconditional status setter — an alias of `updatePendingActionStatus` for persisting a
 * terminal state (`'executed'` / `'failed'` / …) AFTER an action has been claimed. Does no
 * compare-and-set; use `claimPendingAction` for exactly-once transitions.
 */
export const setPendingActionStatus = updatePendingActionStatus;

/**
 * The ONE-AND-ONLY exactly-once claim gate for a `PendingAction`.
 *
 * Performs a SINGLE atomic compare-and-set: the row's status is moved from any of `from`
 * to `to` ONLY IF it currently matches one of `from` (and, when supplied, the row's `userId`
 * / `sessionId` match). Returns `true` iff exactly one row was transitioned.
 *
 * Concurrency: the transition is a single `updateMany` statement, so a second/concurrent
 * claim (whose `status IN from` no longer matches) transitions 0 rows and returns `false`.
 */
export async function claimPendingAction(
  input: ClaimPendingActionInput,
): Promise<boolean> {
  const result = await prisma.pendingAction.updateMany({
    where: {
      id: input.actionId,
      status: { in: input.from },
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
    data: { status: input.to },
  });
  return result.count === 1;
}

/**
 * Ownership reader: the minimal identifying fields of a `PendingAction` used to authorize a
 * caller before executing it. Returns `null` when the action does not exist.
 */
export function getPendingActionOwnership(
  actionId: string,
): Promise<PendingActionOwnership | null> {
  return prisma.pendingAction.findUnique({
    where: { id: actionId },
    select: { id: true, userId: true, sessionId: true, status: true },
  });
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

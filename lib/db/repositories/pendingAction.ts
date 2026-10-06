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
  /**
   * Owning plan (`AgentTask.id`), persisted AT CREATION so a plan-level cancel can revoke every
   * operation belonging to the plan. `null` (absent) for actions created outside the planner.
   */
  taskId?: string;
  /**
   * Owning node (`AgentTaskNode.nodeId`), persisted AT CREATION alongside `taskId`.
   * `null` (absent) for actions created outside the planner.
   */
  nodeId?: string;
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

/** Plan-link view of a `PendingAction`: the owning plan/node it was created under (if any). */
export interface PendingActionPlanLink {
  id: string;
  taskId: string | null;
  nodeId: string | null;
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
      taskId: input.taskId ?? null,
      nodeId: input.nodeId ?? null,
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

/**
 * Plan-scoped enumeration: EVERY `PendingAction` belonging to the plan `taskId`, optionally
 * narrowed to a set of `statuses`. Returned oldest-first (`createdAt` asc) so the plan's actions
 * read in creation order. Because this is a plan-scoped listing (not a time-series page) it takes
 * no `take` limit.
 */
export function listPendingActionsByTask(
  taskId: string,
  opts?: { statuses?: string[] },
): Promise<PendingAction[]> {
  return prisma.pendingAction.findMany({
    where: {
      taskId,
      ...(opts?.statuses?.length ? { status: { in: opts.statuses } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Bulk plan-level revocation: cancels EVERY `PendingAction` of the plan `taskId` whose status is
 * currently in `fromStatuses`, returning the number of rows transitioned.
 *
 * Race-safe by construction — implemented as a SINGLE atomic `updateMany` statement, so a
 * concurrent claim of one of the actions simply is not matched (it no longer has a status in
 * `fromStatuses`) and the two operations cannot interleave.
 */
export async function revokePendingActionsByTask(
  taskId: string,
  fromStatuses: string[],
): Promise<number> {
  const result = await prisma.pendingAction.updateMany({
    where: { taskId, status: { in: fromStatuses } },
    data: { status: 'cancelled' },
  });
  return result.count;
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

/**
 * Plan-link reader: the `taskId` / `nodeId` a `PendingAction` was created under, used to resolve
 * the owning plan/node of an action (e.g. to resume a blocked DAG node). A `select` projection;
 * returns `null` when the action does not exist. Sibling of `getPendingActionOwnership` — kept
 * separate so that reader's projection stays minimal.
 */
export function getPendingActionPlanLink(
  actionId: string,
): Promise<PendingActionPlanLink | null> {
  return prisma.pendingAction.findUnique({
    where: { id: actionId },
    select: { id: true, taskId: true, nodeId: true },
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

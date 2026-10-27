import type { PendingAction, MfaChallenge, Prisma } from '@/lib/db/prisma';
import { prisma } from '../client';
import { toJson } from '../../json';
import { AppError } from '../../errors';
import type { RiskLevel } from '../../contracts/risk';
import type { PendingActionSummary, PendingActionStatus } from '../../contracts/security';
import { OPEN_PENDING_ACTION_STATUSES } from '../../contracts/security';

/**
 * Repository for the `PendingAction` aggregate (+ its `MfaChallenge`).
 *
 * TRANSACTION COMPOSABILITY — every function here takes an OPTIONAL trailing
 * `client: Prisma.TransactionClient = prisma`. The default is the shared singleton, so existing
 * callers are unaffected; passing an explicit client (a `prisma.$transaction` handle) routes ALL
 * of that function's DB access through it, letting a caller compose several of these calls into
 * ONE transaction so they cannot interleave. This is required by the cancel/authorize
 * coordination flow: a plan-level cancel (`revokePendingActionsByTask`) and a concurrent
 * authorization CAS (`claimPendingAction`) must be all-or-nothing together.
 */

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
  invocationId?: string;
  authorizationDecisionId?: string;
}

export interface CreateMfaChallengeInput {
  actionId: string;
  code: string;
  maxAttempts?: number;
  expiresAt?: Date | null;
  commandDigest?: string;
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
  client: Prisma.TransactionClient = prisma,
): Promise<PendingAction> {
  return client.pendingAction.create({
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
      invocationId: input.invocationId ?? null,
      authorizationDecisionId: input.authorizationDecisionId ?? null,
    },
  });
}

export function getPendingAction(
  id: string,
  client: Prisma.TransactionClient = prisma,
): Promise<PendingActionWithMfa | null> {
  return client.pendingAction.findUnique({
    where: { id },
    include: { mfa: true },
  });
}

export function listPendingActions(
  query: {
    sessionId?: string;
    status?: string;
    limit?: number;
  },
  client: Prisma.TransactionClient = prisma,
): Promise<PendingAction[]> {
  return client.pendingAction.findMany({
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
  client: Prisma.TransactionClient = prisma,
): Promise<PendingAction[]> {
  return client.pendingAction.findMany({
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
 *
 * Pass `client` to run this revocation inside the SAME transaction as the concurrent
 * authorization CAS (`claimPendingAction`) it must not interleave with.
 */
export async function revokePendingActionsByTask(
  taskId: string,
  fromStatuses: string[],
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  const result = await client.pendingAction.updateMany({
    where: { taskId, status: { in: fromStatuses } },
    data: { status: 'cancelled' },
  });
  return result.count;
}

export function updatePendingActionStatus(
  id: string,
  status: string,
  client: Prisma.TransactionClient = prisma,
): Promise<PendingAction> {
  return client.pendingAction.update({ where: { id }, data: { status } });
}

/**
 * Unconditional status setter — an alias of `updatePendingActionStatus` for persisting a
 * terminal state (`'executed'` / `'failed'` / …) AFTER an action has been claimed. Does no
 * compare-and-set; use `claimPendingAction` for exactly-once transitions.
 */
export const setPendingActionStatus = updatePendingActionStatus;

/**
 * PERSIST a durable EXECUTION LEASE on a `PendingAction`: which continuation owns the in-flight
 * execution and until when. This is the DURABLE analogue of the per-process `liveConfirmations`
 * ref-count — a refresh/restart (even in ANOTHER process) can tell an in-flight `confirmed` row that
 * is legitimately result-less (a live holder) apart from a genuine wedge, by reading PERSISTED state.
 *
 * It never GRANTS anything: the row's status CAS is still the authority; the lease is a TTL-bounded
 * liveness hint (see the agent layer's `EXECUTION_LEASE_TTL_MS`).
 */
export async function claimPendingActionLease(
  actionId: string,
  lease: { owner: string; expiresAt: Date; now: Date },
  client: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const result = await client.pendingAction.updateMany({
    where: {
      id: actionId,
      status: { in: [...OPEN_PENDING_ACTION_STATUSES] },
      OR: [
        { executionLeaseOwner: null },
        { executionLeaseExpiresAt: { lte: lease.now } },
      ],
    },
    data: { executionLeaseOwner: lease.owner, executionLeaseExpiresAt: lease.expiresAt },
  });
  return result.count === 1;
}

/**
 * CLEAR a `PendingAction`'s execution lease (both columns → `null`). When `opts.owner` is given the
 * clear is CONDITIONAL on the current holder, so a continuation can only release the lease IT took
 * (a takeover's fresh lease is never cleared by the overtaken holder). Returns the number of rows
 * cleared (0 when a different owner holds it).
 */
export async function clearPendingActionLease(
  actionId: string,
  opts?: { owner?: string },
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  const result = await client.pendingAction.updateMany({
    where: { id: actionId, ...(opts?.owner ? { executionLeaseOwner: opts.owner } : {}) },
    data: { executionLeaseOwner: null, executionLeaseExpiresAt: null },
  });
  return result.count;
}

/**
 * The ONE-AND-ONLY exactly-once claim gate for a `PendingAction`.
 *
 * Performs a SINGLE atomic compare-and-set: the row's status is moved from any of `from`
 * to `to` ONLY IF it currently matches one of `from` (and, when supplied, the row's `userId`
 * / `sessionId` match). Returns `true` iff exactly one row was transitioned.
 *
 * Concurrency: the transition is a single `updateMany` statement, so a second/concurrent
 * claim (whose `status IN from` no longer matches) transitions 0 rows and returns `false`.
 * Pass `client` to run the CAS inside the caller's transaction (e.g. together with a
 * plan-level cancel) — the CAS itself stays a single `updateMany` (no read-modify-write).
 */
export async function claimPendingAction(
  input: ClaimPendingActionInput,
  client: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  if (input.to === 'confirmed') {
    if (client === prisma) return prisma.$transaction(tx => claimPendingAction(input, tx));
    await assertActionMayStart(input.actionId, client);
  }
  const result = await client.pendingAction.updateMany({
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

/** Serialize a new authorization against manual handoff; existing in-flight commands may settle. */
export async function assertActionMayStart(actionId: string, client: Prisma.TransactionClient): Promise<void> {
  await client.pendingAction.updateMany({ where: { id: actionId }, data: { id: actionId } });
  const action = await client.pendingAction.findUnique({ where: { id: actionId }, select: { taskId: true } });
  if (action?.taskId && await client.manualReview.findFirst({ where: { taskId: action.taskId, status: 'open' } })) {
    throw new AppError('MANUAL_REVIEW_HOLD', 'This workflow is under manual review; a new command cannot start.');
  }
}

/**
 * Ownership reader: the minimal identifying fields of a `PendingAction` used to authorize a
 * caller before executing it. Returns `null` when the action does not exist. Pass `client` to
 * read it from within the caller's transaction.
 */
export function getPendingActionOwnership(
  actionId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<PendingActionOwnership | null> {
  return client.pendingAction.findUnique({
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
  client: Prisma.TransactionClient = prisma,
): Promise<PendingActionPlanLink | null> {
  return client.pendingAction.findUnique({
    where: { id: actionId },
    select: { id: true, taskId: true, nodeId: true },
  });
}

export function createMfaChallenge(
  input: CreateMfaChallengeInput,
  client: Prisma.TransactionClient = prisma,
): Promise<MfaChallenge> {
  return client.mfaChallenge.create({
    data: {
      actionId: input.actionId,
      code: input.code,
      maxAttempts: input.maxAttempts ?? 3,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 5 * 60_000),
      commandDigest: input.commandDigest,
    },
  });
}

export function getMfaChallenge(
  actionId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<MfaChallenge | null> {
  return client.mfaChallenge.findUnique({ where: { actionId } });
}

export function incrementMfaAttempts(
  actionId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<MfaChallenge> {
  return client.mfaChallenge.update({
    where: { actionId },
    data: { attempts: { increment: 1 } },
  });
}

export function updateMfaChallengeStatus(
  actionId: string,
  status: string,
  client: Prisma.TransactionClient = prisma,
): Promise<MfaChallenge> {
  return client.mfaChallenge.update({ where: { actionId }, data: { status } });
}

export function resetMfaAttempts(
  actionId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<MfaChallenge> {
  return client.mfaChallenge.update({ where: { actionId }, data: { attempts: 0 } });
}

/** Only called inside the audited account-unlock transaction; never grants execution. */
export async function renewLockedMfaChallenges(
  owner: { userId?: string; sessionId: string },
  client: Prisma.TransactionClient,
): Promise<number> {
  const result = await client.mfaChallenge.updateMany({
    where: {
      status: 'locked',
      action: {
        ...(owner.userId ? { userId: owner.userId } : { sessionId: owner.sessionId }),
        status: 'awaiting_mfa',
        requiresMfa: true,
      },
    },
    data: { attempts: 0, status: 'pending', expiresAt: new Date(Date.now() + 5 * 60_000), verifiedAt: null, consumedAt: null },
  });
  return result.count;
}

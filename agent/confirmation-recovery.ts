/**
 * confirmation-recovery.ts — durable recovery + LANDING primitives for the two-phase confirmation path.
 *
 * Extracted from `confirmation.ts` (kept as the thin orchestrator) to stay under the ~1000-line soft
 * budget. Security policy remains in `security/`: recovery that can create a new debit explicitly
 * re-enters that authorization layer; committed receipts are reconstructed without re-execution.
 *
 * Concerns:
 *  1. The REFERENCE-COUNTED live-confirmation registry (`isActionLive`/`retainAction`/`releaseAction`)
 *     — an in-process AUXILIARY hint only.
 *  2. The DURABLE execution lease clock/TTL (`leaseNowMs`/`EXECUTION_LEASE_TTL_MS`) and the
 *     `classifyConfirmedAction` classifier that reads the PERSISTED lease.
 *  3. STANDALONE (non-plan) wedge recovery (`recoverStandaloneWedge`), RECEIPT-FIRST.
 *  4. `settlePendingAction` — the ONE unified landing primitive (terminal status + persisted result +
 *     the execution `AuditLog`, ALL in ONE `prisma.$transaction`).
 */
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { AuditEntry } from '@/lib/contracts/audit';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import { isManualCardCommand } from '@/lib/contracts/card-management';
import {
  claimPendingAction,
  getPendingAction,
  getPendingActionPlanLink,
  setPendingActionStatus,
  type PendingActionWithMfa,
} from '@/lib/db/repositories/pendingAction';
import { getExecutionReceipt } from '@/lib/db/repositories/executionReceipt';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { safeParse, toJson } from '@/lib/json';
import { ledgerKeyForAction } from '@/lib/ledger';
import { formatCNY } from '@/lib/money';
import { createToolRegistry, type ToolExecutionResult } from './tools';
import { recordAudit } from '@/audit';
import { demoNow } from '@/lib/clock';
import { committedExecutionResult } from './execution-evidence';
import { commandExecutionAudit } from './execution-audit';
import { buildConfirmFence, guardExecutionFence } from './execution-fence';
import { buildRecoveryAudit, convergenceAuditKey, decideConvergence } from './execution-convergence';
import { recovery } from '@/security';
import { settleInvocationFromAction } from '@/lib/db/repositories/agentRun';

/* ----------------------------------------------------------------------------------------- *
 * 1. Live-confirmation registry — REFERENCE-COUNTED (in-process AUXILIARY hint)
 * ----------------------------------------------------------------------------------------- */

/**
 * `PendingAction` ids whose confirm/verify continuation is applying its side effect RIGHT NOW in
 * THIS process — a REFERENCE COUNT of the live continuations that own each action.
 *
 * WHY (the durable AMBIGUITY this resolves): a row left `confirmed` with NO persisted `resultJson`
 * is INDISTINGUISHABLE in the DB between
 *   (a) a continuation that is STILL RUNNING — it claimed the row (`confirmed`) and is applying the
 *       side effect right now, so no result has been written yet; and
 *   (b) a continuation that COMMITTED the side effect but whose result+status transaction rolled
 *       back (or whose process died before writing the result) — a genuine WEDGE.
 * A re-run of the owning plan node must NOT finalize case (a): that would evict the live
 * continuation's REAL outcome and settle the node `failed` for work that actually succeeded. It MUST
 * finalize case (b), or the plan wedges at `waiting_confirmation` forever.
 *
 * WHY A COUNT (not a `Set`): `confirmAction`/`verifyAction` register the action id BEFORE they
 * authorize and release it in a `finally`. When the SAME action is confirmed TWICE concurrently, the
 * DUPLICATE call is rejected quickly (by the gateway's exactly-once CAS → `CONFLICT`) and finishes
 * FIRST — with a `Set` its `finally` would DELETE the marker the FIRST, still-running continuation
 * still owns, and a concurrent plan re-run would then mistake the live `confirmed` row for a wedge
 * and mis-finalize it. Counting keeps the action LIVE while ANY continuation holds it: the marker is
 * removed only when the count drops back to ZERO.
 *
 * Scope: this is a PER-PROCESS liveness hint; the DURABLE analogue is the PERSISTED execution lease
 * (`PendingAction.executionLeaseOwner`/`executionLeaseExpiresAt`, written by the agent layer and
 * classified by `classifyConfirmedAction`). It never GRANTS anything: the durable `PendingAction` row
 * stays the authority and every terminal transition is still a single atomic CAS.
 */
const liveConfirmations = new Map<string, number>();

/** Is ANY confirm/verify continuation for `actionId` live in THIS process right now? */
export function isActionLive(actionId: string): boolean {
  return (liveConfirmations.get(actionId) ?? 0) > 0;
}

/** The number of live confirm/verify continuations for `actionId` in THIS process (0 when none). */
export function liveCount(actionId: string): number {
  return liveConfirmations.get(actionId) ?? 0;
}

/** Register a live continuation for `actionId` (ref-count +1). */
export function retainAction(actionId: string): void {
  liveConfirmations.set(actionId, (liveConfirmations.get(actionId) ?? 0) + 1);
}

/**
 * Release ONE live continuation for `actionId` (ref-count −1). The marker is removed ONLY when the
 * count reaches ZERO, so a rejected DUPLICATE confirm can never clear a FIRST still-live marker.
 */
export function releaseAction(actionId: string): void {
  const remaining = (liveConfirmations.get(actionId) ?? 0) - 1;
  if (remaining > 0) liveConfirmations.set(actionId, remaining);
  else liveConfirmations.delete(actionId);
}

/* ----------------------------------------------------------------------------------------- *
 * 2. Durable execution lease — TTL + clock + classifier
 * ----------------------------------------------------------------------------------------- */

/**
 * How long a persisted execution lease stays VALID. A confirm/verify continuation renews nothing (it
 * holds the lease for its whole duration and clears it in a `finally`); the TTL is the bounded
 * fallback that lets a LATER observer (after a crash / process death) reclassify an abandoned
 * `confirmed` row as recoverable rather than "processing" forever. It is deliberately generous
 * relative to a single tool call.
 */
export const EXECUTION_LEASE_TTL_MS = 120_000;

/**
 * The clock the lease is written with — the REAL wall clock by default. Tests inject a deterministic
 * clock (`__setLeaseClockForTests`) so lease expiry can be exercised without sleeping.
 */
let leaseClock: () => number = () => Date.now();

/** @internal test seam — inject the clock the lease TTL is computed from. */
export function __setLeaseClockForTests(fn: () => number): void {
  leaseClock = fn;
}

/** The current lease clock (ms epoch). */
export function leaseNowMs(): number {
  return leaseClock();
}

/** The expiry instant for a lease taken at `nowMs`. */
export function leaseExpiryFor(nowMs: number): Date {
  return new Date(nowMs + EXECUTION_LEASE_TTL_MS);
}

/**
 * Tools whose SDK write is PROVEN idempotent for a STANDALONE action — i.e. the write consumes the
 * ledger idempotency key `ledgerKeyForAction({ id, taskId, nodeId })` (= the action's own `id` for a
 * standalone action), so re-invoking the tool with that SAME key replays the already-committed row
 * instead of applying the side effect twice, and returns the TRUE outcome.
 *
 * Evidence (`transfer_money`, the ONLY member):
 *  - `banking-sdk/transfer.ts` derives the ledger row's PRIMARY KEY from the key via
 *    `@/lib/ledger#idempotentTransferTxId(userId, key)`: a repeat finds the existing row inside the
 *    same `runInTransaction` and REPLAYS it (`replayResult`, no second debit); a concurrent same-key
 *    race surfaces as a PK unique violation and is also replayed. At-most-once is enforced by the DB
 *    primary key itself, not by in-process state.
 *
 * Deliberately EXCLUDED (documented as NOT proven for the STANDALONE case): `apply_virtual_card`
 * (`idempotentCardId`) and the `createIdempotent`-backed `reserve_budget`/`create_scheduled_task` were
 * only exercised with PLAN-NODE keys (`nodeExecutionKey`); their at-most-once behavior has not been
 * validated for a standalone key, so a standalone wedge of those settles `needs_reconciliation`
 * instead of being replayed.
 */
export const RECOVERABLE_STANDALONE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'transfer_money',
]);

/** Is `toolName` a standalone tool whose wedge may be safely REPLAYED on its ledger key? */
export function isRecoverableStandaloneTool(toolName: string): boolean {
  return RECOVERABLE_STANDALONE_TOOLS.has(toolName as ToolName);
}

/** The classification of a (possibly) `confirmed` action from PERSISTED state + the current clock. */
export type ConfirmedActionClass =
  | 'settled'
  | 'processing'
  | 'recoverable'
  | 'needs_reconciliation';

/** The persisted fields `classifyConfirmedAction` reads (a structural slice of `PendingAction`). */
export interface ConfirmableActionRow {
  status: string;
  resultJson: string | null;
  toolName: string;
  executionLeaseOwner: string | null;
  executionLeaseExpiresAt: Date | null;
}

/** Statuses that are TERMINAL — a row in one of them is settled and needs no recovery. */
const TERMINAL_ACTION_STATUSES: ReadonlySet<string> = new Set<string>([
  'executed',
  'failed',
  'cancelled',
  'locked',
  'needs_reconciliation',
]);

/** Is a NON-EXPIRED persisted lease present on the row at `nowMs`? */
export function hasActiveLease(row: ConfirmableActionRow, nowMs: number): boolean {
  const owner = row.executionLeaseOwner;
  const expiresAt = row.executionLeaseExpiresAt;
  if (owner === null || owner === '') return false;
  if (expiresAt === null) return false;
  return expiresAt.getTime() > nowMs;
}

/**
 * Classify a (possibly `confirmed`) action from PERSISTED state, WITHOUT re-running anything:
 *  - `settled`              — a persisted result OR a terminal status (nothing to recover);
 *  - `processing`           — a `confirmed`, result-less row with a NON-EXPIRED persisted lease (an
 *                             in-flight continuation owns it; a refresh must NOT finalize it);
 *  - `recoverable`          — a `confirmed`, result-less row with NO live lease whose tool is in the
 *                             recoverable set (`RECOVERABLE_STANDALONE_TOOLS`);
 *  - `needs_reconciliation` — anything else (a `confirmed`, result-less row of a non-replayable tool).
 *
 * The TTL is a heuristic, not a liveness proof: an owner that legitimately blocks past
 * `EXECUTION_LEASE_TTL_MS` can be reclassified (same caveat as execution takeover).
 */
export function classifyConfirmedAction(row: ConfirmableActionRow, nowMs: number): ConfirmedActionClass {
  if (hasPersistedResult(row.resultJson)) return 'settled';
  if (TERMINAL_ACTION_STATUSES.has(row.status)) return 'settled';
  if (row.status !== 'confirmed') return 'needs_reconciliation';
  if (hasActiveLease(row, nowMs)) return 'processing';
  if (isRecoverableStandaloneTool(row.toolName)) return 'recoverable';
  return 'needs_reconciliation';
}

/* ----------------------------------------------------------------------------------------- *
 * 3. Unified landing primitive — status + result + audit in ONE transaction
 * ----------------------------------------------------------------------------------------- */

/** Input for {@link settlePendingAction}. */
export interface SettlePendingActionInput {
  actionId: string;
  /** The TERMINAL status to land (`executed` / `failed` / `needs_reconciliation` / …). */
  status: PendingActionStatus;
  /** The persisted `ToolExecutionResult` — omit to leave `resultJson` untouched. */
  result?: ToolExecutionResult;
  /** When given, land ONLY if the row currently holds one of these statuses (atomic CAS). */
  from?: PendingActionStatus[];
  /** Audit entry, or a pure builder reading the current decision AFTER the transaction's write lock. */
  audit?: AuditEntry | ((current: PendingActionWithMfa) => AuditEntry);
  /** Idempotency key for the audit insert — a repeat settle never duplicates the audit row. */
  dedupeKey?: string;
}

/**
 * LAND a `PendingAction` in ONE atomic `prisma.$transaction`: (optionally CAS) the terminal status,
 * (optionally) the persisted `ToolExecutionResult`, and (optionally) the execution `AuditLog` — so a
 * settled action can NEVER be left with a persisted result but no terminal status, a status but no
 * audit, or any other half-landed combination. Returns `false` when a requested CAS did not match
 * (a concurrent settle already moved the row — nothing is written).
 *
 * Critical audit writes are strict. Only verified duplicate identities/results are absorbed.
 * Transfers already wrote their required execution audit in the debit/ledger/receipt transaction;
 * this transaction lands state and reconciles verified audit-storage faults without another debit.
 */
export async function settlePendingAction(input: SettlePendingActionInput): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (input.from !== undefined) {
      const won = await claimPendingAction(
        { actionId: input.actionId, from: input.from, to: input.status },
        tx,
      );
      if (!won) return false;
    } else {
      await setPendingActionStatus(input.actionId, input.status, tx);
    }
    if (input.result !== undefined) {
      await tx.pendingAction.update({
        where: { id: input.actionId },
        data: { resultJson: toJson(input.result) },
      });
    }
    if (input.audit !== undefined) {
      // The status write above holds the writer slot. Recovery must use the decision that is
      // persisted NOW, not an ownership snapshot taken before a competing MFA upgrade/commit.
      const current = await tx.pendingAction.findUniqueOrThrow({ where: { id: input.actionId }, include: { mfa: true } });
      const audit = typeof input.audit === 'function' ? input.audit(current) : input.audit;
      if (audit.sessionId !== current.sessionId || audit.userId !== undefined && audit.userId !== current.userId) {
        throw new AppError('SECURITY_DENIED', 'The audit identity does not own this operation.');
      }
      await recordAudit(
        { ...audit, userId: current.userId,
          taskId: current.taskId ?? undefined, nodeId: current.nodeId ?? undefined,
          mfaResult: audit.mfaResult ?? (audit.mfaRequired
            ? current.mfa?.status === 'verified' ? 'success' : undefined : 'not_required'),
        },
        input.dedupeKey !== undefined
          ? { client: tx, dedupeKey: input.dedupeKey, strict: true }
          : { client: tx, strict: true },
      );
    }
    await settleInvocationFromAction(input.actionId, tx);
    return true;
  });
}

/* ----------------------------------------------------------------------------------------- *
 * 4. STANDALONE (non-plan) wedge recovery — RECEIPT-FIRST
 * ----------------------------------------------------------------------------------------- */

/**
 * The outcome of a standalone-wedge resolution, structurally identical to `confirmation.ts`'s
 * `ConfirmationOutcome` (kept local to avoid a type-only import cycle).
 */
export interface StandaloneWedgeOutcome {
  ok: boolean;
  actionId: string;
  status: PendingActionStatus;
  tier: RiskLevel;
  requiresMfa: boolean;
  message: string;
  result?: ToolExecutionResult;
  events: AgentStreamEvent[];
}

/**
 * Does a persisted `resultJson` payload hold a usable execution result? Mirrors the decode rule of
 * `confirmation/gated-execution.ts#recoverExecutedPlanAction` (a JSON object carrying a boolean `ok`) — a stored result means
 * the atomic result+status write DID commit, so the row is not a wedge.
 */
function hasPersistedResult(resultJson: string | null): boolean {
  const parsed = safeParse<{ ok?: unknown } | null>(resultJson, null);
  return parsed !== null && typeof parsed.ok === 'boolean';
}

/** A plan link is USABLE only when BOTH `taskId` and `nodeId` are non-null and non-empty. */
function isPlanLinked(link: { taskId: string | null; nodeId: string | null } | null): boolean {
  if (link === null) return false;
  const taskId = link.taskId?.trim();
  const nodeId = link.nodeId?.trim();
  return taskId !== undefined && taskId !== '' && nodeId !== undefined && nodeId !== '';
}

/**
 * Resolve a STANDALONE (non-plan) WEDGE reached on a REPEAT confirm/verify — a row left `confirmed`
 * with NO persisted `resultJson` because the SDK side effect committed but the result+status
 * transaction ROLLED BACK (or the process died before writing it). On a repeat confirm the gateway
 * rejects with `CONFLICT` (its exactly-once CAS no longer matches `pending`), so this is the ONLY
 * place such a row can settle — otherwise it dangles `confirmed` forever and is invisible to
 * `GET /api/actions` (which lists only `pending`/`awaiting_mfa`/`needs_reconciliation`). This also
 * covers a simulated process restart, where the in-process liveness marker is empty.
 *
 * Returns `undefined` when there is nothing to do — NOT a `confirmed` row, a row whose result IS
 * stored (not a wedge), a row still owned by a LIVE continuation (in-process ref-count OR a
 * non-expired PERSISTED lease), or a PLAN-LINKED row (whose wedge is settled by the executor's own
 * `executeGatedToolOnce` path, unchanged). Otherwise the committed FACT is consulted FIRST
 * ({@link settleFromCommittedReceipt}): an already-committed side effect is settled `executed` from
 * its `ExecutionReceipt` WITHOUT re-running the tool. Only on a miss AND a RECOVERABLE tool is the
 * side effect replayed on its idempotency key; any other standalone write tool transitions to the
 * explicit, queryable `needs_reconciliation` state (NEVER a fabricated failure, NEVER a rollback).
 */
export async function recoverStandaloneWedge(
  actionId: string,
  opts?: { selfHoldsLiveMarker?: boolean },
): Promise<StandaloneWedgeOutcome | undefined> {
  const row = await getPendingAction(actionId);
  if (row && isManualCardCommand(row.toolName)) throw new AppError('SECURITY_DENIED', 'Use the card management page to resolve this change.');
  if (row === null || row.status !== 'confirmed') return undefined;
  // A persisted result means the atomic result+status write DID commit (or a prior recovery settled
  // it) — not a wedge; fall through to the plain conflict outcome.
  if (hasPersistedResult(row.resultJson)) return undefined;
  // An ACTIVE PERSISTED LEASE means an in-flight continuation owns this `confirmed` row (even across
  // a refresh / another process): it is result-less only because that holder has not written yet.
  if (hasActiveLease(row, leaseNowMs())) return undefined;
  // A LIVE continuation in this process owns this `confirmed` row: it is result-less only because
  // that continuation has not written yet. Do NOT touch it — the duplicate reports the conflict.
  // The CALLER (a repeat confirm/verify via `conflictOutcome`) holds its OWN marker, so when asked
  // (`selfHoldsLiveMarker`) subtract it: only ANOTHER live continuation means "still owned".
  const otherLive = liveCount(actionId) - (opts?.selfHoldsLiveMarker === true ? 1 : 0);
  if (otherLive > 0) return undefined;

  const link = await getPendingActionPlanLink(actionId);
  // A PLAN-LINKED wedge is settled by the executor re-run path (`executeGatedToolOnce` →
  // `findInFlightPlanAction` / `recoverExecutedPlanAction`), preserving the existing `人工核对`
  // semantics. ONLY standalone wedges are handled here.
  if (isPlanLinked(link)) return undefined;

  const tier = (row.riskLevel as RiskLevel | undefined) ?? 'YELLOW';
  const requiresMfa = row.requiresMfa === true;

  // COMMITTED-FACT FIRST: an `ExecutionReceipt` for this execution identity proves the side effect
  // ALREADY committed — settle `executed` FROM it, WITHOUT re-running the tool. (A LEGACY
  // deterministic ledger row with no receipt is handled by the SDK replay itself, which consults it
  // before any mutable lookup — see `banking-sdk/transfer.ts#replayCommitted`.)
  const committed = await settleFromCommittedReceipt(actionId, row, link, tier, requiresMfa);
  if (committed !== undefined) return committed;

  if (isRecoverableStandaloneTool(row.toolName)) {
    return replayStandaloneAction(actionId, row, link, tier, requiresMfa);
  }
  return reconcileStandaloneAction(actionId, tier, requiresMfa);
}

/** The row shape the standalone recovery paths consume (a structural slice of `PendingAction`). */
interface StandaloneRow {
  userId: string;
  toolName: string;
  argsJson: string;
  sessionId: string;
  userRequest: string | null;
  intent: string | null;
}

/** Build the `transfer_money` summary from a persisted SDK `TransferResult` snapshot, when possible. */
export function summaryFromReceipt(toolName: string, stored: Record<string, unknown>): string | undefined {
  if (toolName !== 'transfer_money') return undefined;
  const recipient = stored.recipient as { name?: unknown } | undefined;
  const name =
    recipient !== undefined && typeof recipient.name === 'string' && recipient.name !== ''
      ? recipient.name
      : '收款人';
  const amount = typeof stored.amount === 'string' ? stored.amount : undefined;
  if (amount === undefined) return undefined;
  const newBalance = typeof stored.newBalance === 'string' ? stored.newBalance : undefined;
  const balance = newBalance !== undefined ? `，账户余额 ${formatCNY(newBalance)}` : '';
  return `已向 ${name} 转账 ${formatCNY(amount)}${balance}。`;
}

/**
 * Settle a standalone wedge FROM its COMMITTED execution receipt — the durable proof that the side
 * effect already committed with this execution identity. The tool is NEVER re-invoked (so no mutable
 * re-resolution, no second side effect); the persisted SDK result snapshot becomes the action's
 * `ToolExecutionResult`. Returns `undefined` when no (readable) receipt exists, so the caller falls
 * back to the replay/reconcile branches.
 */
async function settleFromCommittedReceipt(
  actionId: string,
  row: StandaloneRow,
  link: { taskId: string | null; nodeId: string | null } | null,
  tier: RiskLevel,
  requiresMfa: boolean,
): Promise<StandaloneWedgeOutcome | undefined> {
  let result: ToolExecutionResult | undefined;
  try {
    result = await committedExecutionResult({ ...row, id: actionId, taskId: link?.taskId ?? null, nodeId: link?.nodeId ?? null });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'CONFLICT') throw error;
    return reconcileStandaloneAction(actionId, tier, requiresMfa);
  }
  if (result === undefined) return undefined;
  const settled = await landStandalone(actionId, row, tier, requiresMfa, result, 'executed');
  return {
    ...settled,
    message:
      '该操作此前已执行但结果未留存，已从其已提交的执行凭证中恢复成功（副作用仅发生一次，未重新执行）。',
  };
}

/**
 * IDEMPOTENT REPLAY of a proven-idempotent standalone wedge. Re-invokes the tool with the SAME
 * ledger key the FIRST execution used, so the SDK replays its already-committed row (side effect
 * EXACTLY ONCE — the ledger primary key dedups the write) and returns the TRUE outcome; then lands
 * that result AND the terminal status ATOMICALLY with the recovery audit.
 */
async function replayStandaloneAction(
  actionId: string,
  row: StandaloneRow,
  link: { taskId: string | null; nodeId: string | null } | null,
  tier: RiskLevel,
  requiresMfa: boolean,
): Promise<StandaloneWedgeOutcome> {
  // A receipt miss can mean the first attempt rolled back BEFORE debit. Idempotency alone does
  // not authorize a new debit: re-enter security policy before calling the SDK.
  let authorization: Awaited<ReturnType<typeof recovery.authorizeRecoveryAction>>;
  try {
    authorization = await recovery.authorizeRecoveryAction(actionId, {
      userId: row.userId, sessionId: row.sessionId,
    });
  } catch (error) {
    // Another recovery may have committed after our receipt miss, even before we acquire the
    // authorization write lock. Resolve that committed fact without treating it as a new debit.
    if (error instanceof AppError && (error.code === 'CONFLICT' || error.code === 'CIRCUIT_OPEN')) {
      const committed = await settleFromCommittedReceipt(actionId, row, link, tier, requiresMfa);
      if (committed !== undefined) return committed;
    }
    throw error;
  }
  if (!authorization.ok) {
    return { ok: false, actionId, status: authorization.status, tier: authorization.tier,
      requiresMfa: authorization.requiresMfa, message: authorization.message,
      events: authorization.requiresMfa ? [{ type: 'mfa_required', actionId }] : [],
    };
  }
  tier = authorization.tier;
  requiresMfa = authorization.requiresMfa;
  const toolName = row.toolName as ToolName;
  const args = safeParse<Record<string, unknown>>(row.argsJson, {});
  const idempotencyKey = ledgerKeyForAction({
    id: actionId,
    taskId: link?.taskId ?? undefined,
    nodeId: link?.nodeId ?? undefined,
  });

  let result: ToolExecutionResult;
  let sideEffectCommitted = false;
  const guarded = guardExecutionFence(await buildConfirmFence(link?.taskId, link?.nodeId, actionId, {
    userId: row.userId, sessionId: row.sessionId, toolName, args, requiresMfa,
  }));
  const executionAudit = commandExecutionAudit(actionId, {
    sessionId: row.sessionId, userId: row.userId, userRequest: row.userRequest ?? '', intent: row.intent ?? undefined,
    toolName: row.toolName, riskLevel: tier, confirmationRequired: true, confirmed: true, mfaRequired: requiresMfa,
    mfaResult: authorization.mfaResult,
    toolArgs: args, taskId: link?.taskId ?? undefined, nodeId: link?.nodeId ?? undefined,
  });
  try {
    result = await createToolRegistry(row.userId).executeDirect(toolName, args, {
      idempotencyKey, fence: guarded.fence,
      onTransferCommit: executionAudit.onTransferCommit,
      onCommandCommit: executionAudit.onCommandCommit,
      onTransactionCommitted: () => { sideEffectCommitted = true; },
    });
  } catch (e) {
    // A thrown return path is not proof of business failure; convergence checks committed evidence.
    result = { ok: false, error: AppError.from(e).message };
  }

  guarded.assertPolicyAllowed();
  executionAudit.assertSucceeded();
  const current = await getPendingAction(actionId);
  if (current === null) throw new AppError('NOT_FOUND', '恢复操作不存在');
  const decision = await decideConvergence(current, { completion: result, sideEffectCommitted });
  result = decision.result ?? result;
  const status = decision.status;
  const settled = await landStandalone(actionId, row, tier, requiresMfa, result, status);
  return {
    ...settled,
    message: result.ok
      ? '已复核当前授权，按持久化操作身份完成恢复并确认执行成功（副作用仅发生一次）。'
      : `恢复执行未成功：${result.error ?? '未知原因'}`,
  };
}

/**
 * LAND a standalone recovery: persist the recovered result + terminal status + the recovery audit in
 * ONE atomic `prisma.$transaction` (via {@link settlePendingAction}), so a settled recovery always
 * leaves a durable audit and can never be stranded at `confirmed`.
 */
async function landStandalone(
  actionId: string,
  row: StandaloneRow,
  tier: RiskLevel,
  requiresMfa: boolean,
  result: ToolExecutionResult,
  status: PendingActionStatus,
): Promise<StandaloneWedgeOutcome> {
  await settlePendingAction({
    actionId,
    status,
    result,
    audit: current => {
      // Also covers CONFLICT/CIRCUIT_OPEN receipt fallbacks, which may carry a stale caller row.
      // Strict duplicate audit validation remains unchanged: differing facts still fail closed.
      requiresMfa = current.requiresMfa || current.riskLevel === 'RED';
      tier = requiresMfa ? 'RED' : current.riskLevel as RiskLevel;
      return {
        timestamp: demoNow(),
        sessionId: row.sessionId,
        userId: current.userId,
        userRequest: row.userRequest ?? '',
        intent: row.intent ?? undefined,
        toolName: row.toolName,
        riskLevel: tier,
        confirmationRequired: true,
        confirmed: true,
        mfaRequired: requiresMfa,
        mfaResult: requiresMfa ? current.mfa?.status === 'verified' ? 'success' : undefined : 'not_required',
        toolArgs: safeParse<Record<string, unknown>>(current.argsJson, {}),
        taskId: current.taskId ?? undefined,
        nodeId: current.nodeId ?? undefined,
        toolResult: result,
        status: status === 'needs_reconciliation' ? 'blocked' : result.ok ? 'success' : 'failed',
        detail: status === 'needs_reconciliation' ? '恢复：执行结果需人工核对'
          : '恢复：按持久化操作身份核对执行结果（副作用仅一次）',
      };
    },
    dedupeKey: convergenceAuditKey(actionId, status),
  });

  return { ok: result.ok, actionId, status, tier, requiresMfa, message: '', result, events: [] };
}

/**
 * MANUAL RECONCILIATION for a standalone wedge whose side effect CANNOT be safely replayed (a write
 * tool not proven idempotent). Transitions the row `confirmed` → `needs_reconciliation` via a single
 * atomic CAS — an explicit, queryable terminal state that is NEITHER `failed` (the outcome is
 * UNKNOWN, not a failure) NOR `confirmed` (which would dangle forever). NEVER fabricates a failure
 * and NEVER rolls back executed work.
 */
async function reconcileStandaloneAction(
  actionId: string,
  tier: RiskLevel,
  requiresMfa: boolean,
): Promise<StandaloneWedgeOutcome> {
  const row = await getPendingAction(actionId);
  if (row === null) throw new AppError('NOT_FOUND', '待核对操作不存在。');
  const result: ToolExecutionResult = { ok: false, error: '执行证据不足或矛盾，需人工核对（不会重新执行）。' };
  const won = await settlePendingAction({
    actionId,
    status: 'needs_reconciliation',
    from: ['confirmed'],
    result,
    audit: buildRecoveryAudit(row, { status: 'needs_reconciliation', result, evidence: 'none', write: true }),
    dedupeKey: convergenceAuditKey(actionId, 'needs_reconciliation'),
  });
  // A lost CAS means a concurrent settle already moved the row: report its CURRENT persisted status
  // truthfully (never a fabricated one).
  const current = won ? 'needs_reconciliation' : (await getPendingAction(actionId))?.status;
  const status = (current as PendingActionStatus | undefined) ?? 'needs_reconciliation';
  return {
    ok: false,
    actionId,
    status,
    tier,
    requiresMfa,
    message:
      '该操作可能已执行但结果未能留存，且其副作用无法安全重放；已标记为「待人工核对」，请到人工核对列表中处理（不会自动重试）。',
    events: [],
  };
}

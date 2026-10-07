/**
 * confirmation-recovery.ts — durable recovery primitives for the two-phase confirmation path.
 *
 * Extracted from `confirmation.ts` (kept as the thin orchestrator) to stay under the ~1000-line soft
 * budget. It owns NO policy: it never computes a tier, a confirmation or an MFA requirement — every
 * input is PERSISTED `PendingAction` state the security gateway already wrote.
 *
 * Two concerns:
 *  1. The REFERENCE-COUNTED live-confirmation registry (`isActionLive`/`retainAction`/`releaseAction`).
 *  2. STANDALONE (non-plan) wedge recovery (`recoverStandaloneWedge`).
 */
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import {
  claimPendingAction,
  getPendingAction,
  getPendingActionPlanLink,
  setPendingActionStatus,
} from '@/lib/db/repositories/pendingAction';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { safeParse, toJson } from '@/lib/json';
import { ledgerKeyForAction } from '@/lib/ledger';
import { createToolRegistry, type ToolExecutionResult } from './tools';

/* ----------------------------------------------------------------------------------------- *
 * 1. Live-confirmation registry — REFERENCE-COUNTED
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
 * Scope: like `inFlightExecutions` this is a PER-PROCESS liveness hint — a multi-process deployment
 * would additionally need a durable marker to detect case (a) across processes. It never GRANTS
 * anything: the durable `PendingAction` row stays the authority and every terminal transition is
 * still a single atomic CAS.
 */
const liveConfirmations = new Map<string, number>();

/** Is ANY confirm/verify continuation for `actionId` live in THIS process right now? */
export function isActionLive(actionId: string): boolean {
  return (liveConfirmations.get(actionId) ?? 0) > 0;
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
 * 2. STANDALONE (non-plan) wedge recovery
 * ----------------------------------------------------------------------------------------- */

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
const PROVEN_IDEMPOTENT_STANDALONE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'transfer_money',
]);

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
 * `confirmation.ts#readStoredResult` (a JSON object carrying a boolean `ok`) — a stored result means
 * `executeAuthorizedAction`'s atomic result+status write DID commit, so the row is not a wedge.
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
 * `GET /api/actions` (which lists only `pending`/`awaiting_mfa`). This also covers a simulated
 * process restart, where the in-process liveness marker is empty.
 *
 * Returns `undefined` when there is nothing to do — NOT a `confirmed` row, a row whose result IS
 * stored (not a wedge), a row still owned by a LIVE continuation in this process (a later repeat
 * keeps deferring to it), or a PLAN-LINKED row (whose wedge is settled by the executor's own
 * `executeGatedToolOnce` path, unchanged). Otherwise:
 *  - a tool whose SDK write is PROVEN idempotent (`transfer_money`) ⇒ IDEMPOTENT REPLAY: re-invoke
 *    with the SAME ledger key and persist the TRUE result + terminal status (`executed`/`failed`);
 *  - any other standalone write tool ⇒ transition the row to the explicit, queryable
 *    `needs_reconciliation` state (NEVER a fabricated failure, NEVER a rollback, NEVER a re-run).
 */
export async function recoverStandaloneWedge(
  actionId: string,
): Promise<StandaloneWedgeOutcome | undefined> {
  const row = await getPendingAction(actionId);
  if (row === null || row.status !== 'confirmed') return undefined;
  // A persisted result means the atomic result+status write DID commit (or a prior recovery settled
  // it) — not a wedge; fall through to the plain conflict outcome.
  if (hasPersistedResult(row.resultJson)) return undefined;
  // A LIVE continuation in this process owns this `confirmed` row: it is result-less only because
  // that continuation has not written yet. Do NOT touch it — the duplicate reports the conflict.
  if (isActionLive(actionId)) return undefined;

  const link = await getPendingActionPlanLink(actionId);
  // A PLAN-LINKED wedge is settled by the executor re-run path (`executeGatedToolOnce` →
  // `findInFlightPlanAction` / `recoverExecutedPlanAction`), preserving the existing `人工核对`
  // semantics. ONLY standalone wedges are handled here.
  if (isPlanLinked(link)) return undefined;

  const tier = (row.riskLevel as RiskLevel | undefined) ?? 'YELLOW';
  const requiresMfa = row.requiresMfa === true;

  if (PROVEN_IDEMPOTENT_STANDALONE_TOOLS.has(row.toolName as ToolName)) {
    return replayStandaloneAction(actionId, row, link, tier, requiresMfa);
  }
  return reconcileStandaloneAction(actionId, tier, requiresMfa);
}

/**
 * IDEMPOTENT REPLAY of a proven-idempotent standalone wedge. Re-invokes the tool with the SAME
 * ledger key the FIRST execution used, so the SDK replays its already-committed row (side effect
 * EXACTLY ONCE — the ledger primary key dedups the write) and returns the TRUE outcome; then persists
 * that result AND the terminal status ATOMICALLY, closing the same window `executeAuthorizedAction`
 * normally closes in one transaction.
 */
async function replayStandaloneAction(
  actionId: string,
  row: { userId: string; toolName: string; argsJson: string },
  link: { taskId: string | null; nodeId: string | null } | null,
  tier: RiskLevel,
  requiresMfa: boolean,
): Promise<StandaloneWedgeOutcome> {
  const toolName = row.toolName as ToolName;
  const args = safeParse<Record<string, unknown>>(row.argsJson, {});
  const idempotencyKey = ledgerKeyForAction({
    id: actionId,
    taskId: link?.taskId ?? undefined,
    nodeId: link?.nodeId ?? undefined,
  });

  let result: ToolExecutionResult;
  try {
    result = await createToolRegistry(row.userId).executeDirect(toolName, args, { idempotencyKey });
  } catch (e) {
    // A boundary throw is the REAL failure — recorded as `failed`, never swallowed, never a success.
    result = { ok: false, error: AppError.from(e).message };
  }

  const status: PendingActionStatus = result.ok ? 'executed' : 'failed';
  // Persist the recovered result and the terminal status ATOMICALLY (mirrors
  // `executeAuthorizedAction`), so the row can never dangle `confirmed` with a stored result.
  await prisma.$transaction(async (tx) => {
    await tx.pendingAction.update({
      where: { id: actionId },
      data: { resultJson: toJson(result) },
    });
    await setPendingActionStatus(actionId, status, tx);
  });

  return {
    ok: result.ok,
    actionId,
    status,
    tier,
    requiresMfa,
    message: result.ok
      ? '该操作此前已执行但结果未留存，已按其幂等键安全重放并确认执行成功（副作用仅发生一次）。'
      : `该操作此前已执行但结果未留存，幂等重放确认为失败：${result.error ?? '未知原因'}`,
    result,
    events: [],
  };
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
  const won = await claimPendingAction({
    actionId,
    from: ['confirmed'],
    to: 'needs_reconciliation',
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

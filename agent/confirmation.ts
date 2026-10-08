/**
 * confirmation.ts — the two-phase confirmation continuation.
 * A gated (YELLOW/RED) call was blocked by `beforeToolCall` and persisted by the security gateway.
 * On a human decision: (1) authorize via `security.gateway.securityGateway.authorizeAction` /
 * `.cancelAction`;
 * (2) on success execute the ORIGINAL validated args through the Banking SDK via the
 * gateway-authorized path (`executeGatedTool` → `registry.executeDirect`) — NEVER the LLM;
 * (3) record the TRUE terminal status of the action, write the audit entry, resume the owning plan
 * when the action parked a DAG node, inject the REAL result, `agent.continue()` to narrate it.
 * `executeGatedTool` is ALSO the `runTool` the agent passes to the planner so DAG nodes gate too.
 *
 * Money therefore moves ONLY here, triggered by a human decision — never by model text.
 *
 * SECURITY BOUNDARY (unchanged): this module never computes a tier, a confirmation requirement or an
 * MFA requirement — that is `security/`'s sole authority. It executes ONLY the args the gateway
 * validated and persisted at gate time, and only after the gateway has authorized the action. A
 * `SECURITY_DENIED`/`NOT_FOUND` from the gateway PROPAGATES as a thrown `AppError` (never executed);
 * an idempotency `CONFLICT` is surfaced as a real `ok:false` outcome (never a fabricated success).
 *
 * TRUSTED IDENTITY: EVERY call into the security gateway (`authorizeAction` / `cancelAction` /
 * `recordActionResult`) is made with the identity resolved from PERSISTED state — the action row's
 * `sessionId` plus the owning `AgentSession.userId`. A request-supplied `userId`/`sessionId` is
 * accepted only as an ASSERTION (a mismatch FAILS CLOSED, the action is never authorized); it is
 * never a grant. Ownership that cannot be established also fails closed.
 *
 * EFFECTIVE REQUIREMENT: the authorization's `requiresMfa` is surfaced as-is (and the EFFECTIVE tier
 * is RED whenever MFA is required). A parked YELLOW transfer that re-risks to RED at execution time
 * therefore reports `requiresMfa:true` + a `mfa_required` stream event and is audited with the
 * effective tier/requirement — instead of being flattened into a plain, MFA-less failure.
 */
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingAction, PendingActionStatus } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
// `security/index.ts` re-exports the gateway as a *namespace* only; its types (GatewayContext,
// AuthorizationResult, ToolCallAuthorization) live in the documented sub-module, which the security
// node explicitly permits importing directly.
import type { AuthorizationResult, GatewayContext } from '@/security/security-gateway';
import { security } from '@/security';
import { recordAudit } from '@/audit';
import { getSession } from '@/lib/db/repositories/session';
import {
  clearPendingActionLease,
  getPendingAction,
  getPendingActionOwnership,
  getPendingActionPlanLink,
  listPendingActionsByTask,
  setPendingActionLease,
} from '@/lib/db/repositories/pendingAction';
import { getTask } from '@/lib/db/repositories/task';
import { newId } from '@/lib/ids';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { ledgerKeyForAction, nodeExecutionKey } from '@/lib/ledger';
import { createToolRegistry, type ToolExecutionResult } from './tools';
import { buildAutomaticWriteFence, buildConfirmFence, guardExecutionFence } from './execution-fence';
import { resumeTurn } from './run-turn';
import type { RunTurnDeps } from './run-turn';
import { findTaskByPendingAction, resumeTaskForAction } from './task-control';
import {
  isActionLive,
  leaseExpiryFor,
  leaseNowMs,
  recoverStandaloneWedge,
  releaseAction,
  retainAction,
  settlePendingAction,
} from './confirmation-recovery';
import { buildRecoveryAudit, convergenceAuditKey, decideConvergence } from './execution-convergence';
import { transferExecutionAudit } from './execution-audit';

/**
 * The security gateway's runtime surface.
 *
 * Reconciliation with the security node: `security.gateway` re-exports the `security-gateway`
 * MODULE, whose individual functions (`handleToolCall`, `authorizeAction`, `cancelAction`, …) are
 * module-private — the node's public runtime API is the exported `securityGateway` object (exactly
 * what `security/security-gateway.ts` documents and what `tests/unit/security/gateway.test.ts`
 * targets). Routing through the facade therefore means `security.gateway.securityGateway.*`.
 */
const gateway = security.gateway.securityGateway;
export interface ConfirmOptions {
  deps?: RunTurnDeps;
  /** Optional streaming hook: the API layer forwards each continuation event to its SSE sink. */
  onEvent?: (event: AgentStreamEvent) => void;
  /**
   * Expected owner ASSERTION. When supplied it must match the action's PERSISTED ownership; a
   * mismatch FAILS CLOSED with `SECURITY_DENIED` (the action is never authorized or executed).
   * Omit to rely on the persisted ownership alone (the action row + its owning session).
   */
  userId?: string;
  /** Expected owning session ASSERTION; same fail-closed `SECURITY_DENIED` semantics as `userId`. */
  sessionId?: string;
}
export interface ConfirmationOutcome {
  ok: boolean;
  actionId: string;
  status: PendingActionStatus;
  /** The EFFECTIVE tier: RED whenever strong verification (MFA) is required, else the action's tier. */
  tier: RiskLevel;
  /** The EFFECTIVE MFA requirement of this decision (never the stale row flag). */
  requiresMfa: boolean;
  message: string;
  result?: ToolExecutionResult;
  events: AgentStreamEvent[];
}
/** Outcome of the single gateway-authorized execution path (mirrors planner's PlanToolOutcome). */
export interface GatedToolOutcome {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
}

/** The union of what the gateway's `AuthorizationResult` carries across its legacy/frozen shapes. */
interface RawAuth {
  ok: boolean;
  tier?: RiskLevel;
  requiresMfa?: boolean;
  status?: PendingActionStatus;
  message?: string;
  mfaResult?: 'success' | 'failed' | 'not_required';
  actionId?: string;
  code?: string;
  action?: PendingAction;
}

/**
 * Unified view over the gateway's `AuthorizationResult`.
 *
 * The security node is mid-migration: the CURRENT shape carries `status`/`message`/`mfaResult`/
 * `action`, while the FROZEN shape carries `code` (no `status`, no `action`). Reading every field
 * through this ONE normalizer keeps `tsc --noEmit` green against the current type AND the merged one
 * — no code here ever touches `auth.status` / `auth.code` / `auth.action` directly.
 */
interface AuthView {
  ok: boolean;
  tier: RiskLevel;
  requiresMfa: boolean;
  /** Resulting status: the legacy shape carries it; the frozen shape omits it (derived below). */
  status: PendingActionStatus;
  /** Safe, user-facing message (never leaks the MFA code). */
  message: string;
  mfaResult?: 'success' | 'failed' | 'not_required';
  /** Present on the frozen shape's success branch. */
  actionId?: string;
  /** Failure code (frozen shape only). */
  code?: string;
  /** The updated pending action, when the gateway returns one. */
  action?: PendingAction;
}

/** Normalize whatever `AuthorizationResult` the gateway returns into one stable `AuthView`. */
function viewAuth(auth: AuthorizationResult): AuthView {
  const a = auth as unknown as RawAuth;
  const requiresMfa = a.requiresMfa === true;
  return {
    ok: a.ok,
    tier: a.tier ?? 'YELLOW',
    requiresMfa,
    // `status` exists only on the legacy shape; the frozen shape omits it, so derive an honest one.
    status:
      a.status ?? (a.ok ? 'confirmed' : a.code === 'CIRCUIT_OPEN' ? 'locked' : 'awaiting_mfa'),
    message: a.message ?? '操作无法执行。',
    mfaResult: a.mfaResult,
    actionId: a.actionId,
    code: a.code,
    action: a.action,
  };
}

/**
 * The EFFECTIVE tier for an authorization result: MFA is a RED-only control, so any `requiresMfa`
 * yields RED (this is what surfaces an execution-time-escalated YELLOW transfer as RED).
 */
function effectiveTier(view: AuthView): RiskLevel {
  return view.requiresMfa ? 'RED' : view.tier;
}

/** The TRUSTED owner of a pending action, resolved from PERSISTED state only. */
interface TrustedIdentity {
  userId: string;
  sessionId: string;
}

/**
 * Resolve the TRUSTED identity of a pending action from persisted state — NEVER from the request.
 *
 * The `PendingAction` row supplies the owning `sessionId`; the owning `userId` comes from that
 * session row (`AgentSession.userId`). Any request-supplied `opts.userId`/`opts.sessionId` is an
 * ASSERTION: when present and mismatching the persisted ownership it FAILS CLOSED with
 * `SECURITY_DENIED` (the action is never authorized or executed). An unknown action is `NOT_FOUND`;
 * ownership that cannot be established (no owning session / no user) also FAILS CLOSED.
 */
async function resolveTrustedIdentity(
  actionId: string,
  opts?: ConfirmOptions,
): Promise<TrustedIdentity> {
  const row = await getPendingActionOwnership(actionId);
  if (row === null) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);

  if (opts?.sessionId !== undefined && opts.sessionId !== row.sessionId) {
    throw new AppError('SECURITY_DENIED', `无权操作该待处理操作: ${actionId}`);
  }

  const session = await getSession(row.sessionId);
  const userId = session?.userId;
  if (userId === undefined || userId === '') {
    throw new AppError('SECURITY_DENIED', `无法解析待处理操作的所有者会话: ${row.sessionId}`);
  }

  if (opts?.userId !== undefined && opts.userId !== userId) {
    throw new AppError('SECURITY_DENIED', `无权操作该待处理操作: ${actionId}`);
  }

  return { userId, sessionId: row.sessionId };
}

/**
 * FAIL CLOSED when the action's owning plan has been CANCELLED.
 *
 * Defense-in-depth for the `cancelTask` path: cancelling a plan already revokes its parked
 * `PendingAction`s (`task-control.ts#cancelTask` → gateway atomic claim), so the gateway would
 * reject a late confirm with `CONFLICT`. This check is the belt to that suspenders — it reads the
 * owning `AgentTask` from PERSISTED state (`findTaskByPendingAction`, which PREFERS the action's
 * persisted plan link — `PendingAction.taskId`/`nodeId` — over the node-`output` scan, then
 * `tasks.getTask`) and, when that plan is `'cancelled'`, refuses the human decision BEFORE
 * any authorization or execution, so money can never move out of a cancelled plan even if the
 * revocation raced or failed.
 *
 * Returns the refusal outcome (`ok:false`, honest persisted status), or `undefined` when the action
 * is not a gated plan node (a plain transfer, say) or its plan is not cancelled — in which case the
 * caller proceeds unchanged. Ownership stays enforced by `resolveTrustedIdentity`; an action whose
 * owner cannot be established is still `SECURITY_DENIED`, never silently allowed.
 */
async function cancelledPlanOutcome(
  actionId: string,
  sessionId: string,
): Promise<ConfirmationOutcome | undefined> {
  const located = await findTaskByPendingAction(sessionId, actionId);
  if (located === undefined) return undefined;

  const task = await getTask(located.taskId);
  if (task === null || task.status !== 'cancelled') return undefined;

  const row = await getPendingAction(actionId);
  const status = (row?.status as PendingActionStatus | undefined) ?? 'cancelled';
  const tier = (row?.riskLevel as RiskLevel | undefined) ?? 'YELLOW';
  const requiresMfa = row?.requiresMfa === true;
  return {
    ok: false,
    actionId,
    status,
    tier,
    requiresMfa,
    message: `该操作所属的任务计划已取消（${located.taskId}），已拒绝执行。`,
    events: [],
  };
}

/** The identity bag the merged gateway accepts on `recordActionResult` (legacy: ignored). */
type RecordActionResult = (
  actionId: string,
  status: 'executed' | 'failed',
  opts?: { userId?: string; sessionId?: string },
) => Promise<void>;

/**
 * Record an action's TRUE terminal status WITH the trusted identity.
 *
 * The security node's current `recordActionResult(actionId, status)` takes no identity; the cast
 * keeps this call site forward-compatible with the merged signature
 * (`recordActionResult(actionId, status, { userId, sessionId })`) without touching that node.
 */
function recordActionResult(
  actionId: string,
  status: 'executed' | 'failed',
  identity: TrustedIdentity,
): Promise<void> {
  const fn = gateway.recordActionResult as unknown as RecordActionResult;
  return fn(actionId, status, { userId: identity.userId, sessionId: identity.sessionId });
}

/** Forward every event to the caller's optional streaming hook (no-op when absent). */
function emitAll(events: readonly AgentStreamEvent[], opts?: ConfirmOptions): void {
  const onEvent = opts?.onEvent;
  if (onEvent === undefined) return;
  for (const event of events) onEvent(event);
}

/**
 * The single-flight key of an AUTO-EXECUTING (GREEN) PLAN-NODE call: its NODE identity
 * (`nodeExecutionKey(taskId, nodeId)`), or `undefined` for a call NOT tied to a plan node.
 *
 * WHY the key MUST be the node identity (NEVER `sessionId` + tool + canonical args): two INDEPENDENT
 * plans that happen to call the SAME tool with the SAME args are DIFFERENT work and MUST run
 * independently — coalescing them by args alone would silently apply one plan's side effect to the
 * other. A standalone call (no plan node) therefore has NO coalescing key: its exactly-once guarantee
 * is the DB (`PendingAction` status CAS for a gated call), never an in-process map.
 */
function executionKey(ctx: GatewayContext): string | undefined {
  if (ctx.taskId !== undefined && ctx.nodeId !== undefined) {
    return nodeExecutionKey(ctx.taskId, ctx.nodeId);
  }
  return undefined;
}

/**
 * In-flight AUTO-EXECUTING (GREEN) PLAN-NODE tool calls, keyed by `executionKey` (the node identity).
 *
 * WHY: two CONCURRENT runs of the SAME plan (a double resume / retry) can both reach the same un-run
 * node and both invoke `runTool`. The node's side effect must happen EXACTLY ONCE, so a second
 * concurrent identical call SHARES the first's in-flight promise — one execution, one side effect,
 * one shared result. The entry is CLEARED the moment the call settles (success or failure), so a
 * later SEQUENTIAL identical call is a genuinely new execution and is NEVER coalesced with a
 * completed one. A plan node's side effect is ALSO deduped in the DB (the caller passes
 * `nodeExecutionKey` as the SDK `idempotencyKey`), so a replay is at-most-once across processes too.
 */
const inFlightExecutions = new Map<string, Promise<GatedToolOutcome>>();

/**
 * Is this outcome a PARKED (human-gated) one rather than an auto-execution?
 *
 * A parked call minted a `PendingAction` the human must decide on; those are PER-CALL, so a parked
 * outcome is never shared between concurrent callers — each concurrent identical gated call keeps its
 * own pending action.
 */
function isParkedOutcome(outcome: GatedToolOutcome): boolean {
  return outcome.requiresConfirmation === true || outcome.pendingActionId !== undefined;
}

/**
 * Statuses meaning "this plan node's gated side effect is ALREADY represented" and must NOT be
 * re-minted by a fresh gate: `pending`/`awaiting_mfa` (parked, awaiting the human decision) and
 * `confirmed` (the gateway claimed the action; the confirm path is executing it — or its result was
 * already persisted but the terminal status write never landed). A re-run of the node is reported as
 * STILL PARKED only for `pending`/`awaiting_mfa`; a `confirmed` row is FINALIZED instead (stored
 * `ok:true` -> `executed`; stored `ok:false` or NO stored result -> `failed`); `executed` means the gated
 * side effect ALREADY ran and was ledgered but the owning node's REAL outcome was never persisted —
 * such a node is RECOVERED, not parked. `failed`/`cancelled`/`locked` are terminal for this purpose
 * and never hold a re-run back (`failed` MUST stay re-runnable by retry).
 */
/**
 * `PendingAction` ids whose confirm/verify continuation is applying its side effect RIGHT NOW in
 * THIS process.
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
 * `confirmAction`/`verifyAction` register their action id BEFORE they authorize (so the tiny window
 * between the gateway's CAS to `confirmed` and the registration can never be observed) and clear it
 * in a `finally` once the continuation has returned. An id PRESENT here is therefore case (a) — the
 * re-run DEFERS to the live human decision (reported as STILL PARKED, no CAS, no write); an id
 * ABSENT is case (b) — the re-run FINALIZES it (single CAS on the row, then
 * `recoverExecutedPlanAction`). Either way the tool is never re-invoked and no rollback is
 * fabricated.
 *
 * Scope: like `inFlightExecutions` this is a PER-PROCESS liveness hint — a multi-process deployment
 * would additionally need a durable marker to detect case (a) across processes. It never GRANTS
 * anything: the durable `PendingAction` row stays the authority and every terminal transition below
 * is still a single atomic CAS. It is bounded by the continuation's own lifetime (each entry is
 * removed in a `finally`; a hung continuation IS still running, so deferring to it is correct).
 */
/*
 * The live-confirmation registry is now a REFERENCE COUNT kept in `./confirmation-recovery.ts`
 * (`isActionLive` / `retainAction` / `releaseAction`). WHY a COUNT and not a `Set`: a rejected
 * DUPLICATE confirm (fast gateway `CONFLICT`) finishes FIRST, and its `finally` must NOT clear the
 * marker a FIRST, still-running continuation still owns — the marker is dropped only when the count
 * returns to ZERO. Consumers keep the SAME truthiness semantics (`isActionLive(id)` is true while any
 * continuation is live), so the live-vs-wedge distinction in `executeGatedToolOnce` is unchanged.
 */

const IN_FLIGHT_PLAN_ACTION_STATUSES: readonly PendingActionStatus[] = [
  'pending',
  'awaiting_mfa',
  'confirmed',
  'executed',
  'needs_reconciliation',
];

/**
 * The persisted `PendingAction` row shape returned by `listPendingActionsByTask` (NOT the frozen
 * `lib/contracts` `PendingAction`). Its `status` and `resultJson` are what the recovery path
 * uses to backfill an already-executed node without re-gating it.
 */
type PendingActionRow = Awaited<ReturnType<typeof listPendingActionsByTask>>[number];

/**
 * The EXISTING `PendingAction` already representing this plan node's gated side effect, if any.
 *
 * A `PendingAction` persists its owning plan+node AT CREATION (`PendingAction.taskId`/`nodeId`, in
 * the same INSERT the gateway mints the row) — so it is the authoritative "this node already has a
 * gated action" marker, available even BEFORE the node's `output.pendingActionId` is written and
 * even WHILE the confirm path is still executing it (`recordActionResult` not yet recorded).
 * Returns the oldest matching row (creation order) so the caller can branch on its STATUS.
 * `undefined` ⇒ no action yet ⇒ safe to gate.
 */
async function findInFlightPlanAction(
  taskId: string,
  nodeId: string,
): Promise<PendingActionRow | undefined> {
  const rows = await listPendingActionsByTask(taskId, {
    statuses: [...IN_FLIGHT_PLAN_ACTION_STATUSES],
  });
  return rows.find((row) => row.nodeId === nodeId);
}

/**
 * The DURABLE execution-result payload persisted on `PendingAction.resultJson` when a gated action
 * was executed (written by `executeAuthorizedAction`). It is the SDK's `ToolExecutionResult`, so a
 * recovery can reconstruct the node outcome faithfully WITHOUT re-running the side effect.
 */
interface StoredToolResult {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
}

/**
 * Decode the durable execution result stored on a `PendingAction` (`resultJson`, a JSON-text
 * `ToolExecutionResult`). `listPendingActionsByTask` selects EVERY column (no projection), so the
 * loaded row already carries it. Returns `undefined` when nothing usable was stored — an
 * empty/absent/invalid payload, or a legacy row executed before the agent layer began persisting
 * results — so the caller treats it as a terminal manual-review outcome (NEVER re-invoking the tool
 * to re-apply a non-idempotent side effect).
 */
function readStoredResult(action: PendingActionRow): StoredToolResult | undefined {
  const parsed = safeParse<Partial<StoredToolResult> | null>(action.resultJson, null);
  if (parsed === null || typeof parsed.ok !== 'boolean') return undefined;
  return { ok: parsed.ok, data: parsed.data, summary: parsed.summary, error: parsed.error };
}

/**
 * RECOVER an ALREADY-EXECUTED plan node whose real outcome was never persisted (its `PendingAction`
 * is `executed`, so the gated side effect ran and was ledgered, but the owning `AgentTaskNode` is
 * still `running`/unwritten). The gateway is deliberately NOT consulted — re-gating would mint a
 * SECOND action and re-request a human confirmation for work that already happened.
 *
 * PRIMARY (correctness): BACKFILL the node outcome from the DURABLE execution result persisted on
 * the action (`resultJson`, written by `executeAuthorizedAction` BEFORE the node result is written).
 * The node's side effect therefore does NOT run again — the persisted outcome IS the node result.
 * This is GENERIC over the stored payload: it reconstructs `{ ok, data, summary, error }` for EVERY
 * recoverable write tool (`set_card_limit`, `cancel_subscription`, `freeze_card`,
 * `apply_virtual_card`, `set_subscription_reminder`, `create_scheduled_task`, `transfer_money`,
 * `subscribe_investment`, `redeem_investment`, `report_lost_card`, `unfreeze_card`,
 * `change_password`, …) because every one of them stores the same `ToolExecutionResult` shape.
 *
 * WHY this matters: re-invoking a tool that does NOT consume the SDK idempotency key (e.g.
 * `set_card_limit`) would RE-APPLY its side effect and clobber a value the user independently
 * changed AFTER this action had already executed.
 *
 * NO stored result (a legacy row executed before the agent layer began persisting results) settles
 * the node TERMINALLY as `failed` for manual review: the tool is NEVER re-invoked, so a
 * non-idempotent side effect can never be re-applied and the plan still settles instead of being
 * wedged in-flight.
 */
async function recoverExecutedPlanAction(action: PendingActionRow): Promise<GatedToolOutcome> {
  const stored = readStoredResult(action);
  if (stored !== undefined) {
    return { ok: stored.ok, data: stored.data, summary: stored.summary, error: stored.error };
  }
  // NO stored result (a legacy row executed before the agent layer began persisting results). The
  // tool is DELIBERATELY NOT re-invoked: re-running a tool that does not consume the SDK
  // idempotency key (e.g. `set_card_limit`) would RE-APPLY its side effect and clobber a value the
  // user independently changed after this action had already executed. The node is settled
  // TERMINALLY as `failed` for manual review instead — never re-run, never re-gated, never parked.
  return {
    ok: false,
    error: '该节点此前已执行但未留存结果，需人工核对（不会重新执行）。',
  };
}

/** The un-coalesced body of `executeGatedTool`: the actual gateway gate + SDK execution. */
async function executeGatedToolOnce(ctx: GatewayContext): Promise<GatedToolOutcome> {
  try {
    // ALREADY-REPRESENTED plan node — the correctness guard the in-process single-flight map CANNOT
    // provide. When a plan node's gated side effect is ALREADY represented by a persisted action, a
    // re-run of the node must NOT re-enter the gateway and mint a SECOND duplicate action.
    //   • `pending`/`awaiting_mfa` — genuinely in-flight (awaiting the human decision): report the
    //     node as STILL PARKED on the EXISTING action (the shape the blocked path returns), so the
    //     executor keeps it in `waiting_confirmation`/`waiting_verification` with no second side effect.
    //   • `confirmed` - the gateway ALREADY claimed the action, so its side effect ran
    //     and its DURABLE result was persisted (`resultJson`), while the terminal STATUS write
    //     never landed. The row is FINALIZED (never re-parked, never re-run) via a single CAS on
    //     the action row, then read back by `recoverExecutedPlanAction` from the stored
    //     `resultJson`:
    //       - stored `ok:true`  => CAS `confirmed` -> `executed`, then recover (success node).
    //       - stored `ok:false` => CAS `confirmed` -> `failed`, then recover (FAILED node).
    //       - NO stored result  => the business effect committed but the result transaction
    //         ROLLED BACK, leaving the row `confirmed` with `resultJson=null`; CAS `confirmed`
    //         -> `failed` and route it to the manual-reconciliation path, so the node settles
    //         TERMINALLY `failed` instead of wedging the plan at `waiting_confirmation` forever.
    //         The tool is NEVER re-invoked (side effect exactly once) and NO rollback is
    //         fabricated - executed work is irreversible.
    //   • `executed` — the gated side effect ALREADY ran and was ledgered but the node's REAL outcome
    //     was never persisted: RECOVER by BACKFILLING the node result from the DURABLE execution result
    //     persisted on the action (`resultJson`) — WITHOUT re-invoking the tool, so a non-idempotent
    //     side effect (e.g. `set_card_limit`) is never re-applied.
    if (ctx.taskId !== undefined && ctx.nodeId !== undefined) {
      const existing = await findInFlightPlanAction(ctx.taskId, ctx.nodeId);
      if (existing !== undefined) {
        if (existing.status === 'executed' || existing.status === 'needs_reconciliation') {
          return recoverExecutedPlanAction(existing);
        }
        // ONE evidence-based convergence decision (see `./execution-convergence`): consult the
        // PERSISTED facts — a committed `ExecutionReceipt`, a stored result, a live continuation
        // — BEFORE settling, so a successful, irreversible side effect is never finalized `failed`
        // merely because its result+status write rolled back. A row a confirm/verify continuation is
        // applying RIGHT NOW (in-process `liveConfirmations`, or a standalone lease) is DEFERRED —
        // reported STILL PARKED on that live decision (no CAS, no write) so its real outcome is never
        // evicted — while a result-less row with NO evidence is the genuine WEDGE and IS finalized
        // (plan-linked => terminal `failed` for manual review). The tool is NEVER re-invoked on a guess.
        const decision = await decideConvergence(existing);
        if (decision.write && existing.status === 'confirmed') {
          const won = await settlePendingAction({
            actionId: existing.id,
            status: decision.status,
            result: decision.result,
            from: ['confirmed'],
            audit: buildRecoveryAudit(existing, decision),
            dedupeKey: convergenceAuditKey(existing.id, decision.status),
          });
          if (won) {
            const refreshed = (await getPendingAction(existing.id)) ?? existing;
            return recoverExecutedPlanAction(refreshed);
          }
        }
        return {
          ok: false,
          requiresConfirmation: true,
          pendingActionId: existing.id,
          error: '该计划节点已在等待人工确认，未重复受理。',
        };
      }
    }

    const auth = await gateway.handleToolCall(ctx);

    if (auth.evaluation.blocked) {
      return {
        ok: false,
        requiresConfirmation: true,
        pendingActionId: auth.action?.id,
        error: auth.blockReason ?? auth.decision.message,
      };
    }

    const registry = createToolRegistry(ctx.userId);
    // A PLAN-NODE call passes its NODE idempotency key so a re-run of the SAME node (a replay, a
    // resume, a retry) replays its SDK-level side effect instead of repeating it; a standalone call
    // takes no key. (`executeDirect` forwards `idempotencyKey` to every runner.)
    const opts = {
      ...(ctx.taskId !== undefined && ctx.nodeId !== undefined
        ? { idempotencyKey: nodeExecutionKey(ctx.taskId, ctx.nodeId) }
        : {}),
      fence: await buildAutomaticWriteFence(ctx.sessionId, ctx.taskId, ctx.nodeId),
    };
    const result = await registry.executeDirect(ctx.toolName, ctx.args, opts);
    return {
      ok: result.ok,
      data: result.data,
      summary: result.summary,
      error: result.error,
    };
  } catch (e) {
    // Infra failure (gateway/SDK) ⇒ a failed node carrying its reason, instead of an exception
    // escaping mid-plan. Never silent: the message is reported to the planner/UI.
    return { ok: false, error: AppError.from(e).message };
  }
}

/**
 * Gate a tool call through the gateway and, when allowed, execute it through the SDK.
 *
 * Blocked (YELLOW/RED/locked) ⇒ `{ ok:false, requiresConfirmation:true, pendingActionId? }` so the
 * planner parks the node in `waiting_confirmation`/`waiting_verification`. Allowed (GREEN) ⇒ the args
 * run through the Banking SDK. NEVER throws: it is the planner's `runTool` port, and a plan node must
 * report a failure as a value instead of blowing up the whole plan.
 *
 * SINGLE-FLIGHT (side effect exactly once): a CONCURRENT identical PLAN-NODE call — same node
 * identity (`taskId`+`nodeId`) — SHARES the first call's in-flight execution instead of running a
 * second time, so a duplicated resume cannot double a GREEN side effect (e.g. two `reserve_budget`s);
 * the node's side effect is ALSO DB-deduped (its `nodeExecutionKey` is passed as the SDK
 * `idempotencyKey`). A STANDALONE call (no plan node) is executed DIRECTLY — never coalesced — because
 * two independent calls that merely share a session/tool/args are different work. A PARKED outcome is
 * NOT shared: it is per-call (its own `PendingAction`), so a concurrent identical gated call runs its
 * own gate once the first settles. The in-flight entry is removed on settle, so a SEQUENTIAL identical
 * call is never coalesced with a completed one.
 *
 * ALREADY-REPRESENTED (side effect exactly once, across processes): a PLAN-NODE call (both `taskId`
 * and `nodeId` present) that ALREADY has a persisted `PendingAction` does NOT re-enter the gateway.
 * A still-in-flight one (`pending`/`awaiting_mfa`) is reported as STILL PARKED on that EXISTING
 * action; a `confirmed` one is FINALIZED via a single CAS on the row (stored `ok:true` ->
 * `executed`, stored `ok:false` or NO stored result -> `failed`) and then RECOVERED; an
 * `executed` one is RECOVERED by BACKFILLING the node result from the DURABLE execution result
 * persisted on the action (`resultJson`), WITHOUT re-invoking the tool
 * (`executeGatedToolOnce#findInFlightPlanAction` -> `recoverExecutedPlanAction`). That DB row is
 * the authority the in-process map cannot be: it holds even when a RESUME races a confirm whose
 * `recordActionResult` has not committed.
 */
export async function executeGatedTool(ctx: GatewayContext): Promise<GatedToolOutcome> {
  const key = executionKey(ctx);
  // A STANDALONE call (no plan node) has no coalescing identity — execute it directly. Its
  // exactly-once guarantee is the DB (`PendingAction` status CAS for a gated call), never an
  // in-process map keyed by args alone (which would wrongly merge UNRELATED plans).
  if (key === undefined) return executeGatedToolOnce(ctx);

  const inFlight = inFlightExecutions.get(key);
  if (inFlight !== undefined) {
    const shared = await inFlight;
    // Only auto-executing outcomes are shared; a parked outcome is per-call (own pending action).
    if (!isParkedOutcome(shared)) return shared;
    return executeGatedToolOnce(ctx);
  }

  const run = executeGatedToolOnce(ctx);
  inFlightExecutions.set(key, run);
  try {
    return await run;
  } finally {
    // Clear on settle so a LATER sequential identical call is a fresh execution. Remove ONLY our
    // entry, in case a subsequent call has already registered a new one.
    if (inFlightExecutions.get(key) === run) inFlightExecutions.delete(key);
  }
}

/**
 * An idempotency `CONFLICT` (a repeat/concurrent confirm, or a confirm after cancel) is a DOMAIN
 * outcome, not a failure: report it truthfully with the action's CURRENT persisted status.
 */
async function conflictOutcome(actionId: string, error: AppError): Promise<ConfirmationOutcome> {
  // A REPEAT confirm/verify reaches here via the gateway's exactly-once CAS (`CONFLICT`): the action
  // is no longer `pending`. For a STANDALONE action whose side effect COMMITTED but whose
  // result+status transaction ROLLED BACK, this is the ONLY place the row can settle (the gateway
  // can never match it again). Resolve that wedge FIRST — idempotent replay for a proven-idempotent
  // tool, else `needs_reconciliation`; a PLAN-LINKED wedge is left to the executor re-run path.
  // When there is nothing to recover, fall through to the plain conflict outcome below.
  const recovered = await recoverStandaloneWedge(actionId, { selfHoldsLiveMarker: true });
  if (recovered !== undefined) return recovered;
  const row = await getPendingAction(actionId);
  const status = (row?.status as PendingActionStatus | undefined) ?? 'cancelled';
  const tier = (row?.riskLevel as RiskLevel | undefined) ?? 'YELLOW';
  const requiresMfa = row?.requiresMfa === true;
  return { ok: false, actionId, status, tier, requiresMfa, message: error.message, events: [] };
}

/**
 * Resume the plan that parked this action, when there is one.
 *
 * The gated action has ALREADY executed and is ALREADY audited at this point: a plan-resume failure
 * concerns the PLAN only. It must therefore never touch the business outcome — it is surfaced as a
 * stream `error` event (never swallowed, never turned into a success).
 */
async function resumeOwningPlan(
  action: PendingAction,
  result: ToolExecutionResult,
  userId: string,
  opts?: ConfirmOptions,
): Promise<AgentStreamEvent[]> {
  try {
    const resumed = await resumeTaskForAction(
      action.sessionId,
      action.id,
      {
        ok: result.ok,
        data: result.data,
        summary: result.summary,
        error: result.error,
      },
      {
        runTool: (toolName, args, ctx) =>
          executeGatedTool({
            sessionId: action.sessionId,
            userId,
            toolName: toolName as ToolName,
            args,
            userRequest: action.userRequest ?? '',
            taskId: ctx.taskId,
            nodeId: ctx.nodeId,
          }),
      },
    );
    if (resumed === undefined) return [];
    // The planner's resume path wrote the executed node's REAL outcome (success carrying the tool's
    // data/summary, or failed carrying its error) into the plan before re-running the downstream
    // nodes; that snapshot is what the UI renders as continued DAG progress.
    const events: AgentStreamEvent[] = [{ type: 'plan_update', plan: resumed.plan }];
    emitAll(events, opts);
    return events;
  } catch (e) {
    const event: AgentStreamEvent = {
      type: 'error',
      message: `任务计划恢复失败：${AppError.from(e).message}`,
    };
    emitAll([event], opts);
    return [event];
  }
}

/**
 * Tail shared by `confirmAction`/`verifyAction`: the gateway already authorized the action, so
 * execute its ORIGINAL validated args, record its terminal status, write the audit entry, resume any
 * owning plan, then narrate the real outcome.
 *
 * `identity` is the TRUSTED owner resolved from PERSISTED state before authorization (the session
 * row is the authority); `view` carries the EFFECTIVE requirement (tier/requiresMfa) so the audit row
 * and the returned outcome are TRUTHFUL — never the stale parked-row flags.
 */
async function executeAuthorizedAction(
  actionId: string,
  view: AuthView,
  identity: TrustedIdentity,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  const action = view.action;
  if (action === undefined) {
    throw new AppError('INTERNAL', `安全网关已授权但未返回待处理操作: ${actionId}`);
  }

  const tier = effectiveTier(view);
  const requiresMfa = view.requiresMfa;

  // Defensive: the gateway already claimed the action `confirmed`. If the owning session has since
  // vanished, record the TRUE terminal status first (it must never dangle in `confirmed`) and then
  // fail closed — the trusted owner is the session row, and there is NO demo-user fallback.
  const session = await getSession(identity.sessionId);
  if (session?.userId === undefined || session.userId === '') {
    await recordActionResult(actionId, 'failed', identity);
    throw new AppError('SECURITY_DENIED', `无法解析待处理操作的所有者会话: ${identity.sessionId}`);
  }
  const userId = identity.userId;

  // Execute the args the gateway validated and persisted at gate time — straight through the
  // registry. Re-running `handleToolCall` would re-gate the call and mint a duplicate PendingAction.
  //
  // IDEMPOTENCY (gated execution): derive the SDK `idempotencyKey` from the action's PERSISTED plan
  // link via `@/lib/ledger#ledgerKeyForAction` — the SINGLE key that LINKS an action to the ledger row
  // it produces, and the SAME key `security/`'s risk engine looks the row up with (so an
  // already-ledgered in-flight action is recognized, never double-counted). A plan-node action yields
  // `nodeExecutionKey(taskId, nodeId)` — exactly what the INLINE GREEN path passes for the same node —
  // so a re-run of a GATED PLAN-NODE call replays instead of double-applying; a STANDALONE action (no
  // plan link) yields its OWN `PendingAction` id, so a repeat/concurrent confirm replays its ledger row.
  // The DB itself dedups the write, so no lock is needed around the ledger-write → terminal-status
  // window. `transfer_money` derives the created row id from the key via
  // `idempotentTransferTxId(userId, key)` (`@/lib/ledger`); the key is passed for EVERY tool.
  const registry = createToolRegistry(userId);
  const link = await getPendingActionPlanLink(actionId);
  const idempotencyKey = ledgerKeyForAction({
    id: actionId,
    taskId: link?.taskId,
    nodeId: link?.nodeId,
  });
  let result: ToolExecutionResult;
  let sideEffectCommitted = false;
  const guarded = guardExecutionFence(await buildConfirmFence(link?.taskId, link?.nodeId, actionId));
  const executionAudit = transferExecutionAudit(actionId, {
    sessionId: action.sessionId, userRequest: action.userRequest ?? '', intent: action.intent,
    toolName: action.toolName, riskLevel: tier, confirmationRequired: true, confirmed: true,
    mfaRequired: requiresMfa, mfaResult: view.mfaResult,
  });
  try {
    // WRITE-BOUNDARY fence (confirm/verify path): authority is the ACTION's own exactly-once gateway
    // claim plus its execution lease / live continuation — NOT the plan's `executionToken`, which
    // `resumeTaskForAction` legitimately mints/rotates/releases around this continuation. It therefore
    // asserts that the action is still confirmed and its owning plan is not cancelled. These
    // conditional writes serialize against cancellation before any banking mutation.
    result = await registry.executeDirect(action.toolName, action.args, {
      idempotencyKey, fence: guarded.fence, onTransferCommit: executionAudit.onTransferCommit,
      onTransactionCommitted: () => { sideEffectCommitted = true; },
    });
  } catch (e) {
    // A thrown return path is not proof of business failure; convergence checks committed evidence.
    result = { ok: false, error: AppError.from(e).message };
  }

  guarded.assertPolicyAllowed();
  executionAudit.assertSucceeded();
  const current = await getPendingAction(actionId);
  if (current === null) throw new AppError('NOT_FOUND', '执行操作不存在');
  const decision = await decideConvergence(current, { completion: result, sideEffectCommitted });
  result = decision.result ?? result;

  // LAND the ORIGINAL execution result payload AND the terminal status AND the execution AUDIT
  // ATOMICALLY — ONE `prisma.$transaction`, through the ONE unified landing primitive
  // (`confirmation-recovery.ts#settlePendingAction`). This is what lets a later RECOVERY of this
  // already-executed action's plan node BACKFILL the node result from the stored outcome instead of
  // RE-INVOKING the tool (a re-invocation would re-apply a non-idempotent side effect, e.g. clobber a
  // card limit the user independently changed after this action had executed). Written for BOTH
  // outcomes.
  //
  // The result + status + audit MUST land together: as separate statements they left a gap where the
  // result was persisted but the status write failed (leaving the action `confirmed` with a persisted
  // result, so a re-run of the owning node had to FINALIZE it) — or where the business effect
  // committed but no audit row was ever written. `dedupeKey` makes the audit insert idempotent, so a
  // repeat settle of the SAME action can never duplicate its audit row.
  await settlePendingAction({
    actionId,
    status: decision.status,
    result,
    audit: {
      timestamp: demoNow(),
      sessionId: action.sessionId,
      userRequest: action.userRequest ?? '',
      intent: action.intent,
      toolName: action.toolName,
      // TRUTHFUL audit: the EFFECTIVE tier + requirement of this decision, not the stale row flags
      // (a parked YELLOW transfer that escalated to RED is audited RED / mfaRequired:true).
      riskLevel: tier,
      confirmationRequired: true,
      confirmed: true,
      mfaRequired: requiresMfa,
      mfaResult: view.mfaResult,
      toolResult: result,
      status: decision.status === 'needs_reconciliation' ? 'blocked' : result.ok ? 'success' : 'failed',
    },
    dedupeKey: convergenceAuditKey(actionId, decision.status),
  });

  // Then RECORD the terminal status through the gateway (with the trusted identity) — the security
  // node's audited hook a later confirm/cancel relies on (it re-reads the row and rejects as
  // CONFLICT). This is NON-FATAL: the row is ALREADY settled atomically above, so a failure here must
  // never turn a successfully-executed action into an error response.
  try {
    if (decision.status === 'executed' || decision.status === 'failed') {
      await recordActionResult(actionId, decision.status, identity);
    }
  } catch {
    // Non-fatal: the atomic transaction above already persisted the TRUE terminal status.
  }
  // If this gated action parked a DAG node, hand the REAL outcome to the planner so the plan
  // continues (a re-parked node waits for the next human decision) and stream the resulting plan.
  const planEvents = await resumeOwningPlan(action, result, userId, opts);

  const { events } = await resumeTurn(
    {
      sessionId: action.sessionId,
      toolResult: result,
      // DAG nodes execute inside the model's outer submit_plan call. Standalone
      // actions must match their own tool; never reuse an unrelated query call.
      toolName: link?.taskId ? 'submit_plan' : action.toolName,
    },
    opts?.deps,
  );
  emitAll(events, opts);

  // The gated action ALREADY executed and is ALREADY audited above. A continuation (narration)
  // failure therefore only means the model could not narrate it: it must NEVER be reported as a
  // success nor hide the real business outcome. The outcome stays `result`-driven, and the
  // narration failure is appended to the message the UI shows.
  const narrationError = events.find(
    (event): event is Extract<AgentStreamEvent, { type: 'error' }> => event.type === 'error',
  );
  const businessMessage = decision.status === 'needs_reconciliation'
    ? '操作结果尚无法核实，已进入人工核对，请勿重复执行。'
    : result.ok ? '操作已执行。' : (result.error ?? '操作执行失败。');
  const message =
    narrationError === undefined
      ? businessMessage
      : `${businessMessage}（结果播报失败：${narrationError.message}）`;

  return {
    ok: result.ok,
    actionId,
    status: decision.status,
    tier,
    requiresMfa,
    message,
    result,
    events: [...planEvents, ...events],
  };
}

/**
 * Map a NON-ok authorization to its outcome — WITHOUT executing anything.
 *
 * ESCALATION (`requiresMfa`): strong verification is required (a parked YELLOW transfer that
 * re-risked to RED at execution time or a RED action without a code). It is
 * surfaced as `requiresMfa:true` / effective tier RED with a `mfa_required` stream event — NEVER
 * flattened into a plain failure that loses the requirement.
 *
 * Plain failure (`!requiresMfa`): a domain outcome carrying the gateway's safe message, no event.
 */
function blockedOutcome(
  actionId: string,
  view: AuthView,
  opts?: ConfirmOptions,
): ConfirmationOutcome {
  if (view.requiresMfa) {
    const events: AgentStreamEvent[] = view.status === 'pending' || view.status === 'awaiting_mfa'
      ? [{ type: 'mfa_required', actionId }] : [];
    emitAll(events, opts);
    return {
      ok: false,
      actionId,
      status: view.status,
      tier: 'RED',
      requiresMfa: true,
      message: view.message,
      events,
    };
  }
  return {
    ok: false,
    actionId,
    status: view.status,
    tier: view.tier,
    requiresMfa: false,
    message: view.message,
    events: [],
  };
}

/**
 * YELLOW (or RED after MFA) — authorize a pending action and execute its original args.
 *
 * The identity sent to the gateway is resolved from PERSISTED ownership (asserted against any
 * request-supplied `userId`/`sessionId`, which FAIL CLOSED on mismatch). A non-ok authorization is a
 * domain outcome: an escalation (`requiresMfa`) is surfaced as RED + `mfa_required`; an already-
 * settled action (repeat/concurrent confirm, confirm-after-cancel) is `ok:false` — never a success.
 */
async function confirmActionImpl(
  actionId: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  const identity = await resolveTrustedIdentity(actionId, opts);

  // FAIL CLOSED when the action's owning plan was cancelled: refuse BEFORE authorizing/executing.
  const cancelled = await cancelledPlanOutcome(actionId, identity.sessionId);
  if (cancelled !== undefined) return cancelled;

  let auth: AuthorizationResult;
  try {
    auth = await gateway.authorizeAction(actionId, {
      userId: identity.userId,
      sessionId: identity.sessionId,
    });
  } catch (e) {
    if (e instanceof AppError && e.code === 'CONFLICT') return conflictOutcome(actionId, e);
    throw e; // SECURITY_DENIED / NOT_FOUND propagate — the action is never executed
  }

  const view = viewAuth(auth);
  if (!view.ok) return blockedOutcome(actionId, view, opts);

  return executeAuthorizedAction(actionId, view, identity, opts);
}

/** RED — verify the mock MFA code, then authorize + execute. */
async function verifyActionImpl(
  actionId: string,
  code: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  const identity = await resolveTrustedIdentity(actionId, opts);

  // FAIL CLOSED when the action's owning plan was cancelled: refuse BEFORE authorizing/executing.
  const cancelled = await cancelledPlanOutcome(actionId, identity.sessionId);
  if (cancelled !== undefined) return cancelled;

  let auth: AuthorizationResult;
  try {
    auth = await gateway.authorizeAction(actionId, {
      mfaCode: code,
      userId: identity.userId,
      sessionId: identity.sessionId,
    });
  } catch (e) {
    if (e instanceof AppError && e.code === 'CONFLICT') return conflictOutcome(actionId, e);
    throw e;
  }

  const view = viewAuth(auth);
  // A wrong code can keep the existing awaiting_mfa decision. A locked/terminal outcome retains
  // its historical RED requirement but must not request a new code.
  if (!view.ok) return blockedOutcome(actionId, view, opts);

  return executeAuthorizedAction(actionId, view, identity, opts);
}

/**
 * Take the PERSISTED EXECUTION LEASE for `actionId` while this continuation applies a human decision.
 *
 * DURABLE, cross-process analogue of the in-process ref-count: it writes a per-invocation random
 * `owner` + a TTL onto `PendingAction.executionLeaseOwner`/`executionLeaseExpiresAt`, so ANY observer
 * — a page refresh (`GET /api/actions` → `classifyConfirmedAction`), a plan re-run, another process —
 * can read PERSISTED state and tell an in-flight `confirmed`, result-less row (a live holder →
 * `processing`) apart from a genuine WEDGE (`recoverable`/`needs_reconciliation`).
 *
 * The lease is taken ONLY while the row is still UNDECIDED (`pending`/`awaiting_mfa`) — exactly when
 * this continuation is about to apply a decision (the gateway CAS then moves it to `confirmed`). A
 * row that is ALREADY `confirmed` (or terminal) is deliberately NOT leased: `recoverStandaloneWedge`
 * in `confirmation-recovery.ts` treats an ACTIVE lease as "someone else owns this row, do not touch",
 * so leasing a `confirmed` row from its OWN repeat-decide continuation would make that very recovery
 * refuse to settle a genuine wedge. The in-process `liveConfirmations` ref-count stays the PRIMARY
 * fast hint; this persisted lease is the durable fallback for a process that never clears it.
 *
 * It never GRANTS anything — the durable `PendingAction` status CAS stays the authority; the TTL
 * (`EXECUTION_LEASE_TTL_MS`) is the bounded fallback for a crashed process. Returns the owner token to
 * release with, or `undefined` when no lease was taken (row gone, or not a decidable state).
 */
async function beginExecutionLease(actionId: string): Promise<string | undefined> {
  const row = await getPendingAction(actionId);
  if (row === null) return undefined;
  if (row.status !== 'pending' && row.status !== 'awaiting_mfa') return undefined;
  const owner = newId('lease');
  await setPendingActionLease(actionId, { owner, expiresAt: leaseExpiryFor(leaseNowMs()) });
  return owner;
}

/**
 * Release the lease taken by {@link beginExecutionLease} — CONDITIONALLY on OUR owner token, so a
 * concurrent continuation's fresh lease is never wiped by this continuation's `finally` (a takeover's
 * lease, or a duplicate's, survives). A vanished/owned-by-other row simply clears nothing.
 */
async function endExecutionLease(actionId: string, owner: string | undefined): Promise<void> {
  if (owner === undefined) return;
  await clearPendingActionLease(actionId, { owner });
}

/**
 * Run a confirm/verify continuation while marking `actionId` LIVE for THIS process for its WHOLE
 * duration (the ref-counted `liveConfirmations` registry in `confirmation-recovery.ts`) AND taking the
 * DURABLE persisted execution lease ({@link beginExecutionLease}), so neither a concurrent plan re-run
 * NOR a cross-process refresh mistakes the in-flight `confirmed` row for a wedged one. Both markers
 * are cleared in a `finally`, so a completed continuation (success, refusal, or a rolled-back result
 * transaction) leaves NO trace and a later re-run FINALIZES the wedged row.
 */
async function withLiveConfirmation<T>(
  actionId: string,
  run: () => Promise<T>,
): Promise<T> {
  retainAction(actionId);
  let leaseOwner: string | undefined;
  try {
    // The lease is taken INSIDE the try so the in-process ref-count marker is ALWAYS released: if
    // `beginExecutionLease` (a DB read + conditional write) throws, `leaseOwner` stays `undefined`
    // (→ a no-op `endExecutionLease`) and the `finally` still runs `releaseAction`. Every cleanup is
    // itself nested so a throwing `endExecutionLease` can never skip the ref-count release — the lease
    // self-heals via its TTL anyway, but a leaked ref-count would defer recovery forever.
    leaseOwner = await beginExecutionLease(actionId);
    return await run();
  } finally {
    try {
      await endExecutionLease(actionId, leaseOwner);
    } finally {
      releaseAction(actionId);
    }
  }
}

/**
 * YELLOW (or RED after MFA) — authorize a pending action and execute its original args.
 *
 * Marked LIVE for its whole duration (`withLiveConfirmation`): while it runs, the action's
 * `confirmed` row is legitimately result-less and a plan re-run must defer to it, never finalize it.
 */
export function confirmAction(
  actionId: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  return withLiveConfirmation(actionId, () => confirmActionImpl(actionId, opts));
}

/** RED — verify the mock MFA code, then authorize + execute (same LIVE marking as `confirmAction`). */
export function verifyAction(
  actionId: string,
  code: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  return withLiveConfirmation(actionId, () => verifyActionImpl(actionId, code, opts));
}

/** Cancel a pending action; no execution. */
export async function cancelAction(
  actionId: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  // The identity sent to the gateway is resolved from PERSISTED ownership (asserted against any
  // request-supplied `userId`/`sessionId`).
  const identity = await resolveTrustedIdentity(actionId, opts);

  // FAIL CLOSED when the action's owning plan was cancelled: a cancelled plan's parked action is
  // refused outright (nothing to cancel, nothing may ever run).
  const cancelled = await cancelledPlanOutcome(actionId, identity.sessionId);
  if (cancelled !== undefined) return cancelled;

  // `cancelAction` throws `AppError('NOT_FOUND'|'SECURITY_DENIED')` for an unknown/foreign action --
  // those PROPAGATE (never translated; the API layer maps them to the error envelope).
  // A `CONFLICT` means the action is NO LONGER CANCELLABLE (already terminal -- executed / failed /
  // cancelled / needs_reconciliation -- or a confirm/execute is in flight): that is a DOMAIN
  // outcome, not an error. Mirror `confirmAction`/`verifyAction` -- surface a CLEAR, STABLE
  // `ok:false` outcome carrying the action's CURRENT persisted status via `conflictOutcome`
  // (`{ ok:false, actionId, status, tier, requiresMfa, message, events:[] }`; the API maps it to
  // HTTP 200) instead of a raw `409`. The gateway's exactly-once CAS / terminal guard is UNCHANGED:
  // it still REFUSES the transition (0 rows claimed); only the refusal's SHAPE is stabilized here,
  // so nothing is rolled back and no terminal row is mutated.
  let action: PendingAction;
  try {
    action = await gateway.cancelAction(actionId, {
      userId: identity.userId,
      sessionId: identity.sessionId,
    });
  } catch (e) {
    if (e instanceof AppError && e.code === 'CONFLICT') return conflictOutcome(actionId, e);
    throw e; // NOT_FOUND / SECURITY_DENIED propagate -- the action is never touched
  }

  await recordAudit({
    timestamp: demoNow(),
    sessionId: action.sessionId,
    userRequest: action.userRequest ?? '',
    intent: action.intent,
    toolName: action.toolName,
    riskLevel: action.tier,
    confirmationRequired: true,
    confirmed: false,
    mfaRequired: action.requiresMfa,
    status: 'cancelled',
  });

  // Nothing ran, so there is no continuation to narrate and no event to stream (a cancel is not an
  // escalation, so no `mfa_required` event either).
  return {
    ok: true,
    actionId,
    status: 'cancelled',
    tier: action.tier,
    requiresMfa: action.requiresMfa === true,
    message: '操作已取消。',
    events: [],
  };
}

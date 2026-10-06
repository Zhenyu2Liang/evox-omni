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
  getPendingAction,
  getPendingActionOwnership,
  getPendingActionPlanLink,
  listPendingActionsByTask,
} from '@/lib/db/repositories/pendingAction';
import { getTask } from '@/lib/db/repositories/task';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { ledgerKeyForAction, nodeExecutionKey } from '@/lib/ledger';
import { createToolRegistry, type ToolExecutionResult } from './tools';
import { resumeTurn } from './run-turn';
import type { RunTurnDeps } from './run-turn';
import { findTaskByPendingAction, resumeTaskForAction } from './task-control';

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
 * re-minted: `pending`/`awaiting_mfa` (parked, awaiting the human decision) and `confirmed` (the
 * gateway has claimed the action and the confirm path is executing it RIGHT NOW — e.g.
 * `gateway.recordActionResult` is still in flight). `executed`/`failed`/`cancelled`/`locked` are
 * terminal for this purpose and never hold a re-run back.
 */
const IN_FLIGHT_PLAN_ACTION_STATUSES: readonly PendingActionStatus[] = [
  'pending',
  'awaiting_mfa',
  'confirmed',
];

/**
 * The id of an EXISTING `PendingAction` already representing this plan node's gated side effect.
 *
 * A `PendingAction` persists its owning plan+node AT CREATION (`PendingAction.taskId`/`nodeId`, in
 * the same INSERT the gateway mints the row) — so it is the authoritative "this node already has a
 * gated action" marker, available even BEFORE the node's `output.pendingActionId` is written and
 * even WHILE the confirm path is still executing it (`recordActionResult` not yet recorded).
 * Returns the oldest matching row (creation order). `undefined` ⇒ no action yet ⇒ safe to gate.
 */
async function findInFlightPlanActionId(
  taskId: string,
  nodeId: string,
): Promise<string | undefined> {
  const rows = await listPendingActionsByTask(taskId, {
    statuses: [...IN_FLIGHT_PLAN_ACTION_STATUSES],
  });
  return rows.find((row) => row.nodeId === nodeId)?.id;
}

/** The un-coalesced body of `executeGatedTool`: the actual gateway gate + SDK execution. */
async function executeGatedToolOnce(ctx: GatewayContext): Promise<GatedToolOutcome> {
  try {
    // ALREADY-IN-PROGRESS plan node — the correctness guard the in-process single-flight map CANNOT
    // provide. When a plan node's gated side effect has ALREADY been claimed (a `pending`/
    // `awaiting_mfa` action waiting on the human, or a `confirmed` action whose side effect the
    // confirm path is executing right now), a re-run of the node (a plan RESUME between the effect
    // and its persisted result) must NOT re-enter the gateway and mint a SECOND duplicate action —
    // confirming which would apply the side effect twice. The node is instead reported as STILL
    // PARKED on the EXISTING action (the same parked shape the blocked path returns), so the executor
    // keeps it in `waiting_confirmation`/`waiting_verification` with no second side effect.
    if (ctx.taskId !== undefined && ctx.nodeId !== undefined) {
      const existingActionId = await findInFlightPlanActionId(ctx.taskId, ctx.nodeId);
      if (existingActionId !== undefined) {
        return {
          ok: false,
          requiresConfirmation: true,
          pendingActionId: existingActionId,
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
    const opts =
      ctx.taskId !== undefined && ctx.nodeId !== undefined
        ? { idempotencyKey: nodeExecutionKey(ctx.taskId, ctx.nodeId) }
        : undefined;
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
 * ALREADY-PARKED (side effect exactly once, across processes): a PLAN-NODE call (both `taskId` and
 * `nodeId` present) whose node ALREADY has a non-terminal `PendingAction` (`pending`/`awaiting_mfa`/
 * `confirmed`) does NOT re-enter the gateway — it is reported as still parked on that EXISTING action
 * (`executeGatedToolOnce#findInFlightPlanActionId`). That DB row is the authority the in-process map
 * cannot be: it holds even when a RESUME races a confirm whose `recordActionResult` has not committed.
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
  try {
    result = await registry.executeDirect(action.toolName, action.args, { idempotencyKey });
  } catch (e) {
    // A boundary throw is the REAL failure — recorded as `failed`, never swallowed, never a success.
    result = { ok: false, error: AppError.from(e).message };
  }

  // Persist the TRUE terminal status (with the trusted identity) so a later confirm/cancel is
  // rejected as CONFLICT instead of re-authorizing an already-executed action.
  await recordActionResult(actionId, result.ok ? 'executed' : 'failed', identity);

  await recordAudit({
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
    status: result.ok ? 'success' : 'failed',
  });

  // If this gated action parked a DAG node, hand the REAL outcome to the planner so the plan
  // continues (a re-parked node waits for the next human decision) and stream the resulting plan.
  const planEvents = await resumeOwningPlan(action, result, userId, opts);

  const { events } = await resumeTurn(
    { sessionId: action.sessionId, toolResult: result },
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
  const businessMessage = result.ok ? '操作已执行。' : (result.error ?? '操作执行失败。');
  const message =
    narrationError === undefined
      ? businessMessage
      : `${businessMessage}（结果播报失败：${narrationError.message}）`;

  return {
    ok: result.ok,
    actionId,
    status: result.ok ? 'executed' : 'failed',
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
 * re-risked to RED at execution time, a RED action without a code, or a locked session). It is
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
    const events: AgentStreamEvent[] = [{ type: 'mfa_required', actionId }];
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
export async function confirmAction(
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
export async function verifyAction(
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
  // A WRONG code (⇒ `awaiting_mfa`, `mfaResult:'failed'`) or a tripped breaker (⇒ `locked`) still
  // requires verification — surfaced as RED + `mfa_required`, never a bare failure.
  if (!view.ok) return blockedOutcome(actionId, view, opts);

  return executeAuthorizedAction(actionId, view, identity, opts);
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

  // `cancelAction` throws `AppError('NOT_FOUND'|'SECURITY_DENIED'|'CONFLICT')` for an
  // unknown/foreign/settled action; the API layer maps it to the error envelope (never swallowed).
  const action = await gateway.cancelAction(actionId, {
    userId: identity.userId,
    sessionId: identity.sessionId,
  });

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

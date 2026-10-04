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
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { createToolRegistry, type ToolExecutionResult } from './tools';
import { resumeTurn } from './run-turn';
import type { RunTurnDeps } from './run-turn';
import { resumeTaskForAction } from './task-control';

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
   * Expected owner. When supplied, the gateway rejects an action belonging to another user with
   * `SECURITY_DENIED` (which PROPAGATES — the action is never executed). Omit to rely on the action
   * id itself as the capability (the CLI/one-arg call shape).
   */
  userId?: string;
  /** Expected owning session; same `SECURITY_DENIED` semantics as `userId`. */
  sessionId?: string;
}
export interface ConfirmationOutcome {
  ok: boolean;
  actionId: string;
  status: PendingActionStatus;
  tier: RiskLevel;
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

/** Forward every event to the caller's optional streaming hook (no-op when absent). */
function emitAll(events: readonly AgentStreamEvent[], opts?: ConfirmOptions): void {
  const onEvent = opts?.onEvent;
  if (onEvent === undefined) return;
  for (const event of events) onEvent(event);
}

/**
 * Gate a tool call through the gateway and, when allowed, execute it through the SDK.
 *
 * Blocked (YELLOW/RED/locked) ⇒ `{ ok:false, requiresConfirmation:true, pendingActionId? }` so the
 * planner parks the node in `waiting_confirmation`/`waiting_verification`. Allowed (GREEN) ⇒ the args
 * run through the Banking SDK. NEVER throws: it is the planner's `runTool` port, and a plan node must
 * report a failure as a value instead of blowing up the whole plan.
 */
export async function executeGatedTool(ctx: GatewayContext): Promise<GatedToolOutcome> {
  try {
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
    const result = await registry.executeDirect(ctx.toolName, ctx.args);
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
 * An idempotency `CONFLICT` (a repeat/concurrent confirm, or a confirm after cancel) is a DOMAIN
 * outcome, not a failure: report it truthfully with the action's CURRENT persisted status.
 */
async function conflictOutcome(actionId: string, error: AppError): Promise<ConfirmationOutcome> {
  const row = await getPendingAction(actionId);
  const status = (row?.status as PendingActionStatus | undefined) ?? 'cancelled';
  const tier = (row?.riskLevel as RiskLevel | undefined) ?? 'YELLOW';
  return { ok: false, actionId, status, tier, message: error.message, events: [] };
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
): Promise<void> {
  try {
    await resumeTaskForAction(
      action.sessionId,
      action.id,
      {
        ok: result.ok,
        data: result.data,
        summary: result.summary,
        error: result.error,
      },
      {
        runTool: (toolName, args) =>
          executeGatedTool({
            sessionId: action.sessionId,
            userId,
            toolName: toolName as ToolName,
            args,
            userRequest: action.userRequest ?? '',
          }),
      },
    );
  } catch (e) {
    opts?.onEvent?.({
      type: 'error',
      message: `任务计划恢复失败：${AppError.from(e).message}`,
    });
  }
}

/**
 * Tail shared by `confirmAction`/`verifyAction`: the gateway already authorized the action, so
 * execute its ORIGINAL validated args, record its terminal status, write the audit entry, resume any
 * owning plan, then narrate the real outcome.
 */
async function executeAuthorizedAction(
  actionId: string,
  auth: {
    action?: PendingAction;
    mfaResult?: 'success' | 'failed' | 'not_required';
  },
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  const action = auth.action;
  if (action === undefined) {
    throw new AppError('INTERNAL', `安全网关已授权但未返回待处理操作: ${actionId}`);
  }

  // `PendingAction` carries the session but not the user: resolve the owner for the SDK call. The
  // session row IS the authority — an absent/unknown session (or a row without a user) is NOT a valid
  // owner. There is deliberately NO demo-user fallback: the action has already been claimed
  // `confirmed` by the gateway, so record the real terminal status first (it must never dangle in
  // `confirmed`) and then refuse.
  const session = await getSession(action.sessionId);
  const userId = session?.userId;
  if (userId === undefined || userId === '') {
    await gateway.recordActionResult(actionId, 'failed');
    throw new AppError('SECURITY_DENIED', `无法解析待处理操作的所有者会话: ${action.sessionId}`);
  }

  // Execute the args the gateway validated and persisted at gate time — straight through the
  // registry. Re-running `handleToolCall` would re-gate the call and mint a duplicate PendingAction.
  const registry = createToolRegistry(userId);
  let result: ToolExecutionResult;
  try {
    result = await registry.executeDirect(action.toolName, action.args);
  } catch (e) {
    // A boundary throw is the REAL failure — recorded as `failed`, never swallowed, never a success.
    result = { ok: false, error: AppError.from(e).message };
  }

  // Persist the TRUE terminal status so a later confirm/cancel is rejected as CONFLICT instead of
  // re-authorizing an already-executed action.
  await gateway.recordActionResult(actionId, result.ok ? 'executed' : 'failed');

  await recordAudit({
    timestamp: demoNow(),
    sessionId: action.sessionId,
    userRequest: action.userRequest ?? '',
    intent: action.intent,
    toolName: action.toolName,
    riskLevel: action.tier,
    confirmationRequired: true,
    confirmed: true,
    mfaRequired: action.requiresMfa,
    mfaResult: auth.mfaResult,
    toolResult: result,
    status: result.ok ? 'success' : 'failed',
  });

  // If this gated action parked a DAG node, hand the REAL outcome to the planner so the plan
  // continues (a re-parked node waits for the next human decision).
  await resumeOwningPlan(action, result, userId, opts);

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
    tier: action.tier,
    message,
    result,
    events,
  };
}

/**
 * YELLOW (or RED after MFA) — authorize a pending action and execute its original args.
 *
 * A non-ok authorization (RED without a code ⇒ `awaiting_mfa`, locked session ⇒ `locked`) is a
 * domain outcome, not an error: it is returned as `ok:false` with the gateway's safe message. An
 * already-settled action (repeat/concurrent confirm, confirm-after-cancel) is ALSO `ok:false` — never
 * a success.
 */
export async function confirmAction(
  actionId: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  let auth: AuthorizationResult;
  try {
    auth = await gateway.authorizeAction(actionId, {
      userId: opts?.userId,
      sessionId: opts?.sessionId,
    });
  } catch (e) {
    if (e instanceof AppError && e.code === 'CONFLICT') return conflictOutcome(actionId, e);
    throw e; // SECURITY_DENIED / NOT_FOUND propagate — the action is never executed
  }

  if (!auth.ok) {
    return {
      ok: false,
      actionId,
      status: auth.status,
      tier: auth.tier,
      message: auth.message,
      events: [],
    };
  }

  return executeAuthorizedAction(actionId, auth, opts);
}

/** RED — verify the mock MFA code, then authorize + execute. */
export async function verifyAction(
  actionId: string,
  code: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  let auth: AuthorizationResult;
  try {
    auth = await gateway.authorizeAction(actionId, {
      mfaCode: code,
      userId: opts?.userId,
      sessionId: opts?.sessionId,
    });
  } catch (e) {
    if (e instanceof AppError && e.code === 'CONFLICT') return conflictOutcome(actionId, e);
    throw e;
  }

  if (!auth.ok) {
    // Wrong code (⇒ `awaiting_mfa`, `mfaResult:'failed'`) or a tripped breaker (⇒ `locked`).
    return {
      ok: false,
      actionId,
      status: auth.status,
      tier: auth.tier,
      message: auth.message,
      events: [],
    };
  }

  return executeAuthorizedAction(actionId, auth, opts);
}

/** Cancel a pending action; no execution. */
export async function cancelAction(
  actionId: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  // `cancelAction` throws `AppError('NOT_FOUND'|'SECURITY_DENIED'|'CONFLICT')` for an
  // unknown/foreign/settled action; the API layer maps it to the error envelope (never swallowed).
  const action = await gateway.cancelAction(actionId, {
    userId: opts?.userId,
    sessionId: opts?.sessionId,
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

  // Nothing ran, so there is no continuation to narrate and no event to stream.
  return {
    ok: true,
    actionId,
    status: 'cancelled',
    tier: action.tier,
    message: '操作已取消。',
    events: [],
  };
}

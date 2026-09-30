/**
 * confirmation.ts — the two-phase confirmation continuation.
 * A gated (YELLOW/RED) call was blocked by `beforeToolCall` and persisted by the security gateway.
 * On a human decision: (1) authorize via `security.gateway.securityGateway.authorizeAction` /
 * `.cancelAction`;
 * (2) on success execute the ORIGINAL validated args through the Banking SDK via the
 * gateway-authorized path (`executeGatedTool` → `registry.executeDirect`) — NEVER the LLM;
 * (3) write the audit entry, inject the REAL result, `agent.continue()` to narrate the outcome.
 * `executeGatedTool` is ALSO the `runTool` the agent passes to the planner so DAG nodes gate too.
 *
 * Money therefore moves ONLY here, triggered by a human decision — never by model text.
 */
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingAction, PendingActionStatus } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
// `security/index.ts` re-exports the gateway as a *namespace* only; its types (GatewayContext,
// AuthorizationResult, ToolCallAuthorization) live in the documented sub-module, which the security
// node explicitly permits importing directly.
import type { GatewayContext } from '@/security/security-gateway';
import { security } from '@/security';
import { recordAudit } from '@/audit';
import { getSession } from '@/lib/db/repositories/session';
import { getConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { createToolRegistry, type ToolExecutionResult } from './tools';
import { resumeTurn } from './run-turn';
import type { RunTurnDeps } from './run-turn';

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
 * Tail shared by `confirmAction`/`verifyAction`: the gateway already authorized the action, so
 * execute its ORIGINAL validated args, write the audit entry, then narrate the real outcome.
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

  // `PendingAction` carries the session but not the user: resolve the owner for the SDK call.
  const session = await getSession(action.sessionId);
  const userId = session?.userId ?? getConfig().demoUserId;

  // Execute the args the gateway validated and persisted at gate time — straight through the
  // registry. Re-running `handleToolCall` would re-gate the call and mint a duplicate PendingAction.
  const registry = createToolRegistry(userId);
  const result = await registry.executeDirect(action.toolName, action.args);

  await recordAudit({
    timestamp: Date.now(),
    sessionId: action.sessionId,
    userRequest: '',
    toolName: action.toolName,
    riskLevel: action.tier,
    confirmationRequired: true,
    confirmed: true,
    mfaRequired: action.requiresMfa,
    mfaResult: auth.mfaResult,
    toolResult: result,
    status: result.ok ? 'success' : 'failed',
  });

  const { events } = await resumeTurn(
    { sessionId: action.sessionId, toolResult: result },
    opts?.deps,
  );
  emitAll(events, opts);

  return {
    ok: result.ok,
    actionId,
    status: result.ok ? 'executed' : 'failed',
    tier: action.tier,
    message: result.ok ? '操作已执行。' : (result.error ?? '操作执行失败。'),
    result,
    events,
  };
}

/**
 * YELLOW (or RED after MFA) — authorize a pending action and execute its original args.
 *
 * A non-ok authorization (RED without a code ⇒ `awaiting_mfa`, locked session ⇒ `locked`) is a
 * domain outcome, not an error: it is returned as `ok:false` with the gateway's safe message.
 */
export async function confirmAction(
  actionId: string,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  const auth = await gateway.authorizeAction(actionId);

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
  const auth = await gateway.authorizeAction(actionId, { mfaCode: code });

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
  // `cancelAction` throws `AppError('NOT_FOUND'|'CONFLICT')` for an unknown/settled action; the API
  // layer maps it to the error envelope (never swallowed here).
  const action = await gateway.cancelAction(actionId);

  await recordAudit({
    timestamp: Date.now(),
    sessionId: action.sessionId,
    userRequest: '',
    toolName: action.toolName,
    riskLevel: action.tier,
    confirmationRequired: true,
    confirmed: false,
    mfaRequired: action.requiresMfa,
    status: 'cancelled',
  });

  // Nothing ran, so there is no continuation to narrate and no event to stream.
  void opts;

  return {
    ok: true,
    actionId,
    status: 'cancelled',
    tier: action.tier,
    message: '操作已取消。',
    events: [],
  };
}

/**
 * Security Gateway — THE chokepoint of the code-enforced safety model.
 *
 * Every banking tool call proposed by the model passes through here. The gateway:
 *   1. loads today's transfer total for the user,
 *   2. consults the session circuit breaker,
 *   3. asks `permission-engine.evaluateTool` for a tier (static table + dynamic rules),
 *   4. turns the evaluation into a `SecurityDecision` (allow / require_confirmation /
 *      require_mfa / deny),
 *   5. for gated calls, persists a `PendingAction` and returns an opaque block-reason
 *      string (what the agent's `beforeToolCall` returns to the runtime), and
 *   6. later `authorizeAction`s the ORIGINAL validated args on a human confirm/MFA.
 *
 * The gateway NEVER executes the business operation — it only authorizes. Execution is
 * performed by the agent layer via the Banking SDK, using the args the gateway validated.
 * Money-moving calls are therefore always triggered by a human decision, never by model text.
 */
import type { PendingAction as PrismaPendingAction } from '@prisma/client';
import type { RiskLevel } from '../lib/contracts/risk';
import type { ToolName } from '../lib/contracts/tools';
import type {
  PendingAction,
  PendingActionStatus,
  PendingActionSummary,
  SecurityDecision,
  SecurityDecisionKind,
  SecurityEvaluation,
} from '../lib/contracts/security';
import { evaluateTool, getToolPolicy } from './permission-engine';
import type { ToolEvaluation } from './permission-engine';
import { computeDailyTransferTotal } from './risk-engine';
import { isLocked } from './circuit-breaker';
import { getChallenge, issueChallenge, verify } from './mfa';
import {
  createPendingAction as repoCreatePending,
  getPendingAction,
  updatePendingActionStatus,
} from '../lib/db/repositories/pendingAction';
import { safeParse } from '../lib/json';
import { formatCNY, parseAmount } from '../lib/money';
import { RISK_LABEL } from '../lib/constants';
import { AppError } from '../lib/errors';

/** Prefix wrapped around the serialized block reason so `parseBlockReason` is exact. */
export const BLOCK_REASON_PREFIX = '__SECURITY_BLOCK__';

/** Everything the gateway needs about a proposed tool call. */
export interface GatewayContext {
  sessionId: string;
  userId: string;
  toolName: ToolName;
  args: Record<string, unknown>;
  /** The user's original natural-language request (for audit); never used for permission. */
  userRequest: string;
}

/** Result of a human confirm/verify decision on a pending action. */
export interface AuthorizationResult {
  /** `true` iff the action is now authorized for execution by the caller. */
  ok: boolean;
  /** Resulting status: `confirmed` (authorized) | `awaiting_mfa` | `locked` | `cancelled` | `failed`. */
  status: PendingActionStatus;
  actionId: string;
  tier: RiskLevel;
  requiresMfa: boolean;
  mfaResult?: 'success' | 'failed' | 'not_required';
  /** Safe, user-facing message (never leaks the MFA code). */
  message: string;
  /** The updated pending action, when available. */
  action?: PendingAction;
}

/** What `beforeToolCall` needs in one shot. */
export interface ToolCallAuthorization {
  evaluation: SecurityEvaluation;
  decision: SecurityDecision;
  /** Present (and persisted) when the call is gated and blocked this turn. */
  action?: PendingAction;
  /** Opaque string to return as the runtime block reason; present iff `evaluation.blocked`. */
  blockReason?: string;
}

/**
 * Convenience orchestrator for the agent layer's `beforeToolCall` hook:
 * `evaluate → decide → (creates PendingAction + block reason when gated)`.
 * Returns the tool evaluation, the decision, and — when blocked — the persisted action
 * and the opaque block reason. (Optional: the fine-grained methods below may be used directly.)
 */
export interface SecurityGateway {
  /** Full evaluation: circuit breaker + permission/risk engines + daily-transfer lookup. */
  evaluate(ctx: GatewayContext): Promise<SecurityEvaluation>;
  /** Map an evaluation to a decision kind + user-facing message (pure, no I/O). */
  decide(ev: SecurityEvaluation, ctx: GatewayContext): SecurityDecision;
  /** Persist a gated call as a `PendingAction` with a `PendingActionSummary`. */
  createPendingAction(ctx: GatewayContext, ev: SecurityEvaluation): Promise<PendingAction>;
  /** Serialize the opaque block reason the runtime returns to the model. */
  serializeBlockReason(decision: SecurityDecision, action: PendingAction): string;
  /** Parse a block reason produced by `serializeBlockReason`; `null` if not a block reason. */
  parseBlockReason(reason: string): { actionId: string; decisionKind: SecurityDecisionKind } | null;
  /**
   * Authorize a pending action after a human decision.
   *  - YELLOW: authorize directly (status → `confirmed`).
   *  - RED: require + verify `mfaCode` via `mfa.verify` (status → `confirmed` on success).
   *  - locked session: refused (`status: 'locked'`); honors the circuit breaker.
   * Does NOT execute the business operation.
   */
  authorizeAction(actionId: string, opts?: { mfaCode?: string }): Promise<AuthorizationResult>;
  /** Cancel a pending action (status → `cancelled`); no execution. */
  cancelAction(actionId: string): Promise<PendingAction>;
  /** End-to-end helper used by `beforeToolCall`. */
  handleToolCall(ctx: GatewayContext): Promise<ToolCallAuthorization>;
}

/** Block-reason tag set when the session circuit breaker is tripped (all high-risk denied). */
const HIGH_RISK_BLOCKED = 'HIGH_RISK_BLOCKED';

/** Allowed decision kinds — used to validate parsed block reasons. */
const DECISION_KINDS: readonly SecurityDecisionKind[] = [
  'allow',
  'require_confirmation',
  'require_mfa',
  'deny',
];

/** Statuses from which a pending action can no longer be cancelled. */
const TERMINAL_STATUSES: readonly PendingActionStatus[] = [
  'confirmed',
  'executed',
  'cancelled',
  'failed',
];

/** Safe fallback summary used when the persisted `summaryJson` cannot be parsed. */
const FALLBACK_SUMMARY: PendingActionSummary = {
  title: '待处理操作',
  toolName: 'get_balance',
  tier: 'GREEN',
  fields: [],
  requiresMfa: false,
};

function isDecisionKind(value: unknown): value is SecurityDecisionKind {
  return typeof value === 'string' && (DECISION_KINDS as readonly string[]).includes(value);
}

/** Extract a finite amount from `args.amount` when the key is present; `undefined` otherwise. */
function resolveAmount(args: Record<string, unknown>): number | undefined {
  if (!('amount' in args)) return undefined;
  const amount = parseAmount(args.amount as string | number | null | undefined);
  return Number.isFinite(amount) ? amount : undefined;
}

/** Best-effort string read of the first present, non-empty candidate key. */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Map a persisted Prisma `PendingAction` row to the cross-module contract type. */
function toContractPendingAction(row: PrismaPendingAction): PendingAction {
  const fallbackSummary: PendingActionSummary = {
    ...FALLBACK_SUMMARY,
    toolName: row.toolName as ToolName,
    tier: row.riskLevel as RiskLevel,
    requiresMfa: row.requiresMfa,
  };
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolName: row.toolName as ToolName,
    args: safeParse<Record<string, unknown>>(row.argsJson, {}),
    tier: row.riskLevel as RiskLevel,
    requiresMfa: row.requiresMfa,
    status: row.status as PendingActionStatus,
    summary: safeParse<PendingActionSummary>(row.summaryJson, fallbackSummary),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Full evaluation: circuit breaker + permission/risk engines + daily-transfer lookup. */
async function gatewayEvaluate(ctx: GatewayContext): Promise<SecurityEvaluation> {
  const dailyTotal = await computeDailyTransferTotal(ctx.userId);
  const locked = isLocked(ctx.sessionId);

  const te = evaluateTool(ctx.toolName, ctx.args, {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    dailyTransferTotal: dailyTotal,
  });

  const blocked = locked || te.tier !== 'GREEN';

  const amount = resolveAmount(ctx.args);
  const blockReason = locked
    ? HIGH_RISK_BLOCKED
    : te.tier !== 'GREEN'
      ? te.tier === 'RED'
        ? 'require_mfa'
        : 'require_confirmation'
      : undefined;

  return {
    toolName: ctx.toolName,
    tier: te.tier,
    requiresConfirmation: te.requiresConfirmation,
    requiresMfa: te.requiresMfa,
    reasons: te.reasons,
    ...(amount !== undefined ? { amount } : {}),
    ...(ctx.toolName === 'transfer_money' ? { dailyTotal } : {}),
    blocked,
    ...(blockReason !== undefined ? { blockReason } : {}),
  };
}

/** Map an evaluation to a decision kind + user-facing message (pure, no I/O). */
function gatewayDecide(ev: SecurityEvaluation): SecurityDecision {
  if (ev.blockReason === HIGH_RISK_BLOCKED) {
    return {
      kind: 'deny',
      tier: ev.tier,
      evaluation: ev,
      message: '当前会话已触发安全熔断，高风险操作已被锁定。请前往安全中心解除限制后再试。',
    };
  }
  if (!ev.blocked) {
    return {
      kind: 'allow',
      tier: ev.tier,
      evaluation: ev,
      message: '该操作风险等级为绿色 🟢，已自动执行，无需确认。',
    };
  }
  if (ev.tier === 'RED') {
    return {
      kind: 'require_mfa',
      tier: ev.tier,
      evaluation: ev,
      message: '该操作风险等级为红色 🔴，需进行安全验证（输入 6 位短信验证码）后方可执行。',
    };
  }
  return {
    kind: 'require_confirmation',
    tier: ev.tier,
    evaluation: ev,
    message: '该操作风险等级为黄色 🟡，需你确认后方可执行。',
  };
}

/** Persist a gated call as a `PendingAction` with a `PendingActionSummary`. */
async function gatewayCreatePendingAction(
  ctx: GatewayContext,
  ev: SecurityEvaluation,
): Promise<PendingAction> {
  const summary = buildPendingActionSummary(ctx, ev);
  const status: PendingActionStatus = ev.requiresMfa ? 'awaiting_mfa' : 'pending';

  const row = await repoCreatePending({
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    toolName: ctx.toolName,
    args: ctx.args,
    tier: ev.tier,
    requiresMfa: ev.requiresMfa,
    summary,
    status,
  });

  // RED actions get a code-free challenge up-front so the UI can prompt for MFA.
  if (ev.requiresMfa) await issueChallenge(row.id);

  return toContractPendingAction(row);
}

/** Serialize the opaque block reason the runtime returns to the model. */
function serializeBlockReason(decision: SecurityDecision, action: PendingAction): string {
  return `${BLOCK_REASON_PREFIX}${JSON.stringify({ actionId: action.id, decisionKind: decision.kind })}`;
}

/** Parse a block reason produced by `serializeBlockReason`; `null` if not a block reason. */
function parseBlockReason(
  reason: string,
): { actionId: string; decisionKind: SecurityDecisionKind } | null {
  if (typeof reason !== 'string' || !reason.startsWith(BLOCK_REASON_PREFIX)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(reason.slice(BLOCK_REASON_PREFIX.length));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const actionId = record.actionId;
  const decisionKind = record.decisionKind;

  if (typeof actionId !== 'string' || actionId.length === 0) return null;
  if (!isDecisionKind(decisionKind)) return null;

  return { actionId, decisionKind };
}

/**
 * Authorize a pending action after a human decision. Honors the session circuit breaker
 * (a locked session is refused even with a correct code) and verifies MFA for RED actions.
 * The gateway NEVER executes the business operation.
 */
async function authorizeAction(
  actionId: string,
  opts?: { mfaCode?: string },
): Promise<AuthorizationResult> {
  const row = await getPendingAction(actionId);
  if (!row) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);

  const action = toContractPendingAction(row);

  // Circuit breaker is a hard gate the LLM (and even a correct code) cannot bypass.
  if (isLocked(row.sessionId)) {
    return {
      ok: false,
      status: 'locked',
      actionId,
      tier: action.tier,
      requiresMfa: row.requiresMfa,
      message: '当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。',
      action,
    };
  }

  // YELLOW — confirmation alone authorizes execution.
  if (!row.requiresMfa) {
    await updatePendingActionStatus(actionId, 'confirmed');
    return {
      ok: true,
      status: 'confirmed',
      actionId,
      tier: action.tier,
      requiresMfa: false,
      mfaResult: 'not_required',
      message: '操作已确认，正在执行。',
      action: { ...action, status: 'confirmed' },
    };
  }

  // RED without a code — prompt for verification; nothing is executed.
  if (!opts?.mfaCode) {
    return {
      ok: false,
      status: 'awaiting_mfa',
      actionId,
      tier: action.tier,
      requiresMfa: true,
      message: '请输入 6 位短信验证码以完成安全验证。',
      action,
    };
  }

  // RED with a code — ensure a challenge exists, then verify.
  if (!(await getChallenge(actionId))) await issueChallenge(actionId);

  const res = await verify(actionId, opts.mfaCode);
  if (!res.ok) {
    return {
      ok: false,
      status: 'awaiting_mfa',
      actionId,
      tier: action.tier,
      requiresMfa: true,
      mfaResult: 'failed',
      message: res.error.message,
      action,
    };
  }
  if (!res.value.ok) {
    const { attemptsLeft, locked } = res.value;
    return {
      ok: false,
      status: locked ? 'locked' : 'awaiting_mfa',
      actionId,
      tier: action.tier,
      requiresMfa: true,
      mfaResult: 'failed',
      message: locked
        ? '验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。'
        : `验证码错误，请重试。剩余尝试次数：${attemptsLeft}。`,
      action,
    };
  }

  await updatePendingActionStatus(actionId, 'confirmed');
  return {
    ok: true,
    status: 'confirmed',
    actionId,
    tier: action.tier,
    requiresMfa: true,
    mfaResult: 'success',
    message: '安全验证通过，操作已确认，正在执行。',
    action: { ...action, status: 'confirmed' },
  };
}

/** Cancel a pending action (status → `cancelled`); no execution. */
async function cancelAction(actionId: string): Promise<PendingAction> {
  const row = await getPendingAction(actionId);
  if (!row) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);

  if (TERMINAL_STATUSES.includes(row.status as PendingActionStatus)) {
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法取消。`);
  }

  const updated = await updatePendingActionStatus(actionId, 'cancelled');
  return toContractPendingAction(updated);
}

/** End-to-end helper used by `beforeToolCall`. */
async function handleToolCall(ctx: GatewayContext): Promise<ToolCallAuthorization> {
  const evaluation = await gatewayEvaluate(ctx);
  const decision = gatewayDecide(evaluation);

  // GREEN — allow the tool to execute inline.
  if (!evaluation.blocked) return { evaluation, decision };

  // Locked session — deny with an opaque reason and NO pending action.
  if (decision.kind === 'deny') {
    return {
      evaluation,
      decision,
      blockReason: `${BLOCK_REASON_PREFIX}${JSON.stringify({ decisionKind: 'deny' })}`,
    };
  }

  // Gated (YELLOW/RED) — persist the pending action and block with its id.
  const action = await gatewayCreatePendingAction(ctx, evaluation);
  return {
    evaluation,
    decision: { ...decision, pendingActionId: action.id },
    action,
    blockReason: serializeBlockReason(decision, action),
  };
}

export const securityGateway: SecurityGateway = {
  evaluate: gatewayEvaluate,
  decide: gatewayDecide,
  createPendingAction: gatewayCreatePendingAction,
  serializeBlockReason,
  parseBlockReason,
  authorizeAction,
  cancelAction,
  handleToolCall,
};

/**
 * Build the user-facing `PendingActionSummary` for a gated call (title, key/value fields
 * such as 收款人 / 金额 / 账户 / 风险等级, `requiresMfa`, `mfaHint`). Pure — formatting only.
 * Exported for reuse/testing.
 */
export function buildPendingActionSummary(
  ctx: GatewayContext,
  ev: SecurityEvaluation,
): import('../lib/contracts/security').PendingActionSummary {
  const policy = getToolPolicy(ctx.toolName);
  const amount = resolveAmount(ctx.args);
  const fields: Array<{ label: string; value: string }> = [];

  if (ctx.toolName === 'transfer_money') {
    fields.push({
      label: '收款人',
      value:
        pickString(ctx.args, ['toName', 'name', 'recipient', 'payee', 'contactName', 'to']) ??
        '（未指定）',
    });
    fields.push({ label: '金额', value: formatCNY(amount ?? 0) });
    fields.push({
      label: '账户',
      value:
        pickString(ctx.args, [
          'fromAccount',
          'account',
          'fromAccountId',
          'from',
          'toAccount',
        ]) ?? '默认活期账户',
    });
    fields.push({ label: '风险等级', value: RISK_LABEL[ev.tier] });
  } else {
    fields.push({ label: '操作', value: policy.description });
    if (amount !== undefined) fields.push({ label: '金额', value: formatCNY(amount) });
    fields.push({ label: '风险等级', value: RISK_LABEL[ev.tier] });
  }

  return {
    title: policy.description,
    toolName: ctx.toolName,
    tier: ev.tier,
    fields,
    ...(amount !== undefined ? { amount } : {}),
    requiresMfa: ev.requiresMfa,
    // MUST be code-free — never contains the demo MFA code.
    ...(ev.requiresMfa ? { mfaHint: '该操作需安全验证，请输入 6 位短信验证码。' } : {}),
  };
}

/** Re-exported for the agent layer's convenience (the raw evaluation shape). */
export type { ToolEvaluation };

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
import { computeDailyTransferTotal, reEvaluateTransferRisk } from './risk-engine';
import { isLocked } from './circuit-breaker';
import { getChallenge, issueChallenge, verify } from './mfa';
import {
  claimPendingAction,
  createPendingAction as repoCreatePending,
  getPendingAction,
  setPendingActionStatus,
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
   * Authorize a pending action after a human decision. This is the ONLY entry point that flips a
   * pending action to `confirmed` — via an atomic exactly-once claim — so a repeat confirm on an
   * already-settled action is rejected as `CONFLICT` instead of re-authorizing (which would let the
   * caller re-execute and move money twice).
   *
   * Gate order (fail-closed):
   *  1. ownership — a supplied `opts.userId` / `opts.sessionId` that does not match the row is
   *     rejected with `AppError('SECURITY_DENIED')`;
   *  2. circuit breaker — a locked session is refused (`status: 'locked'`) even with a correct code;
   *  3. execution-time re-risk — a parked `transfer_money` is re-evaluated against the FRESH day
   *     total; if it is now RED, the confirmation-only path is refused and strong verification is
   *     required (closes the stale-parked-transfer bypass);
   *  4. YELLOW → authorize directly (status → `confirmed`);
   *  5. RED (or an escalated transfer) → require + verify `mfaCode` via `mfa.verify`
   *     (status → `confirmed` on success).
   * Does NOT execute the business operation.
   */
  authorizeAction(
    actionId: string,
    opts?: { mfaCode?: string; userId?: string; sessionId?: string },
  ): Promise<AuthorizationResult>;
  /**
   * Cancel a pending action (atomic exactly-once claim → status `cancelled`); no execution.
   * Enforces the same ownership check as `authorizeAction` and rejects an already-settled action
   * (`confirmed` / `executed` / `failed` / `cancelled`) with `AppError('CONFLICT')`.
   */
  cancelAction(
    actionId: string,
    opts?: { userId?: string; sessionId?: string },
  ): Promise<PendingAction>;
  /**
   * Persist the TRUE terminal status of an action AFTER the caller has executed it (or failed), so a
   * subsequent confirm/cancel is correctly rejected as CONFLICT.
   */
  recordActionResult(actionId: string, status: 'executed' | 'failed'): Promise<void>;
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

/**
 * Shown when a parked YELLOW `transfer_money` escalates to RED at EXECUTION time (its fresh day
 * total now crosses the ¥1000 confirmation-only limit): confirmation alone is refused and strong
 * verification is required. MUST be code-free — never contains the MFA code.
 */
const TRANSFER_ESCALATED_MESSAGE =
  '该转账在确认时已超出 ¥1000 的免密确认限额（今日累计转账金额变动），需进行安全验证（输入 6 位短信验证码）后方可执行。';

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

/**
 * Code-driven intent labels per tool — the human-readable "intent" persisted on a gated
 * PendingAction for the audit trail. NEVER derived from model output: the label is a fixed
 * function of the tool name, so the model cannot influence it (LLM-immutable, like the tiers).
 * Typed Record<ToolName, string> so a newly added tool without a label is a compile error.
 */
export const TOOL_INTENT: Record<ToolName, string> = {
  // 🟢 GREEN
  get_balance: '查询余额',
  get_transactions: '查询交易流水',
  search_contact: '查询联系人',
  analyze_spending: '消费分析',
  detect_anomaly: '异常交易检测',
  get_cards: '查询银行卡',
  list_subscriptions: '查询订阅',
  list_investments: '查询理财产品',
  compare_investments: '理财产品对比',
  get_investment_holdings: '查询理财持仓',
  get_dashboard_summary: '资产概览',
  list_scheduled_tasks: '查询定时任务',
  reserve_budget: '预算预留',
  // 🟡 YELLOW
  transfer_money: '转账',
  set_card_limit: '调整信用卡额度',
  cancel_subscription: '取消订阅',
  freeze_card: '冻结银行卡',
  apply_virtual_card: '申请虚拟卡',
  set_subscription_reminder: '设置订阅提醒',
  create_scheduled_task: '创建定时任务',
  // 🔴 RED
  subscribe_investment: '理财产品申购',
  redeem_investment: '理财产品赎回',
  report_lost_card: '挂失银行卡',
  unfreeze_card: '解冻银行卡',
  change_password: '修改密码',
  // ⚪ META
  submit_plan: '规划任务',
};

/**
 * Derive the (non-empty) intent label for a tool. Code-driven — a pure function of the tool name.
 * Falls back to the raw tool name so `intent` is ALWAYS populated for a gated action even if the
 * map were ever incomplete at runtime (the Record<ToolName, string> typing keeps that a
 * compile-time concern).
 */
export function deriveIntent(toolName: ToolName): string {
  const label = (TOOL_INTENT as Partial<Record<ToolName, string>>)[toolName];
  return typeof label === 'string' && label.trim() !== '' ? label : toolName;
}

/** Map a persisted Prisma row to the cross-module contract PendingAction type. */
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
    userRequest: row.userRequest ?? undefined,
    intent: row.intent ?? undefined,
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
    // Audit trail: the user's original request + a code-derived intent label (never model text).
    userRequest: ctx.userRequest,
    intent: deriveIntent(ctx.toolName),
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
 * EXECUTION-TIME re-risk for a parked action: TRUE iff the row is a `transfer_money` whose FRESH
 * day-total risk is now RED. Non-transfers, and transfers whose persisted amount cannot be parsed,
 * are never escalated. The fresh day total comes from `risk.reEvaluateTransferRisk` (demo clock by
 * default) so the check is deterministic and reads the transaction repository, never model text.
 */
async function isTransferEscalated(row: PrismaPendingAction): Promise<boolean> {
  if (row.toolName !== 'transfer_money') return false;
  const amount = resolveAmount(safeParse<Record<string, unknown>>(row.argsJson, {}));
  if (amount === undefined) return false;
  const fresh = await reEvaluateTransferRisk(row.userId, amount);
  return fresh.tier === 'RED';
}

/**
 * Authorize a pending action after a human decision. Honors the session circuit breaker
 * (a locked session is refused even with a correct code), re-checks ownership when the caller
 * supplies it, re-risks a parked transfer against the FRESH day total, claims the action
 * exactly-once, and verifies MFA for RED actions. The gateway NEVER executes the business operation.
 */
async function authorizeAction(
  actionId: string,
  opts?: { mfaCode?: string; userId?: string; sessionId?: string },
): Promise<AuthorizationResult> {
  const row = await getPendingAction(actionId);
  if (!row) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);

  // Ownership: a confirm from a different user/session is rejected — the caller does not get to
  // decide another session's action. (When not supplied, the id itself is the capability.)
  if (opts?.userId !== undefined && opts.userId !== row.userId) {
    throw new AppError('SECURITY_DENIED', `无权操作该待处理操作: ${actionId}`);
  }
  if (opts?.sessionId !== undefined && opts.sessionId !== row.sessionId) {
    throw new AppError('SECURITY_DENIED', `无权操作该待处理操作: ${actionId}`);
  }

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

  // Anti stale-parked-transfer bypass: re-derive today's transfer total FRESH. Several YELLOW
  // transfers parked at different moments (each validated against the same stale total) must not
  // collectively slip past the ¥1000 limit — the fresh risk escalates them to RED at execution.
  const freshRed = await isTransferEscalated(row);

  // The row's `requiresMfa` column stays FALSE for an escalated YELLOW transfer (it was YELLOW at
  // park time). Route the whole flow on the EFFECTIVE requirement so an escalated transfer can also
  // be COMPLETED with a code (rather than looping on the escalation branch or confirming unverified).
  const effectiveRequiresMfa = row.requiresMfa || freshRed;

  // ESCALATION: a confirmation-only transfer whose fresh risk is now RED cannot be confirmed with
  // confirmation alone. Prompt for strong verification (no state change) unless a code is already
  // supplied — in which case we fall through to the RED verify path below.
  if (freshRed && !row.requiresMfa && !opts?.mfaCode) {
    if (!(await getChallenge(actionId))) await issueChallenge(actionId);
    return {
      ok: false,
      status: 'awaiting_mfa',
      actionId,
      tier: action.tier,
      requiresMfa: true,
      message: TRANSFER_ESCALATED_MESSAGE,
      action,
    };
  }

  // YELLOW (no strong verification needed) — an atomic exactly-once claim authorizes execution.
  if (!effectiveRequiresMfa) {
    const claimed = await claimPendingAction({
      actionId,
      from: ['pending'],
      to: 'confirmed',
      userId: row.userId,
      sessionId: row.sessionId,
    });
    if (!claimed) {
      throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法重复确认。`);
    }
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

  // RED (or escalated) without a code — prompt for verification; nothing is executed.
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

  // Verified — claim exactly-once from a still-unsettled state (`awaiting_mfa` for a RED action,
  // `pending` for an escalated YELLOW transfer) so a concurrent/duplicate confirm is rejected.
  const claimed = await claimPendingAction({
    actionId,
    from: ['awaiting_mfa', 'pending'],
    to: 'confirmed',
    userId: row.userId,
    sessionId: row.sessionId,
  });
  if (!claimed) {
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法重复确认。`);
  }
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

/**
 * Cancel a pending action (atomic exactly-once claim → `cancelled`); no execution.
 * Enforces ownership and rejects an already-settled action with `CONFLICT`.
 */
async function cancelAction(
  actionId: string,
  opts?: { userId?: string; sessionId?: string },
): Promise<PendingAction> {
  const row = await getPendingAction(actionId);
  if (!row) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);

  if (opts?.userId !== undefined && opts.userId !== row.userId) {
    throw new AppError('SECURITY_DENIED', `无权操作该待处理操作: ${actionId}`);
  }
  if (opts?.sessionId !== undefined && opts.sessionId !== row.sessionId) {
    throw new AppError('SECURITY_DENIED', `无权操作该待处理操作: ${actionId}`);
  }

  // Atomic claim: only an unsettled action can be cancelled. A settled one (`confirmed` / `executed`
  // / `failed` / `cancelled`) transitions 0 rows → rejected, so "cancel after confirm/execute" fails.
  const claimed = await claimPendingAction({
    actionId,
    from: ['pending', 'awaiting_mfa'],
    to: 'cancelled',
    userId: row.userId,
    sessionId: row.sessionId,
  });
  if (!claimed) {
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法取消。`);
  }

  const updated = await getPendingAction(actionId);
  return toContractPendingAction(updated ?? { ...row, status: 'cancelled' });
}

/**
 * Persist the TRUE terminal status of an action AFTER the caller has executed it (or failed), so a
 * subsequent confirm/cancel is correctly rejected as CONFLICT. Unconditional setter — the
 * exactly-once claim happened at confirm time; this records the real outcome.
 */
async function recordActionResult(actionId: string, status: 'executed' | 'failed'): Promise<void> {
  await setPendingActionStatus(actionId, status);
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
  recordActionResult,
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

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
import type { PendingAction as PrismaPendingAction } from '@/lib/db/prisma';
import type { RiskLevel } from '../lib/contracts/risk';
import type { ToolName } from '../lib/contracts/tools';
import { isManualCardCommand } from '../lib/contracts/card-management';
import { catalogEntry } from '../lib/contracts/tool-catalog';
import type {
  PendingAction,
  PendingActionStatus,
  PendingActionSummary,
  SecurityDecision,
  SecurityDecisionKind,
  SecurityEvaluation,
  SecurityFailure,
  SecurityFailureReason,
} from '../lib/contracts/security';
import { evaluateTool, getToolPolicy } from './permission-engine';
import type { ToolEvaluation } from './permission-engine';
import {
  computeDailyTransferTotal,
  computeEffectiveTransferTotalWith,
  evaluateTransferRisk,
} from './risk-engine';
import { isLocked } from './circuit-breaker';
import { attemptState, challengeInvalidation, getChallenge, issueChallenge, verify } from './mfa';
import {
  assertActionMayStart,
  claimPendingAction,
  createPendingAction as repoCreatePending,
  getPendingAction,
  getMfaChallenge,
  listPendingActionsByTask,
} from '../lib/db/repositories/pendingAction';
import { getSession } from '../lib/db/repositories/session';
import {
  buildRecipientClarifyMessage,
  canonicalizeTransferArgs,
  maskPhone,
  resolveAccountLabel,
  resolveTransferRecipient,
} from './recipient-resolution';
import { prisma } from '../lib/db/client';
import { recordSecurityEvent } from '../audit';
import { safeParse } from '../lib/json';
import { formatCNY, moneyToCents, normalizeTransferAmount, centsToMoney, type MoneyAmount } from '../lib/money';
import { valuationToMinor, compareDecimal, nonNegativeDecimal, type DecimalAmount } from '../lib/decimal';
import {
  NET_VALUE_DECIMALS,
  REDEMPTION_FEE_RULE,
  SHARE_DECIMALS,
  floorToShares,
  marketValueFromShares,
  settlementFromShares,
  sharesFromAmount,
} from '../banking-sdk/net-value';
import type { RedeemMode } from '../banking-sdk/types';
import { canonicalCommandArgs } from '../lib/contracts/command';
import { recordAuthorizationDecision } from './authorization-record';
import { DAILY_TRANSFER_LIMIT, MFA_MAX_ATTEMPTS, RISK_LABEL } from '../lib/constants';
import { AppError } from '../lib/errors';
import { requestDigest } from '../lib/ledger';
import { realNow } from '../lib/clock';
import mfaMessages from './messages/mfa.zh-CN.json';
import { resolveBankingArgs } from '../lib/banking-selectors';
import {
  buildCardClarifyMessage,
  canonicalizeCardArgs,
  cardTypeLabel,
  resolveCardTarget,
} from './card-resolution';
import { withActionPolicy } from '../lib/action-summary';
import { scheduledTime } from '../lib/scheduled-time';
import { redactRequest, redactSecrets } from '../lib/sensitive';
import { businessCalendarParts, formatDateTime } from '../lib/date';
import type { ErrorCode } from '../lib/errors';

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
  /**
   * Owning plan (`AgentTask.id`) when the call originates from a DAG plan node; absent for a
   * top-level tool call. Persisted with the action so a plan-level cancel can revoke it later.
   */
  taskId?: string;
  /** Owning node (`AgentTaskNode.nodeId`) alongside `taskId`; absent for a top-level tool call. */
  nodeId?: string;
  invocationId?: string;
  authorizationDecisionId?: string;
  /** Trusted runtime fence, supplied by the host rather than JSON or model arguments. */
  runtimeFence?: import('@/banking-sdk').ExecutionFenceCheck;
}

/** Result of a human confirm/verify decision on a pending action. */
export interface AuthorizationResult {
  /** `true` iff the action is now authorized for execution by the caller. */
  ok: boolean;
  /** Resulting status: `confirmed` (authorized) | `awaiting_mfa` | `locked` | `cancelled` | `failed`. */
  status: PendingActionStatus;
  actionId: string;
  /** The EFFECTIVE tier on BOTH success and failure (e.g. an escalated transfer reports `RED`). */
  tier: RiskLevel;
  /** The EFFECTIVE strong-verification requirement (recomputed at execution time, not the parked value). */
  requiresMfa: boolean;
  mfaResult?: 'success' | 'failed' | 'not_required';
  /** Typed failure code (present iff `ok === false` for a domain refusal). */
  code?: ErrorCode;
  /** Structured refusal facts (code + reason + attempts); never rendered as raw diagnostic text. */
  failure?: SecurityFailure;
  /** Safe, user-facing message (never leaks the MFA code). */
  message: string;
  /** The updated pending action, when available. */
  action?: PendingAction;
}

/** Required caller identity for a human decision on a pending action (ownership is enforced). */
export interface ActionOwnership {
  /** The caller's user id — MUST be non-empty and match the action's owner. */
  userId: string;
  /** The caller's session id — MUST be non-empty and match the action's session. */
  sessionId: string;
}

/** Ownership is required; strong-verification decisions additionally supply the factor code. */
export type AuthorizeOptions = ActionOwnership & { mfaCode?: string };

/** `cancelAction` options: REQUIRED ownership only. */
export type CancelOptions = ActionOwnership;

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
 * The TYPED contents of a serialized block reason. ctionId is optional: a deny refusal (a
 * tripped circuit breaker, a cancelled owning plan) has no pending action at all. ailure carries
 * the structured refusal facts so no caller ever has to parse text.
 */
interface ParsedBlockReason {
  actionId?: string;
  decisionKind: SecurityDecisionKind;
  failure?: SecurityFailure;
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
  parseBlockReason(reason: string): ParsedBlockReason | null;
  /**
   * Authorize a pending action after a human decision. Ownership is REQUIRED (a missing/mismatching
   * `userId` / `sessionId` is refused with `AppError('SECURITY_DENIED')`). This is the ONLY entry
   * point that flips a pending action to `confirmed` — via an atomic exactly-once claim — so a repeat
   * confirm on an already-settled action is rejected as `CONFLICT` instead of re-authorizing (which
   * would let the caller re-execute and move money twice).
   *
   * Gate order (fail-closed):
   *  1. ownership — the caller identity MUST be present and match the row (and the row's owning
   *     session, when it exists);
   *  2. circuit breaker — a locked session is refused (`status: 'locked'`) even with a correct code;
   *  3. for `transfer_money` (dynamic tier) — ONE transaction whose FIRST statement is the CAS claim
   *     (a write ⇒ serializes concurrent confirms), followed by the EFFECTIVE day total (today's
   *     executed transfer debits PLUS in-flight PendingActions, excluding this one) and a fresh
   *     `evaluateTransferRisk`; a now-RED transfer is escalated to `awaiting_mfa`/RED/MFA inside the
   *     tx and refused the confirmation-only path;
   *  4. YELLOW → authorize directly (status → `confirmed`);
   *  5. RED (or an escalated transfer) → require + verify `mfaCode` via `mfa.verify`
   *     (status → `confirmed` on success).
   * `tier` / `requiresMfa` on the result are ALWAYS the EFFECTIVE values. Does NOT execute the
   * business operation.
   */
  authorizeAction(actionId: string, opts: AuthorizeOptions): Promise<AuthorizationResult>;
  /**
   * Cancel a pending action (atomic exactly-once claim → status `cancelled`); no execution.
   * Enforces the SAME required ownership check as `authorizeAction` and rejects an already-settled
   * action (`confirmed` / `executed` / `failed` / `cancelled`) with `AppError('CONFLICT')`.
   */
  cancelAction(actionId: string, opts: CancelOptions): Promise<PendingAction>;
  /**
   * Persist the TRUE terminal status of an action AFTER the caller has executed it (or failed), so a
   * subsequent confirm/cancel is correctly rejected as CONFLICT.
   */
  recordActionResult(actionId: string, status: 'executed' | 'failed'): Promise<void>;
  /** End-to-end helper used by `beforeToolCall`. Requires a non-empty caller identity in `ctx`. */
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
/** Allowed failure reasons — used to validate a PARSED block reason (unknown ⇒ dropped). */
const FAILURE_REASONS: readonly SecurityFailureReason[] = [
  'mfa_code_invalid',
  'mfa_attempts_exhausted',
  'mfa_session_locked',
  'circuit_open',
  'manual_review_hold',
  'denied',
];

/**
 * Shown when a parked YELLOW `transfer_money` escalates to RED at EXECUTION time (its fresh
 * effective day total now crosses the ¥1000 confirmation-only limit): confirmation alone is refused
 * and strong verification is required. MUST be code-free — never contains the MFA code.
 */
const TRANSFER_ESCALATED_MESSAGE =
  '该转账在确认时已超出 ¥1000 的免密确认限额（今日累计转账金额变动），需进行安全验证（输入 6 位短信验证码）后方可执行。';

/** Prompt shown when a RED (or escalated) action still needs a strong-verification code. */
const MFA_CODE_PROMPT = '请输入 6 位短信验证码以完成安全验证。';

/**
 * Shown when a confirm/verify targets an action whose OWNING PLAN is `'cancelled'`: the claim is
 * REVERSED to `cancelled` inside the authorizing transaction, so no side effect runs and no ledger
 * row is written. MUST be code-free.
 */
const PLAN_CANCELLED_MESSAGE = '操作所属的任务计划已取消，该操作不会执行。';

/** Code-free confirmation messages. */
const CONFIRM_OK_MESSAGE = '操作已确认，正在执行。';
const VERIFY_OK_MESSAGE = '安全验证通过，操作已确认，正在执行。';

/**
 * Every circuit-breaker refusal (account-level lock, tripped by ANY operation of the account) shares
 * this one sentence, so the copy never pretends a per-operation attempt limit was reached.
 */
const CIRCUIT_LOCK_MESSAGE = '当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。';

/** Shown ONLY when THIS operation's own attempt record is exhausted. */
const ATTEMPTS_EXHAUSTED_MESSAGE = '验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。';

/**
 * Verbatim public copy (`lib/tool-feedback.ts#PUBLIC_BUSINESS_ERRORS` → `chat.error.verificationConsumed`)
 * for a verification submitted against an ALREADY-CONSUMED challenge.
 */
const CONSUMED_CHALLENGE_MESSAGE = 'This verification challenge has already been consumed.';

/**
 * Chinese labels for a PERSISTED `PendingAction` status. Those statuses are machine values
 * (`locked`, `awaiting_mfa`, `cancelled`, …) and MUST NOT be rendered as copy: a refusal that has to
 * name the CURRENT state names it through this map. An unknown/future value degrades to a neutral
 * phrase instead of leaking the raw token.
 */
const PENDING_ACTION_STATUS_LABEL: Record<PendingActionStatus, string> = {
  pending: '待确认',
  awaiting_mfa: '待安全验证',
  confirmed: '已确认',
  executed: '已执行',
  failed: '已失败',
  cancelled: '已取消',
  locked: '已锁定',
  needs_reconciliation: '待人工核对',
};

/** User-facing label for a persisted action status (never the raw internal status token). */
function statusLabel(status: string): string {
  return (PENDING_ACTION_STATUS_LABEL as Record<string, string>)[status] ?? '状态已变更';
}

/**
 * Statuses a LATE result notification may overwrite. `locked` is deliberately ABSENT: the
 * circuit-breaker lock is TERMINAL, so a result notification arriving after it (a stale
 * continuation, a retried settlement) must never relabel that row `executed` / `failed` and thereby
 * fabricate execution evidence for an operation that was never authorized to run. The authoritative
 * evidence of an execution is the settlement transaction (status + result + audit), never this
 * notification.
 */
const RESULT_RECORDABLE_STATUSES: PendingActionStatus[] = [
  'pending',
  'awaiting_mfa',
  'confirmed',
  'executed',
  'failed',
  'cancelled',
  'needs_reconciliation',
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
function resolveAmount(args: Record<string, unknown>): MoneyAmount | undefined {
  if (!('amount' in args)) return undefined;
  try { return centsToMoney(moneyToCents(args.amount)); } catch { return undefined; }
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
 * Enforce the caller identity of a `beforeToolCall` call. There is no persisted action yet, so this
 * only checks presence/non-emptiness — an empty/missing `userId`/`sessionId` is refused with
 * `SECURITY_DENIED` rather than silently falling back to a demo user.
 */
function assertCallerIdentity(actor: { userId: string; sessionId: string }): void {
  if (typeof actor.userId !== 'string' || actor.userId.trim() === '') {
    throw new AppError('SECURITY_DENIED', '缺少有效的调用者身份（userId），已拒绝执行。');
  }
  if (typeof actor.sessionId !== 'string' || actor.sessionId.trim() === '') {
    throw new AppError('SECURITY_DENIED', '缺少有效的调用者身份（sessionId），已拒绝执行。');
  }
}

/**
 * Enforce ownership of a PERSISTED pending action. Rejects with `AppError('SECURITY_DENIED')` when:
 * the caller's `userId`/`sessionId` is missing/empty; OR it does not match the row; OR (when the
 * owning session row exists) the session's user disagrees with the action's user. There is
 * deliberately NO demo-user fallback — the action id alone is no longer a capability.
 */
async function assertOwnership(
  row: Pick<PrismaPendingAction, 'id' | 'userId' | 'sessionId'>,
  opts: ActionOwnership,
): Promise<void> {
  const userId = opts?.userId;
  const sessionId = opts?.sessionId;
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError('SECURITY_DENIED', `缺少有效的 userId，无权操作待处理操作: ${row.id}`);
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new AppError('SECURITY_DENIED', `缺少有效的 sessionId，无权操作待处理操作: ${row.id}`);
  }
  if (userId !== row.userId || sessionId !== row.sessionId) {
    throw new AppError('SECURITY_DENIED', `无权操作该待处理操作: ${row.id}`);
  }
  // Defence-in-depth: when the owning session row exists it must agree with the action's owner.
  const session = await getSession(row.sessionId);
  if (session !== null && session.userId !== row.userId) {
    throw new AppError('SECURITY_DENIED', `待处理操作的所有者与其会话不一致: ${row.id}`);
  }
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
  search_conversation_history: 'Search conversation history',
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
  set_card_limit: '调整卡片分类消费限额',
  cancel_subscription: '取消订阅',
  set_subscription_reminder: '设置订阅提醒',
  create_scheduled_task: '创建定时任务',
  // 🔴 RED
  freeze_card: '冻结银行卡',
  subscribe_investment: '理财产品申购',
  redeem_investment: '理财产品赎回',
  apply_virtual_card: '申请虚拟卡',
  consume_virtual_card: '虚拟卡消费',
  report_lost_card: '挂失银行卡',
  unfreeze_card: '解冻银行卡',
  replace_card: '补办银行卡',
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
    summary: withActionPolicy(safeParse<PendingActionSummary>(row.summaryJson, fallbackSummary), {
      actionId: row.id, tier: row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa,
    }),
    userRequest: row.userRequest ?? undefined,
    intent: row.intent ?? undefined,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Full evaluation: circuit breaker + permission/risk engines + daily-transfer lookup. */
async function gatewayEvaluate(ctx: GatewayContext): Promise<SecurityEvaluation> {
  const dailyTotal = await computeDailyTransferTotal(ctx.userId);
  const locked = await isLocked(ctx.sessionId);

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

/**
 * Key-order-insensitive deep equality for JSON-ish tool args (objects / arrays / primitives).
 * Pure, no I/O. Used to decide whether a re-parked plan node is the SAME operation.
 */
export function sameArgs(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameArgs(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && sameArgs(left[key], right[key]),
  );
}

/**
 * DEFENSE-IN-DEPTH dedupe for the park path: find an EXISTING non-settled (`pending` /
 * `awaiting_mfa`) action of the same plan node that represents the SAME operation — same tool, same
 * args, same effective tier / `requiresMfa` (the tier check guards against a drifted day total
 * under-gating the reuse). Returns `null` (⇒ create a fresh action) when the call is not plan-scoped
 * or no such row exists. A node-execution claim elsewhere remains the PRIMARY guard; this is a
 * cheap second layer so a re-run of the same node cannot mint duplicate actions.
 */
async function findReusableAction(
  ctx: GatewayContext,
  ev: SecurityEvaluation,
): Promise<PrismaPendingAction | null> {
  const { taskId, nodeId } = ctx;
  if (!taskId || !nodeId) return null;

  const rows = await listPendingActionsByTask(taskId, { statuses: ['pending', 'awaiting_mfa'] });
  return (
    rows.find(
      (row) =>
        row.nodeId === nodeId &&
        row.toolName === ctx.toolName &&
        row.riskLevel === ev.tier &&
        row.requiresMfa === ev.requiresMfa &&
        sameArgs(requestArgs(ctx.toolName, safeParse<Record<string, unknown>>(row.argsJson, {})), requestArgs(ctx.toolName, ctx.args)),
    ) ?? null
  );
}

/** The clarification the contract demands when a redemption states no口径 — there is no default. */
const REDEEM_CLARIFY_MESSAGE = '赎回需要明确口径：请确认按「份额」还是按「金额」赎回';

/** 口径 labels for the confirmation card. */
const REDEMPTION_MODE_LABEL: Record<RedeemMode, string> = {
  SHARES: '按份额赎回',
  AMOUNT: '按金额赎回',
  ALL: '全部赎回',
};

/** Server-minted snapshot fields: they belong to the original decision, not to the request identity. */
const REDEMPTION_SNAPSHOT_FIELDS: ReadonlySet<string> = new Set([
  'expectedPositionVersion',
  'expectedShares',
  'expectedNetValue',
  'expectedNetValueDate',
  'expectedSettlementAmount',
]);

/**
 * The redemption口径 a request states (`docs/cn/investments.md`). A missing/unknown口径 — or the
 * retired principal-based `redeemAmount` — is a CLARIFICATION, never a guess: silently defaulting is
 * exactly what the contract forbids.
 */
function redemptionMode(args: Record<string, unknown>): RedeemMode {
  if (args.redeemAmount !== undefined) {
    throw new AppError('VALIDATION', REDEEM_CLARIFY_MESSAGE, {
      redeemAmount: args.redeemAmount,
      reason: 'PRINCIPAL_MODE_RETIRED',
    });
  }
  const mode = args.mode;
  if (mode !== 'SHARES' && mode !== 'AMOUNT' && mode !== 'ALL') {
    throw new AppError('VALIDATION', REDEEM_CLARIFY_MESSAGE, { mode: typeof mode === 'string' ? mode : null });
  }
  return mode;
}

/** Reject a mixed口径: each mode owns exactly one input field and `ALL` owns none. */
function assertRedeemForm(mode: RedeemMode, args: Record<string, unknown>): void {
  const mixed = mode === 'SHARES'
    ? args.amount !== undefined
    : mode === 'AMOUNT'
      ? args.shares !== undefined
      : args.shares !== undefined || args.amount !== undefined;
  if (mixed) {
    throw new AppError('VALIDATION', '赎回口径不可混用：按份额与按金额只能二选一，全额赎回不接受份额或金额', {
      mode,
      shares: args.shares ?? null,
      amount: args.amount ?? null,
    });
  }
}

/** A requested share count: positive decimal text, at most 6 fractional digits, within the holding. */
function requestedRedemptionShares(raw: unknown, heldShares: DecimalAmount): DecimalAmount {
  if (raw === undefined) throw new AppError('VALIDATION', '按份额赎回需要给出赎回份额');
  if (typeof raw !== 'string') throw new AppError('VALIDATION', '赎回份额必须以十进制文本给出', { shares: raw });
  const shares = nonNegativeDecimal(raw);
  if (compareDecimal(shares, '0') <= 0) throw new AppError('VALIDATION', '赎回份额必须大于零', { shares });
  if (floorToShares(shares) !== shares) {
    throw new AppError('VALIDATION', `赎回份额最多允许 ${SHARE_DECIMALS} 位小数`, { shares });
  }
  if (compareDecimal(shares, heldShares) > 0) {
    throw new AppError('VALIDATION', '赎回份额不能超过持有份额', { redeemedShares: shares, totalShares: heldShares });
  }
  return shares;
}

/** A requested amount口径: positive CNY, never above the position's current market value. */
function requestedRedemptionAmount(raw: unknown, heldShares: DecimalAmount, netValue: DecimalAmount): MoneyAmount {
  if (raw === undefined) throw new AppError('VALIDATION', '按金额赎回需要给出赎回金额');
  if (typeof raw !== 'string') throw new AppError('VALIDATION', '赎回金额必须以十进制文本给出', { amount: raw });
  const requestedMinor = moneyToCents(raw);
  if (requestedMinor <= 0n) throw new AppError('VALIDATION', '赎回金额必须大于零', { amount: centsToMoney(requestedMinor) });
  // The SDK rejects an amount above the market value instead of silently widening it to a full
  // redemption; the quote applies the SAME bound with the SAME market value helper.
  const marketValueMinor = valuationToMinor(marketValueFromShares(heldShares, netValue));
  if (requestedMinor > marketValueMinor) {
    throw new AppError('VALIDATION', '赎回金额超过持仓市值，请改用全额赎回或按份额赎回', {
      amount: centsToMoney(requestedMinor),
      marketValue: centsToMoney(marketValueMinor),
    });
  }
  return centsToMoney(requestedMinor);
}

/** The product's published net value; absent/corrupt/non-positive counts as "not published". */
function publishedNetValue(product: { latestNetValuePerUnit: string | null }): DecimalAmount | undefined {
  const raw = product.latestNetValuePerUnit;
  if (raw === null) return undefined;
  try {
    const netValue = nonNegativeDecimal(raw);
    return compareDecimal(netValue, '0') > 0 ? netValue : undefined;
  } catch {
    return undefined;
  }
}

/** The holding's recorded shares; absent/corrupt/non-positive counts as "not recorded" (never guessed). */
function recordedHoldingShares(raw: string | null): DecimalAmount | undefined {
  if (raw === null) return undefined;
  try {
    const shares = nonNegativeDecimal(raw);
    return compareDecimal(shares, '0') > 0 ? shares : undefined;
  } catch {
    return undefined;
  }
}

/** The 「净值 + 份额」 quote the confirmation snapshot persists — computed only by SDK helpers. */
interface RedemptionQuote {
  positionVersion: number;
  mode: RedeemMode;
  /** Shares this redemption actually redeems under the stated口径. */
  shares: DecimalAmount;
  /** Net value per unit they are priced at. */
  netValue: DecimalAmount;
  /** Business date (epoch ms) of `netValue`; absent when the product published none. */
  netValueDate?: number;
  /** Amount credited, HALF_UP to cents exactly once (the SDK's own settlement helper). */
  settlementAmount: MoneyAmount;
  /** Fee charged (always `0.00` under the simulated rule). */
  feeAmount: MoneyAmount;
  /** `SIMULATED_NONE` — the fee口径 the SDK books, quoted so the card states the same rule. */
  feeRule: string;
}

/**
 * Mint the server's redemption quote from the OWNED holding and its product.
 *
 * The arithmetic is NEVER re-implemented in the security layer: `sharesFromAmount` and
 * `settlementFromShares` are the very helpers `banking-sdk/investment.ts` settles with, so the
 * approved quote and the settled amount cannot diverge. A holding with no recorded shares or a
 * product with no published net value refuses to quote at all — no fabricated settlement is ever
 * shown, and the SDK would refuse the same redemption at execution.
 */
function quoteRedemption(
  holding: {
    id: string;
    positionVersion: number;
    productId: string;
    shares: string | null;
    product: { latestNetValuePerUnit: string | null; latestNetValueDate: Date | null };
  },
  args: Record<string, unknown>,
): RedemptionQuote {
  const mode = redemptionMode(args);
  assertRedeemForm(mode, args);

  const netValue = publishedNetValue(holding.product);
  if (netValue === undefined) {
    throw new AppError('VALIDATION', '该产品未发布净值，暂不可赎回', { productId: holding.productId });
  }
  const heldShares = recordedHoldingShares(holding.shares);
  if (heldShares === undefined) {
    throw new AppError('CONFLICT', '该持仓尚未记录份额，暂不可赎回', { holdingId: holding.id });
  }

  const shares = mode === 'ALL'
    ? heldShares
    : mode === 'SHARES'
      ? requestedRedemptionShares(args.shares, heldShares)
      : sharesFromAmount(requestedRedemptionAmount(args.amount, heldShares, netValue), netValue);
  if (compareDecimal(shares, heldShares) > 0) {
    throw new AppError('VALIDATION', '赎回份额不能超过持有份额', { redeemedShares: shares, totalShares: heldShares });
  }

  const netValueDate = holding.product.latestNetValueDate?.getTime();
  return {
    mode,
    shares,
    positionVersion: holding.positionVersion,
    netValue,
    ...(netValueDate !== undefined ? { netValueDate } : {}),
    settlementAmount: settlementFromShares(shares, netValue),
    feeAmount: '0.00',
    feeRule: REDEMPTION_FEE_RULE,
  };
}

/** The server snapshot merged into the parked args (and therefore into the command digest). */
function redemptionSnapshot(quote: RedemptionQuote): Record<string, unknown> {
  return {
    expectedPositionVersion: quote.positionVersion,
    expectedShares: quote.shares,
    expectedNetValue: quote.netValue,
    ...(quote.netValueDate !== undefined ? { expectedNetValueDate: quote.netValueDate } : {}),
    expectedSettlementAmount: quote.settlementAmount,
  };
}

/** Business date text (UTC+08:00) of a net value date — a date, not an instant. */
function businessDateText(ts: number): string {
  const parts = businessCalendarParts(ts);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Net values are quoted to 4 fractional digits; canonical decimal text drops trailing zeros. */
function formatNetValue(netValue: DecimalAmount): string {
  const [integer, fraction = ''] = netValue.split('.');
  return `${integer}.${fraction.padEnd(NET_VALUE_DECIMALS, '0')}`;
}

/**
 * The redemption snapshot belongs to the original server decision, not the model's request identity:
 * every server-minted `expected*` field is excluded so a re-park of the same node matches its action.
 */
function requestArgs(tool: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== 'redeem_investment') return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => !REDEMPTION_SNAPSHOT_FIELDS.has(key)));
}

/**
 * Outcome of the internal park path. `created` ⇒ a `PendingAction` was persisted (or reused);
 * `plan_cancelled` ⇒ refused because the owning `AgentTask` is already `'cancelled'`; `clarify` ⇒ a
 * transfer recipient — or a card target — could not be resolved unambiguously, so NOTHING was persisted
 * (no `PendingAction`,
 * no MFA challenge) and the caller must ask the user to clarify.
 */
type CreatePendingActionResult =
  | { kind: 'created'; action: PendingAction }
  | { kind: 'plan_cancelled' }
  | { kind: 'clarify'; message: string };

/** Tools whose target card may be named by selectors (`cardType`/`cardTail`/`cardNumber`) instead of an id. */
const CARD_TARGET_TOOLS: readonly string[] = [
  'set_card_limit',
  'freeze_card',
  'unfreeze_card',
  'consume_virtual_card',
  'report_lost_card',
  'replace_card',
];

/**
 * Persist a gated call as a `PendingAction` with a `PendingActionSummary`.
 *
 * For `transfer_money` the recipient is resolved SERVER-SIDE at park time (mirroring the SDK), so the
 * confirmation card names the SAME contact the SDK will resolve at execution: an unresolvable/ambiguous
 * recipient returns `{ kind: 'clarify' }` without persisting anything, and a resolved one canonicalizes
 * the args to the resolved `contactId` BEFORE the dedupe (so a re-park compares canonical args and the
 * args the SDK later executes are the ones validated here).
 *
 * Every CARD-target tool gets the same park-time treatment through `security/card-resolution.ts`: the
 * user's words (`cardType`/`cardTail`/`cardNumber`, or an exact `cardId`) become ONE owned card, an
 * unresolvable/ambiguous/invalid selector is a `{ kind: 'clarify' }` request, and a resolved target is
 * canonicalized to the resolved `cardId` BEFORE `resolveBankingArgs`, so the card shown on the
 * confirmation summary is exactly the card the SDK operates on.
 *
 * Returns `{ kind: 'plan_cancelled' }` when the call is plan-scoped (`ctx.taskId`) and the owning
 * `AgentTask` is already `'cancelled'`. The plan-status read and the row insert run in ONE transaction,
 * so a plan cancelled concurrently cannot slip a fresh action in between the read and the write
 * (create-time half of the plan-cancel → authorize race guard). `handleToolCall` turns the refusal into
 * a clean `deny`; the public `SecurityGateway.createPendingAction` wrapper maps it to a `CONFLICT`.
 */
async function gatewayCreatePendingAction(
  ctx: GatewayContext,
  ev: SecurityEvaluation,
): Promise<CreatePendingActionResult> {
  // Card targets are resolved from the USER'S WORDS before anything else touches the args: an exact-id
  // validation can then never mask a selector, and a tail/card number placed in the id slot is REFUSED
  // (never looked up) instead of silently matching some other card.
  if (CARD_TARGET_TOOLS.includes(ctx.toolName)) {
    const card = await resolveCardTarget(ctx.userId, ctx.args);
    if (card.status !== 'resolved') {
      return { kind: 'clarify', message: buildCardClarifyMessage(card) };
    }
    ctx = { ...ctx, args: canonicalizeCardArgs(ctx.args, card.card.id) };
  }
  ctx = { ...ctx, args: await resolveBankingArgs(ctx.userId, ctx.toolName, ctx.args),
    userRequest: redactRequest(ctx.userRequest) };
  ctx.args = canonicalCommandArgs(ctx.args);
  if (ctx.toolName === 'create_scheduled_task') {
    ctx.args = { ...ctx.args, runAt: scheduledTime(ctx.args) };
  }
  if (ctx.toolName === 'apply_virtual_card' && ctx.args.monthlyLimit !== undefined) {
    const cents = moneyToCents(ctx.args.monthlyLimit);
    if (cents < 0n) throw new AppError('VALIDATION', 'Monthly limits cannot be negative.');
    ctx.args = { ...ctx.args, monthlyLimit: centsToMoney(cents) };
  }
  let recipient: { name: string; phone: string } | undefined;
  let accountLabel: string | undefined;

  if (ctx.toolName === 'transfer_money') {
    ctx = { ...ctx, args: { ...ctx.args, amount: normalizeTransferAmount(ctx.args.amount) } };

    // Resolve the recipient at park time so the card and the execution agree on the SAME contact. A
    // non-resolved recipient is a clarification request, NOT a parked action.
    const res = await resolveTransferRecipient(ctx.userId, ctx.args);
    if (res.status !== 'resolved') {
      return { kind: 'clarify', message: buildRecipientClarifyMessage(res) };
    }

    // Canonicalize to the resolved `contactId` BEFORE the dedupe: a re-park then compares the same
    // canonical args, and the args stored on the action are exactly what the SDK will execute.
    const sourceAccountId = ctx.args.sourceAccountId;
    ctx = { ...ctx, args: canonicalizeTransferArgs(ctx.args, res.contact.id) };
    recipient = { name: res.contact.name, phone: res.contact.phone };
    accountLabel = await resolveAccountLabel(
      ctx.userId,
      typeof sourceAccountId === 'string' ? sourceAccountId : undefined,
    );
  }

  // A plan node that is re-parked for the same operation reuses its existing action (and its
  // existing MFA challenge) instead of minting a duplicate.
  const reusable = await findReusableAction(ctx, ev);
  if (reusable) return { kind: 'created', action: toContractPendingAction(reusable) };

  const summary = buildPendingActionSummary(ctx, ev, recipient, accountLabel);
  if (ctx.args.cardId) {
    const card = await prisma.card.findFirst({ where: { id: String(ctx.args.cardId), userId: ctx.userId } });
    if (card) summary.fields.unshift({ label: '卡片', value: `${cardTypeLabel(card.type)} ${card.numberMasked}` });
  }
  if (ctx.args.productId) {
    const product = await prisma.investmentProduct.findUnique({ where: { id: String(ctx.args.productId) } });
    if (product) summary.fields.unshift({ label: '产品', value: `${product.name}（${product.code}）` });
  }
  if (ctx.args.holdingId) {
    const holding = await prisma.investmentHolding.findFirst({ where: { id: String(ctx.args.holdingId), userId: ctx.userId }, include: { product: true } });
    if (holding) summary.fields.unshift({ label: '持仓', value: `${holding.product.name}（${holding.id}）` });
    if (holding && ctx.toolName === 'redeem_investment') {
      // The SERVER mints the 「净值 + 份额」 quote from the PARKED request: the stated口径 decides the
      // shares redeemed, and the SAME SDK helpers (`sharesFromAmount` / `settlementFromShares`) settle
      // them, so the approved amount and the settled amount cannot diverge. A request that cannot be
      // quoted (no口径, retired principal field, no recorded shares, no published net value, over-size,
      // mixed口径) is refused HERE, before persisting, so no action is ever minted for it.
      // The gateway only SNAPSHOTS the quote — it never mutates a balance.
      const quote = quoteRedemption(holding, ctx.args);
      ctx.args = { ...ctx.args, ...redemptionSnapshot(quote) };
      // The money this action moves is the settlement credited, never a principal figure.
      summary.amount = quote.settlementAmount;
      summary.fields.push(
        { label: '赎回口径', value: REDEMPTION_MODE_LABEL[quote.mode] },
        { label: '赎回份额', value: quote.shares },
        { label: '成交净值', value: formatNetValue(quote.netValue) },
        { label: '净值日期', value: quote.netValueDate === undefined ? '未公布' : businessDateText(quote.netValueDate) },
        { label: '预计到账金额', value: formatCNY(quote.settlementAmount) },
        { label: '费用口径', value: `赎回费 ${formatCNY(quote.feeAmount)}（${quote.feeRule}：模拟规则免收）` },
        { label: '金额变化', value: '净值、份额或到账金额变化时停止执行，需重新确认' },
      );
    }
  }
  if (ctx.toolName === 'apply_virtual_card') {
    summary.fields.push(
      { label: '卡片类型', value: '虚拟卡（VIRTUAL）' },
      { label: '卡组织', value: '银联（UnionPay）' },
      { label: '月限额', value: ctx.args.monthlyLimit === undefined ? '未设置（本次仅开卡）' : formatCNY(String(ctx.args.monthlyLimit)) },
      { label: '分类限额', value: '不设置（本次仅开卡）' },
      { label: '演示范围', value: '保存卡片及月限额配置；Demo 不提供刷卡支付' },
    );
  }
  if (ctx.args.subscriptionId) {
    const subscription = await prisma.subscription.findFirst({ where: { id: String(ctx.args.subscriptionId), userId: ctx.userId } });
    if (subscription) summary.fields.unshift({ label: '订阅', value: subscription.name });
  }
  if (ctx.toolName === 'set_subscription_reminder') summary.fields.push({ label: '提醒设置', value: ctx.args.remind === true ? '开启' : '关闭' });
  if (ctx.toolName === 'set_card_limit') {
    summary.fields.push({ label: '限额类型', value: '分类消费限额（不影响授信额度）' });
    if (ctx.args.amount !== undefined) summary.fields.push({ label: '新分类消费限额', value: formatCNY(String(ctx.args.amount)) });
  }
  if (['subscribe_investment', 'redeem_investment'].includes(ctx.toolName)) {
    const account = await prisma.account.findFirst({ where: { userId: ctx.userId, type: 'CHECKING' } });
    summary.fields.push({ label: ctx.toolName === 'subscribe_investment' ? '付款账户' : '入账账户', value: account?.name ?? '账户待核对' });
  }
  for (const [key, label] of [['category','类别'],['limit','新限额'],['daysBefore','提前天数'],['name','名称'],['remark','备注']] as const) {
    if (ctx.args[key] !== undefined) summary.fields.push({ label, value: String(ctx.args[key]) });
  }
  if (ctx.toolName === 'create_scheduled_task') summary.fields.push({ label: '执行时间（北京时间）', value: formatDateTime(Number(ctx.args.runAt)) });
  if (ctx.toolName === 'create_scheduled_task') {
    summary.fields.push({ label: '任务类型', value: String(ctx.args.kind) });
    if (ctx.args.payload) summary.fields.push({ label: '任务内容', value: JSON.stringify(redactSecrets(ctx.args.payload)) });
    summary.fields.push({ label: '演示范围', value: '仅保存任务记录，不承诺到期执行' });
  }
  const status: PendingActionStatus = ev.requiresMfa ? 'awaiting_mfa' : 'pending';

  // The owning-plan status check and the row insert share ONE transaction: a plan cancelled
  // concurrently cannot slip a new action in between the read and the write.
  const created = await prisma.$transaction(async (tx) => {
    // A reclaimed runtime or workflow owner cannot leave a new executable action behind.
    await ctx.runtimeFence?.(tx);
    if (ctx.taskId) {
      const plan = await tx.agentTask.findUnique({
        where: { id: ctx.taskId },
        select: { status: true },
      });
      if (plan?.status === 'cancelled') return { refused: true as const };
    }
    const row = await repoCreatePending(
      {
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
        // Plan link (present only when the call originates from a DAG node): persisted AT CREATION so a
        // plan-level cancel can revoke the operation even if the node output JSON was never written.
        taskId: ctx.taskId,
        nodeId: ctx.nodeId,
        invocationId: ctx.invocationId,
        authorizationDecisionId: ctx.authorizationDecisionId,
      },
      tx,
    );
    return { refused: false as const, row };
  });

  if (created.refused) return { kind: 'plan_cancelled' };

  // RED actions get a code-free challenge up-front so the UI can prompt for MFA.
  if (ev.requiresMfa) await issueChallenge(created.row.id);

  return { kind: 'created', action: toContractPendingAction(created.row) };
}

/** Serialize the opaque block reason the runtime returns to the model (prefix + typed payload). */
function serializeBlockReason(
  decision: SecurityDecision,
  action: PendingAction,
  failure?: SecurityFailure,
): string {
  return `${BLOCK_REASON_PREFIX}${JSON.stringify({
    actionId: action.id,
    decisionKind: decision.kind,
    ...(failure ? { failure } : {}),
  })}`;
}

/** Keep only the TYPED facts of a serialized failure; an unknown reason drops the whole failure. */
function parseFailure(value: unknown): SecurityFailure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const code = record.code;
  const reason = record.reason;
  if (typeof code !== 'string' || code.length === 0) return undefined;
  if (typeof reason !== 'string' || !(FAILURE_REASONS as readonly string[]).includes(reason)) return undefined;
  const count = (key: string): number | undefined =>
    typeof record[key] === 'number' && Number.isFinite(record[key] as number) ? (record[key] as number) : undefined;
  const actionId = typeof record.actionId === 'string' && record.actionId.length > 0 ? record.actionId : undefined;
  const attemptsUsed = count('attemptsUsed');
  const attemptsLeft = count('attemptsLeft');
  const maxAttempts = count('maxAttempts');
  return {
    code: code as ErrorCode,
    reason: reason as SecurityFailureReason,
    ...(actionId ? { actionId } : {}),
    ...(attemptsUsed !== undefined ? { attemptsUsed } : {}),
    ...(attemptsLeft !== undefined ? { attemptsLeft } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  };
}

/** Parse a block reason produced by `serializeBlockReason`; `null` if not a block reason. */
function parseBlockReason(reason: string): ParsedBlockReason | null {
  if (typeof reason !== 'string' || !reason.startsWith(BLOCK_REASON_PREFIX)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(reason.slice(BLOCK_REASON_PREFIX.length));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const decisionKind = record.decisionKind;
  if (!isDecisionKind(decisionKind)) return null;

  // `actionId` is OPTIONAL: a `deny` refusal (tripped breaker, cancelled plan) has no action at all.
  const actionId = typeof record.actionId === 'string' && record.actionId.length > 0 ? record.actionId : undefined;
  const failure = parseFailure(record.failure);

  return { ...(actionId ? { actionId } : {}), decisionKind, ...(failure ? { failure } : {}) };
}

/**
 * Clean refusal returned when a confirm/verify is attempted on an action whose owning plan has been
 * `'cancelled'`: the claim is REVERSED to `cancelled` inside the caller's transaction, so NO side
 * effect runs and NO ledger row is written. RETURNED (never thrown) so the HTTP confirm/verify route
 * yields 200 `{ ok:false, ... }`. The tier is the action's EFFECTIVE parked tier; `requiresMfa` is
 * `false` (nothing more is being asked of the caller — the plan is simply gone).
 */
function planCancelledOutcome(
  row: PrismaPendingAction,
  action: PendingAction,
): AuthorizationResult {
  return {
    ok: false,
    status: 'cancelled',
    actionId: row.id,
    tier: action.tier,
    requiresMfa: false,
    code: 'SECURITY_DENIED',
    failure: { code: 'SECURITY_DENIED', reason: 'denied', actionId: row.id },
    message: PLAN_CANCELLED_MESSAGE,
    action: { ...action, status: 'cancelled' },
  };
}

/**
 * Persist a TERMINAL `'locked'` status on a `PendingAction` when the gateway returns a genuine
 * circuit-breaker lock decision. Without this the row stays `pending`/`awaiting_mfa`, so
 * `app/api/actions/route.ts#attentionFor` keeps surfacing it as a pending decision and the agent
 * bridge re-emits `mfa_required` for the SAME actionId — the MFA popup reappears forever. A
 * RACE-SAFE CAS (from an undecided state ONLY) means a concurrently-confirmed/terminal row is NEVER
 * clobbered; a lost CAS is benign (the row already moved on). Local so BOTH lock branches share ONE
 * persistence path. Returns the action consistent with the persisted state.
 */
async function persistLockedAction(actionId: string, action: PendingAction): Promise<PendingAction> {
  await claimPendingAction({ actionId, from: ['pending', 'awaiting_mfa'], to: 'locked' });
  return { ...action, status: 'locked' };
}

/**
 * The terminal `locked` refusal returned by the circuit-breaker gate AND by a re-attempt on an
 * already-`locked` row (idempotent: the row stays terminal and no verification is reopened). Shared
 * so both the gate and the early re-attempt guard return the SAME shape.
 */
function lockedOutcome(
  actionId: string,
  action: PendingAction,
  requiresMfa: boolean,
  reason: SecurityFailureReason,
): AuthorizationResult {
  return {
    ok: false,
    status: 'locked',
    actionId,
    tier: action.tier,
    requiresMfa,
    code: 'CIRCUIT_OPEN',
    failure: { code: 'CIRCUIT_OPEN', reason, actionId, attemptsLeft: 0, maxAttempts: MFA_MAX_ATTEMPTS },
    message: CIRCUIT_LOCK_MESSAGE,
    action,
  };
}

/**
 * The strong-verification path (RED static tools, and a `transfer_money` already parked RED or
 * escalated): prompt for a code when none was supplied, else `mfa.verify` it, then claim the action
 * exactly-once. Returns the EFFECTIVE tier/`requiresMfa` on every branch.
 */
async function authorizeWithMfa(
  actionId: string,
  row: PrismaPendingAction,
  action: PendingAction,
  opts: AuthorizeOptions,
): Promise<AuthorizationResult> {
  const tier: RiskLevel = row.toolName === 'transfer_money' ? 'RED' : (row.riskLevel as RiskLevel);

  // Reuse the current challenge. A newly issued challenge needs a separate user submission.
  const existingChallenge = await getMfaChallenge(actionId);
  const commandDigest = requestDigest({ userId: row.userId, toolName: row.toolName,
    args: canonicalCommandArgs(safeParse<Record<string, unknown>>(row.argsJson, {})) });
  const renewed = Boolean(existingChallenge && (!existingChallenge.expiresAt ||
    existingChallenge.expiresAt.getTime() <= realNow() || existingChallenge.commandDigest !== commandDigest));
  const issued = !existingChallenge || renewed;
  if (issued) await issueChallenge(actionId);

  if (!opts.mfaCode || issued) {
    // NOT a refusal: a code is still REQUIRED (or a fresh challenge was just issued), so the caller is
    // being asked to submit one. It therefore carries NO `code`/`failure` — `awaiting_mfa` is a PROMPT
    // state, and reporting a normal step of the flow as a failure would misrepresent it.
    return {
      ok: false,
      status: 'awaiting_mfa',
      actionId,
      tier,
      requiresMfa: true,
      message: renewed ? mfaMessages.renewedChallenge : issued ? mfaMessages.newChallenge : MFA_CODE_PROMPT,
      action,
    };
  }

  // `verify` can refuse at the CHALLENGE level. `mfa.challengeInvalidation` classifies WHY, so each
  // outcome gets its own honest semantics instead of one retryable `mfa_code_invalid` view:
  //   consumed          → the decision is SETTLED: CAS the row to terminal `cancelled`, never a retry.
  //   expired / changed → a fresh challenge was just minted, so re-prompting is accurate.
  //   anything else     → fail CLOSED: no prompt against a challenge the server cannot vouch for.
  const res = await verify(actionId, opts.mfaCode);
  if (!res.ok) {
    const invalidation = challengeInvalidation(res.error);
    if (invalidation === 'consumed') {
      const claimed = await claimPendingAction({ actionId, from: ['pending', 'awaiting_mfa'], to: 'cancelled' });
      if (!claimed) {
        // Lost the CAS: a concurrent decision settled the row first. NEVER execute here.
        const current = await getPendingAction(actionId);
        if (current?.status === 'locked') {
          return lockedOutcome(actionId, toContractPendingAction(current), true, 'mfa_session_locked');
        }
        throw new AppError('CONFLICT', `操作当前状态为「${statusLabel(current?.status ?? row.status)}」，无法重复确认。`);
      }
      return {
        ok: false,
        status: 'cancelled',
        actionId,
        tier,
        requiresMfa: false,
        mfaResult: 'failed',
        code: 'CONFLICT',
        failure: { code: 'CONFLICT', reason: 'denied', actionId },
        message: CONSUMED_CHALLENGE_MESSAGE,
        action: { ...action, status: 'cancelled' },
      };
    }
    if (invalidation !== null) {
      // `expired` / `command_changed`: a brand-new challenge was just issued, so asking for a code
      // again is accurate. Deliberately carries NO `code`/`failure` — a PROMPT, not a refusal.
      await issueChallenge(actionId);
      return {
        ok: false,
        status: 'awaiting_mfa',
        actionId,
        tier,
        requiresMfa: true,
        message: mfaMessages.renewedChallenge,
        action,
      };
    }
    throw new AppError('CONFLICT', '验证状态异常，该操作无法继续确认；请重新发起该操作。',
      { code: 'CONFLICT', reason: 'denied', actionId });
  }
  if (!res.value.ok) {
    const { attemptsLeft, locked } = res.value;
    // The operation's OWN attempt record is the ONLY authority for "this operation ran out of
    // attempts": `verify` reports `locked` for EVERY operation of a locked account, so an operation
    // that never consumed its limit must be told the ACCOUNT breaker tripped (`circuit_open`) — a
    // `mfa_attempts_exhausted` here would claim 0 (or negative) used attempts in its own words.
    const own = await attemptState(actionId);
    const attemptsUsed = own ? own.attempts : Math.max(0, MFA_MAX_ATTEMPTS - attemptsLeft);
    const maxAttempts = own?.maxAttempts ?? MFA_MAX_ATTEMPTS;
    const exhausted = own ? own.exhausted : attemptsLeft === 0;
    if (!locked) {
      return {
        ok: false,
        status: 'awaiting_mfa',
        actionId,
        tier,
        requiresMfa: true,
        mfaResult: 'failed',
        code: 'MFA_FAILED',
        failure: { code: 'MFA_FAILED', reason: 'mfa_code_invalid', actionId, attemptsUsed, attemptsLeft, maxAttempts },
        message: `验证码错误，请重试。剩余尝试次数：${attemptsLeft}。`,
        action,
      };
    }
    if (exhausted) {
      return {
        ok: false,
        status: 'locked',
        actionId,
        tier,
        requiresMfa: true,
        mfaResult: 'failed',
        code: 'CIRCUIT_OPEN',
        failure: { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', actionId, attemptsUsed, attemptsLeft, maxAttempts },
        message: ATTEMPTS_EXHAUSTED_MESSAGE,
        // A GENUINE terminal lock is made DURABLE on the row; the transient `awaiting_mfa` path is NOT.
        action: await persistLockedAction(actionId, action),
      };
    }
    // The account-level breaker was tripped by a DIFFERENT operation: report `circuit_open` (never a
    // per-operation attempt limit) and make the lock durable so the row stops reading as undecided.
    return {
      ok: false,
      status: 'locked',
      actionId,
      tier,
      requiresMfa: true,
      mfaResult: 'failed',
      code: 'CIRCUIT_OPEN',
      failure: { code: 'CIRCUIT_OPEN', reason: 'circuit_open', actionId, attemptsUsed, attemptsLeft, maxAttempts },
      message: CIRCUIT_LOCK_MESSAGE,
      action: await persistLockedAction(actionId, action),
    };
  }

  // Verified — claim exactly-once from a still-unsettled state (`awaiting_mfa` for a RED action,
  // `pending` for an escalated YELLOW transfer) so a concurrent/duplicate confirm is rejected. The
  // claim and the owning-plan re-read share ONE transaction: a plan cancelled after this action was
  // parked REVERSES the claim inside the tx, so no side effect runs and no ledger row is written.
  const claimOutcome = await prisma.$transaction(async (tx) => {
    const claimed = await claimPendingAction(
      {
        actionId,
        from: ['awaiting_mfa', 'pending'],
        to: 'confirmed',
        userId: row.userId,
        sessionId: row.sessionId,
      },
      tx,
    );
    if (!claimed) return { kind: 'conflict' as const };
    if (row.taskId) {
      const plan = await tx.agentTask.findUnique({
        where: { id: row.taskId },
        select: { status: true },
      });
      if (plan?.status === 'cancelled') {
        await tx.pendingAction.update({ where: { id: row.id }, data: { status: 'cancelled' } });
        return { kind: 'plan_cancelled' as const };
      }
    }
    return { kind: 'confirmed' as const };
  });

  if (claimOutcome.kind === 'conflict') {
    throw new AppError('CONFLICT', `操作当前状态为「${statusLabel(row.status)}」，无法重复确认。`);
  }
  if (claimOutcome.kind === 'plan_cancelled') {
    return planCancelledOutcome(row, action);
  }
  return {
    ok: true,
    status: 'confirmed',
    actionId,
    tier,
    requiresMfa: true,
    mfaResult: 'success',
    message: VERIFY_OK_MESSAGE,
    action: { ...action, tier, requiresMfa: true, status: 'confirmed' },
  };
}

/**
 * `transfer_money` authorization — the DYNAMIC path.
 *
 * A transfer already parked RED (or escalated) is completed via the shared strong-verification path.
 * A YELLOW (confirmation-only) transfer is authorized by ONE `prisma.$transaction` whose FIRST
 * statement is the exactly-once CAS claim: that WRITE acquires SQLite's write lock, so concurrent
 * confirms of DIFFERENT action ids SERIALIZE (cross-session, cross-process) instead of each reading
 * the same pre-transfer day total. The tx then reads the EFFECTIVE day total — today's EXECUTED
 * transfer debits PLUS in-flight PendingActions (excluding this one) — and re-runs the dynamic risk
 * rule. If the fresh risk is now RED the claim is reverted (within the tx) to `awaiting_mfa` with
 * `riskLevel:'RED'` / `requiresMfa:true`, the challenge is issued AFTER the commit, and the transfer
 * is refused the confirmation-only path (anti stale-parked-transfer bypass).
 */
async function authorizeTransfer(
  row: PrismaPendingAction,
  action: PendingAction,
  opts: AuthorizeOptions,
): Promise<AuthorizationResult> {
  const amount = normalizeTransferAmount(safeParse<Record<string, unknown>>(row.argsJson, {}).amount);
  const effectiveRequiresMfa = row.requiresMfa || action.tier === 'RED';
  if (effectiveRequiresMfa) {
    return authorizeWithMfa(row.id, row, action, opts);
  }

  // ONE transaction: the CAS claim (a WRITE ⇒ serializing SQLite write lock) FIRST, THEN the
  // effective-total read + dynamic risk. Reading after the write is what makes concurrent confirms
  // of different action ids serialize instead of racing on a stale day total.
  const outcome = await prisma.$transaction(async (tx) => {
    await assertActionMayStart(row.id, tx);
    const claim = await tx.pendingAction.updateMany({
      where: {
        id: row.id,
        status: { in: ['pending'] },
        userId: row.userId,
        sessionId: row.sessionId,
      },
      data: { status: 'confirmed' },
    });
    if (claim.count !== 1) return { kind: 'conflict' as const };

    // Plan-cancel guard: the owning plan may have been cancelled after this action was parked (a
    // bulk revoke that raced this confirm). If so, REVERSE the claim inside the tx so no side effect
    // runs and NO ledger row is written.
    if (row.taskId) {
      const plan = await tx.agentTask.findUnique({
        where: { id: row.taskId },
        select: { status: true },
      });
      if (plan?.status === 'cancelled') {
        await tx.pendingAction.update({ where: { id: row.id }, data: { status: 'cancelled' } });
        return { kind: 'plan_cancelled' as const };
      }
    }

    const effectiveTotal = await computeEffectiveTransferTotalWith(
      tx,
      row.userId,
      undefined,
      row.id,
    );
    const risk = evaluateTransferRisk({ amount, dailyTransferTotal: effectiveTotal });
    if (risk.tier === 'RED') {
      // Escalate WITHIN the tx: revert the claim and mark the action RED/MFA so a later verify (with
      // the code) can complete it. The escalation is persisted — never a silently-ignored return.
      await tx.pendingAction.update({
        where: { id: row.id },
        data: { status: 'awaiting_mfa', riskLevel: 'RED', requiresMfa: true,
          summaryJson: JSON.stringify(withActionPolicy(action.summary, { actionId: row.id, tier: 'RED', requiresMfa: true })),
        },
      });
      return { kind: 'escalated' as const, effectiveTotal, projected: risk.projectedDailyTotal };
    }
    return { kind: 'confirmed' as const };
  });

  if (outcome.kind === 'conflict') {
    throw new AppError('CONFLICT', `操作当前状态为「${statusLabel(row.status)}」，无法重复确认。`);
  }

  if (outcome.kind === 'plan_cancelled') {
    return planCancelledOutcome(row, action);
  }

  if (outcome.kind === 'escalated') {
    // Issue the MFA challenge AFTER the transaction commits.
    if (!(await getChallenge(row.id))) await issueChallenge(row.id);
    // NOTE: `lib/contracts/audit.ts` has NO `mfa_required` SecurityEventKind, so an EXISTING kind
    // (`LIMIT_EXCEEDED`) is emitted with a COMPLETE detail so the escalation is still auditable.
    await recordSecurityEvent({
      sessionId: row.sessionId,
      kind: 'LIMIT_EXCEEDED',
      severity: 'high',
      message: `转账在确认时升级为高风险：今日有效累计转账 ${formatCNY(outcome.effectiveTotal)} 加本次 ${formatCNY(amount)} 超过免密确认限额 ${formatCNY(DAILY_TRANSFER_LIMIT)}。`,
      detail: {
        decision: 'escalate_to_mfa',
        reason: 'execution_time_transfer_re_risk',
        actionId: row.id,
        amount,
        effectiveDailyTotal: outcome.effectiveTotal,
        projectedDailyTotal: outcome.projected,
        persistedTier: 'RED',
        persistedRequiresMfa: true,
      },
    });
    return {
      ok: false,
      status: 'awaiting_mfa',
      actionId: row.id,
      tier: 'RED',
      requiresMfa: true,
      code: 'LIMIT_EXCEEDED',
      failure: { code: 'LIMIT_EXCEEDED', reason: 'denied', actionId: row.id },
      message: TRANSFER_ESCALATED_MESSAGE,
      action: { ...action, tier: 'RED', requiresMfa: true, status: 'awaiting_mfa',
        summary: withActionPolicy(action.summary, { actionId: row.id, tier: 'RED', requiresMfa: true }),
      },
    };
  }

  return {
    ok: true,
    status: 'confirmed',
    actionId: row.id,
    tier: 'YELLOW',
    requiresMfa: false,
    mfaResult: 'not_required',
    message: CONFIRM_OK_MESSAGE,
    action: { ...action, status: 'confirmed' },
  };
}

/**
 * Authorize a pending action after a human decision. REQUIRES caller ownership (fail-closed),
 * honors the session circuit breaker (a locked session is refused even with a correct code), routes
 * `transfer_money` through the atomic claim-first re-risk transaction, claims the action
 * exactly-once, and verifies MFA for RED actions. The gateway NEVER executes the business operation.
 */
async function authorizeAction(
  actionId: string,
  opts: AuthorizeOptions,
): Promise<AuthorizationResult> {
  let row = await getPendingAction(actionId);
  if (!row) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);
  if (isManualCardCommand(row.toolName) || catalogEntry(row.toolName)?.agentEnabled === false) throw new AppError('SECURITY_DENIED', 'Use the card management page to confirm this change.');

  // Ownership is REQUIRED (fail-closed): a missing/mismatching caller identity is refused.
  await assertOwnership(row, opts);

  // A TERMINAL `locked` action (the durable circuit-breaker lock) reports the SAME lock result
  // idempotently — handled BEFORE the undecided guard so a re-attempt gets a clean `locked` refusal
  // (never reopens verification: no new challenge, no consumed attempt, no re-prompt).
  if (row.status === 'locked') {
    const lockedAction = toContractPendingAction(row);
    return lockedOutcome(actionId, lockedAction, row.requiresMfa || lockedAction.tier === 'RED', 'mfa_session_locked');
  }

  // Only undecided actions can request a code. A historical RED flag on a confirmed/terminal
  // action must not reopen verification, issue a new challenge or consume an MFA attempt.
  if (row.status !== 'pending' && row.status !== 'awaiting_mfa') {
    throw new AppError('CONFLICT', `操作当前状态为「${statusLabel(row.status)}」，无法重复确认。`);
  }

  // Recheck current static policy before granting a new execution. Persisted decisions may be
  // stricter, but a stale or corrupt confirmation-only row cannot downgrade today's RED policy.
  const policy = getToolPolicy(row.toolName as ToolName);
  if (policy.static && policy.tier === 'RED' && (!row.requiresMfa || row.riskLevel !== 'RED')) {
    const upgraded = await prisma.pendingAction.updateMany({
      where: { id: row.id, userId: row.userId, sessionId: row.sessionId, status: { in: ['pending', 'awaiting_mfa'] } },
      data: { riskLevel: 'RED', requiresMfa: true, status: 'awaiting_mfa' },
    });
    if (upgraded.count !== 1) throw new AppError('CONFLICT', 'The operation is no longer awaiting authorization.');
    row = await getPendingAction(actionId);
    if (!row) throw new AppError('NOT_FOUND', 'The operation no longer exists.');
  }
  const action = toContractPendingAction(row);
  const effectiveRequiresMfa = row.requiresMfa || action.tier === 'RED';
  if (row.taskId && await prisma.manualReview.findFirst({ where: { taskId: row.taskId, status: 'open' } })) {
    // A neutral internal sentence: the public copy is decided from the TYPED code by
    // `lib/public-text.ts` (`chat.error.manualReviewHold`), never from this text.
    throw new AppError('MANUAL_REVIEW_HOLD', 'This workflow is under manual review; a new command cannot start.');
  }

  // Circuit breaker is a hard gate the LLM (and even a correct code) cannot bypass.
  if (await isLocked(row.sessionId)) {
    // Make the lock DURABLE on the row so it is no longer surfaced as an undecided action.
    return lockedOutcome(actionId, await persistLockedAction(actionId, action), effectiveRequiresMfa, 'circuit_open');
  }

  // `transfer_money` is DYNAMIC: its tier is re-derived at EXECUTION time (see `authorizeTransfer`).
  if (row.toolName === 'transfer_money') {
    return authorizeTransfer(row, action, opts);
  }

  // Static RED — strong verification required.
  if (effectiveRequiresMfa) {
    return authorizeWithMfa(actionId, row, action, opts);
  }

  // Static YELLOW — an atomic exactly-once claim authorizes execution; no strong verification.
  const claimed = await claimPendingAction({
    actionId,
    from: ['pending'],
    to: 'confirmed',
    userId: row.userId,
    sessionId: row.sessionId,
  });
  if (!claimed) {
    throw new AppError('CONFLICT', `操作当前状态为「${statusLabel(row.status)}」，无法重复确认。`);
  }
  return {
    ok: true,
    status: 'confirmed',
    actionId,
    tier: action.tier,
    requiresMfa: false,
    mfaResult: 'not_required',
    message: CONFIRM_OK_MESSAGE,
    action: { ...action, status: 'confirmed' },
  };
}

/**
 * Cancel a pending action (atomic exactly-once claim → `cancelled`); no execution.
 * REQUIRES the caller ownership and rejects an already-settled action with `CONFLICT`.
 */
async function cancelAction(actionId: string, opts: CancelOptions): Promise<PendingAction> {
  const row = await getPendingAction(actionId);
  if (!row) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);
  if (isManualCardCommand(row.toolName)) throw new AppError('SECURITY_DENIED', 'Use the card management page to cancel this change.');

  await assertOwnership(row, opts);

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
    throw new AppError('CONFLICT', `操作当前状态为「${statusLabel(row.status)}」，无法取消。`);
  }

  const updated = await getPendingAction(actionId);
  return toContractPendingAction(updated ?? { ...row, status: 'cancelled' });
}

/**
 * Persist the TRUE terminal status of an action AFTER the caller has executed it (or failed), so a
 * subsequent confirm/cancel is correctly rejected as CONFLICT. The write is a STATUS CAS over
 * `RESULT_RECORDABLE_STATUSES`, never a blind overwrite: the exactly-once claim already happened at
 * confirm time, and this never consults the owning plan, so an action whose money already moved stays
 * `'executed'` even if its plan is cancelled afterwards. A TERMINAL `'locked'` row therefore KEEPS
 * its lock — a late/stale notification can neither un-lock it nor relabel it `'executed'` (which
 * would fabricate execution evidence for an operation that was never authorized to run). The
 * settlement row and audit written by the caller remain the authoritative evidence.
 */
async function recordActionResult(actionId: string, status: 'executed' | 'failed'): Promise<void> {
  const claimed = await claimPendingAction({ actionId, from: RESULT_RECORDABLE_STATUSES, to: status });
  if (claimed) return;
  if ((await getPendingAction(actionId)) === null) {
    throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);
  }
  // The row sits in a status a result notification may NOT overwrite (`'locked'`): keep it as it is.
}

/** End-to-end helper used by `beforeToolCall`. */
async function handleToolCall(ctx: GatewayContext): Promise<ToolCallAuthorization> {
  // Caller identity is REQUIRED (fail-closed) — no demo-user fallback. There is no persisted action
  // yet, so only presence/non-emptiness can be asserted here.
  assertCallerIdentity(ctx);

  const evaluation = await gatewayEvaluate(ctx);
  const decision = gatewayDecide(evaluation);
  ctx = { ...ctx, authorizationDecisionId: await recordAuthorizationDecision(ctx, decision) };
  const recordDenial = async (reason: string): Promise<void> => {
    await recordAuthorizationDecision(ctx, { ...decision, kind: 'deny', evaluation: {
      ...evaluation, blocked: true, blockReason: reason, reasons: [...evaluation.reasons, reason],
    } });
  };

  // GREEN — allow the tool to execute inline.
  if (!evaluation.blocked) return { evaluation, decision };

  // Locked session — deny with an opaque reason and NO pending action.
  if (decision.kind === 'deny') {
    return {
      evaluation,
      decision,
      blockReason: `${BLOCK_REASON_PREFIX}${JSON.stringify({ decisionKind: 'deny', failure: { code: 'CIRCUIT_OPEN', reason: 'circuit_open' } })}`,
    };
  }

  // Gated (YELLOW/RED) — persist the pending action and block with its id.
  let result: CreatePendingActionResult;
  try { result = await gatewayCreatePendingAction(ctx, evaluation); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== 'VALIDATION') throw error;
    await recordDenial(error.message);
    return { evaluation, decision: { ...decision, kind: 'deny' }, blockReason: error.message };
  }

  // An unresolvable/ambiguous transfer recipient → BLOCK with a PLAIN model-readable message (never a
  // `BLOCK_REASON_PREFIX` payload, which the model cannot read) and NO pending action. `evaluation.blocked`
  // stays true; the model asks the user to clarify the recipient.
  if (result.kind === 'clarify') {
    await recordDenial(result.message);
    return {
      evaluation,
      decision: { ...decision, kind: 'deny' },
      blockReason: result.message,
    };
  }

  // Plan-scoped call whose owning plan is already cancelled → REFUSE cleanly (returned, not thrown)
  // so the agent layer reports a refusal rather than an infra failure.
  if (result.kind === 'plan_cancelled') {
    await recordDenial('WORKFLOW_CANCELLED');
    return {
      evaluation,
      decision: { ...decision, kind: 'deny' },
      blockReason: `${BLOCK_REASON_PREFIX}${JSON.stringify({ decisionKind: 'deny', failure: { code: 'SECURITY_DENIED', reason: 'denied' } })}`,
    };
  }

  const action = result.action;
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
  // Public interface stays non-null: the internal implementation returns `plan_cancelled` only when a
  // plan-scoped call's owning plan is already cancelled (a direct caller that bypassed `handleToolCall`
  // gets a CONFLICT instead of a `null` action) and `clarify` when a transfer recipient could not be
  // resolved unambiguously (surfaced as a VALIDATION error carrying the model-readable message).
  createPendingAction: async (ctx: GatewayContext, ev: SecurityEvaluation) => {
    const result = await gatewayCreatePendingAction(ctx, ev);
    if (result.kind === 'plan_cancelled') {
      throw new AppError('CONFLICT', '操作所属的任务计划已取消，无法创建待处理操作。');
    }
    if (result.kind === 'clarify') {
      throw new AppError('VALIDATION', result.message);
    }
    return result.action;
  },
  serializeBlockReason,
  parseBlockReason,
  authorizeAction,
  cancelAction,
  recordActionResult,
  handleToolCall,
};

/**
 * Build the user-facing `PendingActionSummary` for a gated call (title, key/value fields
 * such as 收款人 / 收款手机号 / 金额 / 账户 / 风险等级, `requiresMfa`, `mfaHint`). Pure — formatting
 * only. Exported for reuse/testing.
 *
 * For `transfer_money` the optional `recipient` (the SERVER-RESOLVED contact from
 * `resolveTransferRecipient`) supplies the 收款人 name and an ADDITIONAL, MASKED 收款手机号 field;
 * `accountLabel` (from `resolveAccountLabel`) overrides the account field. Pure formatter tests
 * may omit server-resolved display metadata; the field order stays
 * 收款人 → [收款手机号] → 金额 → 账户 → 风险等级.
 */
export function buildPendingActionSummary(
  ctx: GatewayContext,
  ev: SecurityEvaluation,
  recipient?: { name: string; phone: string },
  accountLabel?: string,
): import('../lib/contracts/security').PendingActionSummary {
  const policy = getToolPolicy(ctx.toolName);
  const amount = resolveAmount(ctx.args);
  const fields: Array<{ label: string; value: string }> = [];

  if (ctx.toolName === 'transfer_money') {
    fields.push({
      label: '收款人',
      value:
        recipient?.name ??
        pickString(ctx.args, ['name']) ??
        '（未指定）',
    });
    // Masked (never raw) so the card never leaks the recipient's full phone number.
    if (recipient) fields.push({ label: '收款手机号', value: maskPhone(recipient.phone) });
    fields.push({ label: 'Amount', value: formatCNY(amount ?? '0.00') });
    fields.push({
      label: '账户',
      value:
        accountLabel ??
        pickString(ctx.args, [
          'sourceAccountId',
          'fromAccount',
          'account',
          'fromAccountId',
          'from',
          'toAccount',
        ]) ??
        '默认活期账户',
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

/**
 * Recipient-resolution helpers live in `./recipient-resolution` (a cohesive, DB-backed module).
 * Re-exported here so the established `@/security/security-gateway` import surface (notably
 * `maskPhone` and `RecipientResolution`) is preserved for existing callers and tests.
 */
export {
  buildRecipientClarifyMessage,
  canonicalizeTransferArgs,
  maskPhone,
  resolveAccountLabel,
  resolveTransferRecipient,
} from './recipient-resolution';
export type { RecipientResolution } from './recipient-resolution';

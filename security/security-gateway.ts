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
} from '../lib/contracts/security';
import { evaluateTool, getToolPolicy } from './permission-engine';
import type { ToolEvaluation } from './permission-engine';
import {
  computeDailyTransferTotal,
  computeEffectiveTransferTotalWith,
  evaluateTransferRisk,
} from './risk-engine';
import { isLocked } from './circuit-breaker';
import { getChallenge, issueChallenge, verify } from './mfa';
import {
  assertActionMayStart,
  claimPendingAction,
  createPendingAction as repoCreatePending,
  getPendingAction,
  getMfaChallenge,
  listPendingActionsByTask,
  setPendingActionStatus,
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
import { valuationToMinor } from '../lib/decimal';
import { settledRedemptionAmount } from '../banking-sdk/valuation';
import { canonicalCommandArgs } from '../lib/contracts/command';
import { recordAuthorizationDecision } from './authorization-record';
import { DAILY_TRANSFER_LIMIT, RISK_LABEL } from '../lib/constants';
import { AppError } from '../lib/errors';
import { requestDigest } from '../lib/ledger';
import { realNow } from '../lib/clock';
import mfaMessages from './messages/mfa.zh-CN.json';
import { resolveBankingArgs } from '../lib/banking-selectors';
import { withActionPolicy } from '../lib/action-summary';
import { scheduledTime } from '../lib/scheduled-time';
import { redactRequest, redactSecrets } from '../lib/sensitive';
import { formatDateTime } from '../lib/date';
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
  set_card_limit: '调整信用卡额度',
  cancel_subscription: '取消订阅',
  apply_virtual_card: '申请虚拟卡',
  set_subscription_reminder: '设置订阅提醒',
  create_scheduled_task: '创建定时任务',
  // 🔴 RED
  freeze_card: '冻结银行卡',
  subscribe_investment: '理财产品申购',
  redeem_investment: '理财产品赎回',
  report_lost_card: '挂失银行卡',
  unfreeze_card: '解冻银行卡',
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

/** The redemption quote belongs to the original server decision, not the model's request identity. */
function requestArgs(tool: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== 'redeem_investment') return args;
  const { expectedRedemptionAmount: _quote, ...request } = args;
  return request;
}

/**
 * Outcome of the internal park path. `created` ⇒ a `PendingAction` was persisted (or reused);
 * `plan_cancelled` ⇒ refused because the owning `AgentTask` is already `'cancelled'`; `clarify` ⇒ a
 * transfer recipient could not be resolved unambiguously, so NOTHING was persisted (no `PendingAction`,
 * no MFA challenge) and the caller must ask the user to clarify.
 */
type CreatePendingActionResult =
  | { kind: 'created'; action: PendingAction }
  | { kind: 'plan_cancelled' }
  | { kind: 'clarify'; message: string };

/**
 * Persist a gated call as a `PendingAction` with a `PendingActionSummary`.
 *
 * For `transfer_money` the recipient is resolved SERVER-SIDE at park time (mirroring the SDK), so the
 * confirmation card names the SAME contact the SDK will resolve at execution: an unresolvable/ambiguous
 * recipient returns `{ kind: 'clarify' }` without persisting anything, and a resolved one canonicalizes
 * the args to the resolved `contactId` BEFORE the dedupe (so a re-park compares canonical args and the
 * args the SDK later executes are the ones validated here).
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
    if (card) summary.fields.unshift({ label: '卡片', value: `${({ CREDIT: '信用卡', DEBIT: '借记卡', VIRTUAL: '虚拟卡' } as Record<string, string>)[card.type] ?? card.type} ${card.numberMasked}` });
  }
  if (ctx.args.productId) {
    const product = await prisma.investmentProduct.findUnique({ where: { id: String(ctx.args.productId) } });
    if (product) summary.fields.unshift({ label: '产品', value: `${product.name}（${product.code}）` });
  }
  if (ctx.args.holdingId) {
    const holding = await prisma.investmentHolding.findFirst({ where: { id: String(ctx.args.holdingId), userId: ctx.userId }, include: { product: true } });
    if (holding) summary.fields.unshift({ label: '持仓', value: `${holding.product.name}（${holding.id}）` });
    if (holding && ctx.toolName === 'redeem_investment') {
      // The SERVER mints the redemption quote from the PARKED request: the requested PRINCIPAL portion
      // (`redeemAmount`; absent ⇒ the whole holding) picks the SAME proportional valuation the SDK
      // re-checks at execution, so the approved amount and the settled amount cannot diverge. An
      // over-redeem request is refused HERE, before persisting, so no action is ever minted for it.
      // The gateway only SNAPSHOTS the quote — it never mutates a balance.
      const totalPrincipalMinor = holding.principalAmountMinor;
      const requestedMinor = ctx.args.redeemAmount === undefined ? undefined : moneyToCents(ctx.args.redeemAmount);
      if (requestedMinor !== undefined && requestedMinor > totalPrincipalMinor) {
        throw new AppError('VALIDATION', '赎回本金金额不能超过持仓本金', {
          redeemAmount: centsToMoney(requestedMinor),
          totalPrincipal: centsToMoney(totalPrincipalMinor),
        });
      }
      const redeemedPrincipalMinor = requestedMinor ?? totalPrincipalMinor;
      const marketValue = holding.estimatedMarketValue === null
        ? centsToMoney(totalPrincipalMinor) : holding.estimatedMarketValue;
      // FULL mints the whole rounded valuation; PARTIAL mints the SAME proportional settlement the SDK
      // re-checks at execution, so the confirmed quote and the settled amount cannot diverge.
      const amount = redeemedPrincipalMinor === totalPrincipalMinor
        ? centsToMoney(valuationToMinor(marketValue))
        : settledRedemptionAmount(marketValue, totalPrincipalMinor, redeemedPrincipalMinor);
      ctx.args = { ...ctx.args, expectedRedemptionAmount: amount };
      const partial = redeemedPrincipalMinor !== totalPrincipalMinor;
      summary.fields.push(
        { label: '赎回范围', value: partial ? `部分赎回（本金 ${formatCNY(centsToMoney(redeemedPrincipalMinor))}／共计 ${formatCNY(centsToMoney(totalPrincipalMinor))}）` : '全部赎回该笔持仓' },
        { label: 'Principal', value: formatCNY(centsToMoney(totalPrincipalMinor)) },
        { label: '赎回到账金额', value: formatCNY(amount) },
        { label: '金额变化', value: '金额变化时停止执行，需重新确认' },
      );
    }
  }
  if (ctx.toolName === 'apply_virtual_card') {
    summary.fields.push({ label: '月限额', value: ctx.args.monthlyLimit === undefined ? '未设置（本次仅开卡）' : formatCNY(String(ctx.args.monthlyLimit)) });
    summary.fields.push({ label: '演示范围', value: '保存卡片及月限额配置；Demo 不提供刷卡支付' });
  }
  if (ctx.args.subscriptionId) {
    const subscription = await prisma.subscription.findFirst({ where: { id: String(ctx.args.subscriptionId), userId: ctx.userId } });
    if (subscription) summary.fields.unshift({ label: '订阅', value: subscription.name });
  }
  if (ctx.toolName === 'set_subscription_reminder') summary.fields.push({ label: '提醒设置', value: ctx.args.remind === true ? '开启' : '关闭' });
  if (ctx.toolName === 'set_card_limit' && ctx.args.amount !== undefined) summary.fields.push({ label: '新限额', value: formatCNY(String(ctx.args.amount)) });
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
): AuthorizationResult {
  return {
    ok: false,
    status: 'locked',
    actionId,
    tier: action.tier,
    requiresMfa,
    code: 'CIRCUIT_OPEN',
    message: '当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。',
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

  const res = await verify(actionId, opts.mfaCode);
  if (!res.ok) {
    return {
      ok: false,
      status: 'awaiting_mfa',
      actionId,
      tier,
      requiresMfa: true,
      mfaResult: 'failed',
      code: 'MFA_FAILED',
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
      tier,
      requiresMfa: true,
      mfaResult: 'failed',
      code: locked ? 'CIRCUIT_OPEN' : 'MFA_FAILED',
      message: locked
        ? '验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。'
        : `验证码错误，请重试。剩余尝试次数：${attemptsLeft}。`,
      // A GENUINE terminal lock is made DURABLE on the row; the transient `awaiting_mfa` path is NOT.
      action: locked ? await persistLockedAction(actionId, action) : action,
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
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法重复确认。`);
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
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法重复确认。`);
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
    return lockedOutcome(actionId, lockedAction, row.requiresMfa || lockedAction.tier === 'RED');
  }

  // Only undecided actions can request a code. A historical RED flag on a confirmed/terminal
  // action must not reopen verification, issue a new challenge or consume an MFA attempt.
  if (row.status !== 'pending' && row.status !== 'awaiting_mfa') {
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法重复确认。`);
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
    throw new AppError('CONFLICT', 'This workflow is under manual review; a new command cannot start.');
  }

  // Circuit breaker is a hard gate the LLM (and even a correct code) cannot bypass.
  if (await isLocked(row.sessionId)) {
    // Make the lock DURABLE on the row so it is no longer surfaced as an undecided action.
    return lockedOutcome(actionId, await persistLockedAction(actionId, action), effectiveRequiresMfa);
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
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法重复确认。`);
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
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法取消。`);
  }

  const updated = await getPendingAction(actionId);
  return toContractPendingAction(updated ?? { ...row, status: 'cancelled' });
}

/**
 * Persist the TRUE terminal status of an action AFTER the caller has executed it (or failed), so a
 * subsequent confirm/cancel is correctly rejected as CONFLICT. Recorded VERBATIM and unconditionally
 * — the exactly-once claim happened at confirm time, and this never consults the owning plan, so an
 * action whose money already moved stays `'executed'` even if its plan is cancelled afterwards.
 */
async function recordActionResult(actionId: string, status: 'executed' | 'failed'): Promise<void> {
  await setPendingActionStatus(actionId, status);
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
      blockReason: `${BLOCK_REASON_PREFIX}${JSON.stringify({ decisionKind: 'deny' })}`,
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
      blockReason: `${BLOCK_REASON_PREFIX}${JSON.stringify({ decisionKind: 'deny' })}`,
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

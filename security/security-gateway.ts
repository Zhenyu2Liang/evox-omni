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
import {
  computeDailyTransferTotal,
  computeEffectiveTransferTotalWith,
  evaluateTransferRisk,
} from './risk-engine';
import { isLocked } from './circuit-breaker';
import { getChallenge, issueChallenge, verify } from './mfa';
import {
  claimPendingAction,
  createPendingAction as repoCreatePending,
  getPendingAction,
  listPendingActionsByTask,
  setPendingActionStatus,
} from '../lib/db/repositories/pendingAction';
import { getSession } from '../lib/db/repositories/session';
import { prisma } from '../lib/db/client';
import { recordSecurityEvent } from '../audit';
import { safeParse } from '../lib/json';
import { formatCNY, normalizeTransferAmount, parseAmount } from '../lib/money';
import { DAILY_TRANSFER_LIMIT, RISK_LABEL } from '../lib/constants';
import { AppError } from '../lib/errors';
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

/** `authorizeAction` options: REQUIRED ownership plus an optional strong-verification code. `confirmed` is an accepted-but-ignored caller hint (a YELLOW action is authorized by the atomic `pending → confirmed` claim; a RED action by `mfaCode`). */
export type AuthorizeOptions = ActionOwnership & { mfaCode?: string; confirmed?: boolean };

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
        sameArgs(safeParse<Record<string, unknown>>(row.argsJson, {}), ctx.args),
    ) ?? null
  );
}

/**
 * Persist a gated call as a `PendingAction` with a `PendingActionSummary`.
 *
 * Returns `null` when the call is plan-scoped (`ctx.taskId`) and the owning `AgentTask` is already
 * `'cancelled'`. The plan-status read and the row insert run in ONE transaction, so a plan cancelled
 * concurrently cannot slip a fresh action in between the read and the write (create-time half of the
 * plan-cancel → authorize race guard). `handleToolCall` turns the refusal into a clean `deny`; the
 * public `SecurityGateway.createPendingAction` wrapper maps it to a `CONFLICT`.
 */
async function gatewayCreatePendingAction(
  ctx: GatewayContext,
  ev: SecurityEvaluation,
): Promise<PendingAction | null> {
  if (ctx.toolName === 'transfer_money') {
    ctx = { ...ctx, args: { ...ctx.args, amount: normalizeTransferAmount(ctx.args.amount) } };
  }
  // A plan node that is re-parked for the same operation reuses its existing action (and its
  // existing MFA challenge) instead of minting a duplicate.
  const reusable = await findReusableAction(ctx, ev);
  if (reusable) return toContractPendingAction(reusable);

  const summary = buildPendingActionSummary(ctx, ev);
  const status: PendingActionStatus = ev.requiresMfa ? 'awaiting_mfa' : 'pending';

  // The owning-plan status check and the row insert share ONE transaction: a plan cancelled
  // concurrently cannot slip a new action in between the read and the write.
  const created = await prisma.$transaction(async (tx) => {
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
      },
      tx,
    );
    return { refused: false as const, row };
  });

  if (created.refused) return null;

  // RED actions get a code-free challenge up-front so the UI can prompt for MFA.
  if (ev.requiresMfa) await issueChallenge(created.row.id);

  return toContractPendingAction(created.row);
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

  // Ensure a challenge exists (RED actions get one up-front at park time; re-issue defensively).
  if (!(await getChallenge(actionId))) await issueChallenge(actionId);

  if (!opts.mfaCode) {
    return {
      ok: false,
      status: 'awaiting_mfa',
      actionId,
      tier,
      requiresMfa: true,
      message: MFA_CODE_PROMPT,
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
      action,
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
        data: { status: 'awaiting_mfa', riskLevel: 'RED', requiresMfa: true },
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
      action: { ...action, tier: 'RED', requiresMfa: true, status: 'awaiting_mfa' },
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
  const row = await getPendingAction(actionId);
  if (!row) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);

  // Ownership is REQUIRED (fail-closed): a missing/mismatching caller identity is refused.
  await assertOwnership(row, opts);

  // Only undecided actions can request a code. A historical RED flag on a confirmed/terminal
  // action must not reopen verification, issue a new challenge or consume an MFA attempt.
  if (row.status !== 'pending' && row.status !== 'awaiting_mfa') {
    throw new AppError('CONFLICT', `操作当前状态为「${row.status}」，无法重复确认。`);
  }

  const action = toContractPendingAction(row);
  const effectiveRequiresMfa = row.requiresMfa || action.tier === 'RED';

  // Circuit breaker is a hard gate the LLM (and even a correct code) cannot bypass.
  if (isLocked(row.sessionId)) {
    return {
      ok: false,
      status: 'locked',
      actionId,
      tier: action.tier,
      requiresMfa: effectiveRequiresMfa,
      code: 'CIRCUIT_OPEN',
      message: '当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。',
      action,
    };
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
  // Plan-scoped call whose owning plan is already cancelled → REFUSE cleanly (returned, not thrown)
  // so the agent layer reports a refusal rather than an infra failure.
  if (action === null) {
    return {
      evaluation,
      decision: { ...decision, kind: 'deny' },
      blockReason: `${BLOCK_REASON_PREFIX}${JSON.stringify({ decisionKind: 'deny' })}`,
    };
  }
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
  // Public interface stays non-null: the internal implementation returns `null` only when a
  // plan-scoped call's owning plan is already cancelled. A direct caller that bypassed
  // `handleToolCall` gets a CONFLICT instead of a `null` action.
  createPendingAction: async (ctx: GatewayContext, ev: SecurityEvaluation) => {
    const action = await gatewayCreatePendingAction(ctx, ev);
    if (action === null) {
      throw new AppError('CONFLICT', '操作所属的任务计划已取消，无法创建待处理操作。');
    }
    return action;
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

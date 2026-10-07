/**
 * Permission Engine — the STATIC half of the security policy.
 *
 * DESIGN PRINCIPLE (LLM-IMMUTABLE): the permission tier of every tool is decided
 * HERE, in TypeScript, from a static policy table plus deterministic dynamic rules
 * (delegated to `./risk-engine`). The model can NEVER influence `tier`,
 * `requiresConfirmation` or `requiresMfa` — it only supplies tool arguments, which
 * are validated independently by each tool. The agent may decide WHAT to do next;
 * it may never decide WHETHER it is allowed.
 *
 * This module performs NO I/O and is fully pure/deterministic.
 */
import type { RiskLevel } from '../lib/contracts/risk';
import type { ToolName } from '../lib/contracts/tools';
import { evaluateTransferRisk } from './risk-engine';
import { AppError } from '../lib/errors';
import { normalizeTransferAmount } from '../lib/money';

export interface ToolPolicy {
  /** Static risk tier for the tool. `transfer_money` is dynamic (see `static: false`). */
  tier: RiskLevel;
  /** `true` when the tier is fixed by the table; `false` when it is computed at runtime. */
  static: boolean;
  /** Human-readable policy note (Chinese), surfaced in the audit log / UI. */
  description: string;
}

/** Inputs the evaluator needs beyond the raw tool arguments. */
export interface EvaluateToolContext {
  userId: string;
  sessionId: string;
  /** Sum of today's outgoing transfers for `userId` (from `risk-engine.computeDailyTransferTotal`). */
  dailyTransferTotal: number;
}

export interface ToolEvaluation {
  tier: RiskLevel;
  requiresConfirmation: boolean;
  requiresMfa: boolean;
  reasons: string[];
}

/**
 * The frozen GREEN / YELLOW / RED policy table — the single source of truth for tool tiers.
 * Keys MUST cover every `ToolName`. `transfer_money` is dynamic (`static: false`);
 * `submit_plan` is a planner meta-tool and is NOT risk-gated.
 */
export const TOOL_POLICY: Record<ToolName, ToolPolicy> = {
  // 🟢 GREEN — low-risk reads; auto-execute, no confirmation.
  get_balance: { tier: 'GREEN', static: true, description: '查询余额' },
  get_transactions: { tier: 'GREEN', static: true, description: '查询交易流水' },
  search_contact: { tier: 'GREEN', static: true, description: '查询联系人' },
  analyze_spending: { tier: 'GREEN', static: true, description: '消费分析' },
  detect_anomaly: { tier: 'GREEN', static: true, description: '异常交易检测' },
  get_cards: { tier: 'GREEN', static: true, description: '查询银行卡' },
  list_subscriptions: { tier: 'GREEN', static: true, description: '查询订阅' },
  list_investments: { tier: 'GREEN', static: true, description: '查询理财产品' },
  compare_investments: { tier: 'GREEN', static: true, description: '理财产品对比' },
  get_investment_holdings: { tier: 'GREEN', static: true, description: '查询理财持仓' },
  get_dashboard_summary: { tier: 'GREEN', static: true, description: '资产概览' },
  list_scheduled_tasks: { tier: 'GREEN', static: true, description: '查询定时任务' },
  reserve_budget: { tier: 'GREEN', static: true, description: '预算预留' },

  // 🟡 YELLOW — medium risk; requires user confirmation.
  set_card_limit: { tier: 'YELLOW', static: true, description: '设置卡片限额' },
  cancel_subscription: { tier: 'YELLOW', static: true, description: '取消订阅' },
  freeze_card: { tier: 'YELLOW', static: true, description: '冻结银行卡' },
  apply_virtual_card: { tier: 'YELLOW', static: true, description: '申请虚拟卡' },
  set_subscription_reminder: { tier: 'YELLOW', static: true, description: '设置订阅提醒' },
  create_scheduled_task: { tier: 'YELLOW', static: true, description: '创建定时任务' },

  // 🔴 RED — high risk; requires strong verification (mock MFA).
  subscribe_investment: { tier: 'RED', static: true, description: '认购理财产品' },
  redeem_investment: { tier: 'RED', static: true, description: '赎回理财产品' },
  report_lost_card: { tier: 'RED', static: true, description: '银行卡挂失' },
  unfreeze_card: { tier: 'RED', static: true, description: '解冻银行卡' },
  change_password: { tier: 'RED', static: true, description: '修改密码' },

  // DYNAMIC — tier computed from amount + daily total (see risk-engine).
  transfer_money: { tier: 'YELLOW', static: false, description: '转账（按金额/日累计动态分级，始终需确认）' },

  // Planner meta-tool — NOT risk-gated (allow).
  submit_plan: { tier: 'GREEN', static: true, description: '规划元工具（不做风控）' },
};

/** Look up the static policy for a tool. Throws `AppError('VALIDATION')` for an unknown tool. */
export function getToolPolicy(toolName: ToolName): ToolPolicy {
  const policy = TOOL_POLICY[toolName];
  if (!policy) throw new AppError('VALIDATION', `未知工具: ${toolName}`);
  return policy;
}

/**
 * Fully evaluate a tool call into its effective permission tier and flags.
 *
 * Rules:
 *  - `GREEN` → no confirmation, no MFA.
 *  - `YELLOW` → `requiresConfirmation: true`, no MFA.
 *  - `RED` → `requiresConfirmation: true`, `requiresMfa: true`.
 *  - `transfer_money` (dynamic) → delegates to `evaluateTransferRisk({ amount, dailyTransferTotal })`.
 *  - `submit_plan` → allow (no confirmation/MFA).
 *
 * The returned `tier`/flags depend ONLY on the policy table, the validated `amount`
 * derived from `args`, and `ctx.dailyTransferTotal` — never on model text.
 */
export function evaluateTool(
  toolName: ToolName,
  args: Record<string, unknown>,
  ctx: EvaluateToolContext,
): ToolEvaluation {
  const policy = getToolPolicy(toolName);

  // Dynamic tools (e.g. transfer_money): tier depends on the amount + day total.
  if (!policy.static) {
    const amount = normalizeTransferAmount(args.amount);
    const r = evaluateTransferRisk({ amount, dailyTransferTotal: ctx.dailyTransferTotal });
    return {
      tier: r.tier,
      requiresConfirmation: r.requiresConfirmation,
      requiresMfa: r.requiresMfa,
      reasons: r.reasons,
    };
  }

  // Static tools: tier is fixed by the policy table.
  const tier = policy.tier;
  return {
    tier,
    requiresConfirmation: tier !== 'GREEN',
    requiresMfa: tier === 'RED',
    reasons: [policy.description],
  };
}

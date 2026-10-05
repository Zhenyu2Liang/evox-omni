/**
 * agent/tools — per-user registry of registered banking tools (node facade).
 *
 * `createToolRegistry(userId)` builds the COMPLETE capability set the model may call: exactly the
 * 26 names of the frozen `ToolName` union (`@/lib/contracts/tools`), each backed by a family module.
 * Tools are bound to `userId` by closure — `userId` is SERVER-INJECTED and the model NEVER supplies
 * it. There is deliberately NO bash/shell/write/edit/file/SQL/system/http tool: an injection asking
 * for one has no tool to call.
 *
 * No permission/risk/MFA logic lives in this node. Every tool the model proposes passes through the
 * agent's `beforeToolCall` → `security.gateway.handleToolCall`; a gated tool is blocked and its
 * args persisted as a `PendingAction` until a human confirms (see parent `../CONTEXT.md`).
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { AppError } from '@/lib/errors';
import type { ToolName } from '@/lib/contracts/tools';
import type { RiskLevel } from '@/lib/contracts/risk';
import { createGetBalanceTool, runGetBalance } from './account';
import {
  createDetectAnomalyTool,
  createGetTransactionsTool,
  runDetectAnomaly,
  runGetTransactions,
} from './transaction';
import { createAnalyzeSpendingTool, runAnalyzeSpending } from './analysis';
import { createGetDashboardSummaryTool, runGetDashboardSummary } from './dashboard';
import { createSearchContactTool, runSearchContact } from './contact';
import {
  createApplyVirtualCardTool,
  createFreezeCardTool,
  createGetCardsTool,
  createReportLostCardTool,
  createSetCardLimitTool,
  createUnfreezeCardTool,
  runApplyVirtualCard,
  runFreezeCard,
  runGetCards,
  runReportLostCard,
  runSetCardLimit,
  runUnfreezeCard,
} from './card';
import {
  createCancelSubscriptionTool,
  createListSubscriptionsTool,
  createSetSubscriptionReminderTool,
  runCancelSubscription,
  runListSubscriptions,
  runSetSubscriptionReminder,
} from './subscription';
import {
  createCompareInvestmentsTool,
  createGetInvestmentHoldingsTool,
  createListInvestmentsTool,
  createRedeemInvestmentTool,
  createSubscribeInvestmentTool,
  runCompareInvestments,
  runGetInvestmentHoldings,
  runListInvestments,
  runRedeemInvestment,
  runSubscribeInvestment,
} from './investment';
import { createTransferMoneyTool, runTransferMoney } from './transfer';
import { createReserveBudgetTool, runReserveBudget } from './budget';
import {
  createCreateScheduledTaskTool,
  createListScheduledTasksTool,
  runCreateScheduledTask,
  runListScheduledTasks,
} from './task';
import { createChangePasswordTool, runChangePassword } from './security';
import {
  SubmitPlanParams,
  createSubmitPlanTool,
  runSubmitPlan,
  type SubmitPlanDeps,
} from './planning';

/** Uniform result of running a tool model-free (the `executeDirect` contract). */
export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  tier?: RiskLevel;
}

/**
 * Optional, ADDITIVE per-call options accepted by the model-free runners (`executeDirect`).
 *
 * Only `idempotencyKey` exists, and only a MONEY-MOVING tool (`transfer_money`) meaningfully reads
 * it: the Banking SDK derives the ledger row id deterministically from `(userId, key)` (via
 * `@/lib/ledger#idempotentTransferTxId`), so a repeat replays the original row instead of
 * double-debiting. Every other tool ignores the option. Omitting `opts` keeps the old behavior
 * exactly, so all existing two-argument call sites stay valid.
 */
export interface ToolRunOptions {
  /** At-most-once key for money movement; passed verbatim as the SDK's `idempotencyKey`. */
  idempotencyKey?: string;
}

/** A model-free runner for one tool: `(userId, args, opts?) => ToolExecutionResult` (never throws). */
type ToolRunner = (
  uid: string,
  args: Record<string, unknown>,
  opts?: ToolRunOptions,
) => Promise<ToolExecutionResult>;

/** The per-user tool registry exposed to the agent runtime. */
export interface ToolRegistry {
  /** Every registered tool, keyed by its exact `ToolName` (all 26). */
  tools: Record<ToolName, AgentTool<any>>;
  list(): AgentTool<any>[];
  get(name: ToolName): AgentTool<any>;
  /**
   * Gateway-authorized execution path: run a tool's args through the SDK WITHOUT the model.
   * `opts` is ADDITIVE/optional — only money-moving tools read `opts.idempotencyKey`.
   */
  executeDirect(
    name: ToolName,
    args: Record<string, unknown>,
    opts?: ToolRunOptions,
  ): Promise<ToolExecutionResult>;
}

/** Injection the agent supplies so the `submit_plan` meta-tool can run its DAG through the gateway. */
export interface CreateToolRegistryOptions {
  /** Required for a usable `submit_plan`; the agent binds its session + gateway-routed `runTool`. */
  submitPlan?: SubmitPlanDeps;
}

/** The exact, exhaustive set of registered tool names — equal to the frozen `ToolName` union (26). */
export const TOOL_NAMES: readonly ToolName[] = [
  // 🟢 GREEN — read-only
  'get_balance',
  'get_transactions',
  'search_contact',
  'analyze_spending',
  'detect_anomaly',
  'get_cards',
  'list_subscriptions',
  'list_investments',
  'compare_investments',
  'get_investment_holdings',
  'get_dashboard_summary',
  'list_scheduled_tasks',
  'reserve_budget',
  // 🟡 YELLOW — require confirmation
  'transfer_money',
  'set_card_limit',
  'cancel_subscription',
  'freeze_card',
  'apply_virtual_card',
  'set_subscription_reminder',
  'create_scheduled_task',
  // 🔴 RED — require MFA
  'subscribe_investment',
  'redeem_investment',
  'report_lost_card',
  'unfreeze_card',
  'change_password',
  // META — not risk-gated
  'submit_plan',
];

/** Error message surfaced when `submit_plan` is invoked without the injected deps. */
const SUBMIT_PLAN_UNCONFIGURED = 'submit_plan 未配置（缺少 sessionId/runTool 注入）';

/**
 * Placeholder `submit_plan` used when the agent did NOT supply `SubmitPlanDeps`. It keeps the
 * registry's `Record<ToolName, AgentTool>` structurally complete (a missing key is a compile
 * error) while making an actual call fail loudly instead of silently no-op'ing.
 */
function createUnconfiguredSubmitPlanTool(): AgentTool<typeof SubmitPlanParams> {
  return {
    name: 'submit_plan',
    label: '提交任务计划',
    description: '提交并执行一个由多个银行工具节点组成的任务计划（DAG）。当前未配置，调用会失败。',
    parameters: SubmitPlanParams,
    execute: async () => {
      throw new AppError('INTERNAL', SUBMIT_PLAN_UNCONFIGURED);
    },
  };
}

/**
 * Build the agent tools bound to `userId`.
 *
 *  - 25 SDK-backed tools come from the family modules' `create<Name>Tool(userId)` factories (each
 *    closers over the SERVER-INJECTED `userId`); `submit_plan` is built from the injected
 *    `opts.submitPlan` deps (or a failing placeholder when absent). `list()`/`get()` read the map.
 *  - `executeDirect(name, args, opts?)` dispatches to the matching family `run<X>(userId, args)`
 *    runner, and to `planning.runSubmitPlan(userId, args, opts.submitPlan)` for `submit_plan`. The
 *    optional `opts.idempotencyKey` is threaded to the tool's runner (only `transfer_money` consumes
 *    it — see `ToolRunOptions`).
 *
 * Signature note: the frozen form `createToolRegistry(userId: string): ToolRegistry` is preserved —
 * `opts` is an ADDITIVE optional parameter, needed only because `submit_plan` requires an injected
 * `sessionId` + gateway-routed `runTool` that the model cannot supply. One-argument calls remain valid.
 */
export function createToolRegistry(
  userId: string,
  opts?: CreateToolRegistryOptions,
): ToolRegistry {
  const submitPlanDeps = opts?.submitPlan;

  // `Record<ToolName, AgentTool>` is provably exhaustive: a missing tool name is a compile error.
  const tools: Record<ToolName, AgentTool<any>> = {
    // 🟢 GREEN — read-only
    get_balance: createGetBalanceTool(userId),
    get_transactions: createGetTransactionsTool(userId),
    search_contact: createSearchContactTool(userId),
    analyze_spending: createAnalyzeSpendingTool(userId),
    detect_anomaly: createDetectAnomalyTool(userId),
    get_cards: createGetCardsTool(userId),
    list_subscriptions: createListSubscriptionsTool(userId),
    list_investments: createListInvestmentsTool(userId),
    compare_investments: createCompareInvestmentsTool(userId),
    get_investment_holdings: createGetInvestmentHoldingsTool(userId),
    get_dashboard_summary: createGetDashboardSummaryTool(userId),
    list_scheduled_tasks: createListScheduledTasksTool(userId),
    reserve_budget: createReserveBudgetTool(userId),
    // 🟡 YELLOW — require confirmation (enforced by `security/`, not here)
    transfer_money: createTransferMoneyTool(userId),
    set_card_limit: createSetCardLimitTool(userId),
    cancel_subscription: createCancelSubscriptionTool(userId),
    freeze_card: createFreezeCardTool(userId),
    apply_virtual_card: createApplyVirtualCardTool(userId),
    set_subscription_reminder: createSetSubscriptionReminderTool(userId),
    create_scheduled_task: createCreateScheduledTaskTool(userId),
    // 🔴 RED — require MFA (enforced by `security/`, not here)
    subscribe_investment: createSubscribeInvestmentTool(userId),
    redeem_investment: createRedeemInvestmentTool(userId),
    report_lost_card: createReportLostCardTool(userId),
    unfreeze_card: createUnfreezeCardTool(userId),
    change_password: createChangePasswordTool(userId),
    // META — not risk-gated
    submit_plan: submitPlanDeps
      ? createSubmitPlanTool(userId, submitPlanDeps)
      : createUnconfiguredSubmitPlanTool(),
  };

  // Model-free runners: also exhaustive over `ToolName` (missing key ⇒ compile error). `userId` is
  // the closed-over one — it is NEVER read from `args`. Every runner may accept the optional `opts`
  // (only `transfer_money` reads `opts.idempotencyKey`; the rest ignore the extra argument).
  const runners: Record<ToolName, ToolRunner> = {
    get_balance: runGetBalance,
    get_transactions: runGetTransactions,
    search_contact: runSearchContact,
    analyze_spending: runAnalyzeSpending,
    detect_anomaly: runDetectAnomaly,
    get_cards: runGetCards,
    list_subscriptions: runListSubscriptions,
    list_investments: runListInvestments,
    compare_investments: runCompareInvestments,
    get_investment_holdings: runGetInvestmentHoldings,
    get_dashboard_summary: runGetDashboardSummary,
    list_scheduled_tasks: runListScheduledTasks,
    reserve_budget: runReserveBudget,
    transfer_money: runTransferMoney,
    set_card_limit: runSetCardLimit,
    cancel_subscription: runCancelSubscription,
    freeze_card: runFreezeCard,
    apply_virtual_card: runApplyVirtualCard,
    set_subscription_reminder: runSetSubscriptionReminder,
    create_scheduled_task: runCreateScheduledTask,
    subscribe_investment: runSubscribeInvestment,
    redeem_investment: runRedeemInvestment,
    report_lost_card: runReportLostCard,
    unfreeze_card: runUnfreezeCard,
    change_password: runChangePassword,
    submit_plan: async (uid, args) => {
      if (!submitPlanDeps) {
        return { ok: false, error: SUBMIT_PLAN_UNCONFIGURED };
      }
      return runSubmitPlan(uid, args, submitPlanDeps);
    },
  };

  return {
    tools,
    list(): AgentTool<any>[] {
      return TOOL_NAMES.map((name) => tools[name]);
    },
    get(name: ToolName): AgentTool<any> {
      return tools[name];
    },
    async executeDirect(
      name: ToolName,
      args: Record<string, unknown>,
      opts?: ToolRunOptions,
    ): Promise<ToolExecutionResult> {
      return runners[name](userId, args, opts);
    },
  };
}

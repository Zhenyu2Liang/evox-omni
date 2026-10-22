/**
 * agent/tools — per-user registry of registered banking tools (node facade).
 *
 * `createToolRegistry(userId)` builds the COMPLETE capability set the model may call: exactly the
 * enabled names from the `ToolName` catalog (`@/lib/contracts/tools`), each backed by a family module.
 * Tools are bound to `userId` by closure — `userId` is SERVER-INJECTED and the model NEVER supplies
 * it. There is deliberately NO bash/shell/write/edit/file/SQL/system/http tool: an injection asking
 * for one has no tool to call.
 *
 * No permission/risk/MFA logic lives in this node. Every tool the model proposes passes through the
 * agent's `beforeToolCall` → `security.gateway.handleToolCall`; a gated tool is blocked and its
 * args persisted as a `PendingAction` until a human confirms (see parent `../CONTEXT.md`).
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { AppError } from '@/lib/errors';
import { resolveBankingArgs } from '@/lib/banking-selectors';
import type { ExecutionFenceCheck } from '@/banking-sdk';
import { withBankingExecution, type BankingExecutionContext } from '@/banking-sdk';
import { buildWriteCommitAudit, type WriteAuditIdentity } from '../write-audit';
import { executeBankingCommand } from '../command-execution';
import { prepareBankingCommand } from '@/lib/contracts/command';
import { newId } from '@/lib/ids';
import { isWriteTool } from '@/security/permission-engine';
import type { ToolName } from '@/lib/contracts/tools';
import { AGENT_TOOL_NAMES as TOOL_NAMES, catalogEntry } from '@/lib/contracts/tool-catalog';
export { AGENT_TOOL_NAMES as TOOL_NAMES } from '@/lib/contracts/tool-catalog';
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
import { createSearchConversationHistoryTool, runSearchConversationHistory } from './conversation-history';
import {
  createApplyVirtualCardTool,
  createConsumeVirtualCardTool,
  createFreezeCardTool,
  createGetCardsTool,
  createReplaceCardTool,
  createReportLostCardTool,
  createSetCardLimitTool,
  createUnfreezeCardTool,
  runApplyVirtualCard,
  runConsumeVirtualCard,
  runFreezeCard,
  runGetCards,
  runReplaceCard,
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
import { modelToolError, toModelToolResult, toolFailure } from './result';
import { validateBankingParameters, validateSchemaParameters } from './plan-parameters';
import { isCatalogToolName } from '@/lib/contracts/tool-catalog';
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
  errorCode?: import('@/lib/errors').ErrorCode;
  errorDetails?: { candidates: Array<{ id?: string; name: string; phone?: string; bank?: string }> };
  tier?: RiskLevel;
}

/**
 * Optional, ADDITIVE per-call options accepted by the model-free runners (`executeDirect`).
 *
 * `idempotencyKey` is the at-most-once key for a side-effecting tool call. It is consumed by:
 *  - `transfer_money` — the Banking SDK derives the ledger row id deterministically from
 *    `(userId, key)` (via `@/lib/ledger#idempotentTransferTxId`), so a repeat replays the original
 *    row instead of double-debiting; and
 *  - the plan-node side-effect tools `reserve_budget` / `create_scheduled_task` /
 *    `subscribe_investment` / `redeem_investment` — the plan-node and
 *    confirmation paths pass `@/lib/ledger#nodeExecutionKey(taskId, nodeId)`, so a replay of the
 *    SAME `(plan, node)` dedupes its side effect instead of creating a duplicate row.
 * Tool effects use the execution identity and trusted context supplied by their caller.
 */
export interface ToolRunOptions {
  /** At-most-once key for a side-effecting call; passed verbatim to the SDK's `idempotencyKey`. */
  idempotencyKey?: string;
  /**
   * WRITE-BOUNDARY fence: an opaque async check the Banking SDK `await`s INSIDE its write transaction,
   * immediately before the business write through the trusted invocation context. Built by the
   * agent layer (`../execution-fence`) for a plan-node (GREEN inline) or confirm/verify execution; a
   * check that THROWS rolls the transaction back, so a write whose execution right was taken over /
   * cancelled commits NO side effect.
   */
  fence?: ExecutionFenceCheck;
  /** Required transfer audit, composed into the SDK's debit/ledger/receipt transaction. */
  onTransferCommit?: BankingExecutionContext['onTransferCommit'];
  onTransactionCommitted?: BankingExecutionContext['onTransactionCommitted'];
  onCommandCommit?: import('../command-execution').CommandExecutionOptions['onCommit'];
  /**
   * SIDE-EFFECT audit identity (see `../write-audit`): when supplied, the tool's business write and
   * its STRICT AuditLog row commit in the SAME `$transaction`, so an audit failure rolls the write
   * back. Auditing is decided by the WRITE, not by the permission colour — a GREEN write is audited
   * exactly like a gated action. ADDITIVE: absent ⇒ no change (a bare SDK call is not an agent write).
   */
  sessionId?: string;
  userRequest?: string;
  taskId?: string;
  nodeId?: string;
}

/** Builds the write-audit hook for `executeDirect` when the caller supplied a trusted audit identity. */
function writeAuditContext(
  name: ToolName,
  userId: string,
  opts?: ToolRunOptions,
): Partial<BankingExecutionContext> {
  if (opts?.sessionId === undefined) return {};
  const identity: WriteAuditIdentity = {
    sessionId: opts.sessionId,
    userRequest: opts.userRequest ?? '',
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
  };
  return { onWriteCommit: buildWriteCommitAudit(name, userId, identity) };
}

/** A model-free runner for one tool: `(userId, args, opts?) => ToolExecutionResult` (never throws). */
type ToolRunner = (
  uid: string,
  args: Record<string, unknown>,
  opts?: ToolRunOptions,
) => Promise<ToolExecutionResult>;

/** The per-user tool registry exposed to the agent runtime. */
export interface ToolRegistry {
  /** Every catalog entry, keyed by its exact `ToolName`; disabled entries are not exposed. */
  tools: Record<ToolName, AgentTool<any>>;
  list(): AgentTool<any>[];
  get(name: ToolName): AgentTool<any>;
  /**
   * Gateway-authorized execution path: run a tool's args through the SDK WITHOUT the model.
   * `opts` is ADDITIVE/optional — side-effecting tools read `opts.idempotencyKey` (see `ToolRunOptions`).
   */
  executeDirect(
    name: ToolName,
    args: Record<string, unknown>,
    opts?: ToolRunOptions,
  ): Promise<ToolExecutionResult>;
}

/** Injection the agent supplies so the `submit_plan` meta-tool can run its DAG through the gateway. */
export interface CreateToolRegistryOptions {
  /** Archive reads are bound to the same server-owned conversation as banking tools. */
  sessionId?: string;
  /** Trusted write-boundary check for Pi's automatic execution path, supplied by its session owner. */
  automaticWriteFence?: () => Promise<ExecutionFenceCheck>;
  /** Trusted write-audit identity for Pi's automatic execution path, supplied by its session owner. */
  automaticWriteAudit?: () => WriteAuditIdentity;
  operationIdentity?: (callId: string, name: ToolName, args: Record<string, unknown>) => Promise<string>;
  /** Required for a usable `submit_plan`; the agent binds its session + gateway-routed `runTool`. */
  submitPlan?: SubmitPlanDeps;
}

/** Error message surfaced when `submit_plan` is invoked without the injected deps. */
const SUBMIT_PLAN_UNCONFIGURED = 'The workflow executor has not been configured.';

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
 *  - Enabled SDK-backed tools come from the family modules' `create<Name>Tool(userId)` factories
 *    (each closes over the SERVER-INJECTED `userId`); `submit_plan` uses injected dependencies
 *    or a failing placeholder. Every entry is offered to the model — the risk tier (not the catalog)
 *    decides whether a call is gated.
 *  - `executeDirect(name, args, opts?)` dispatches to the matching family `run<X>(userId, args, opts)`
 *    runner, and to `planning.runSubmitPlan(userId, args, opts.submitPlan)` for `submit_plan`. The
 *    optional `opts.idempotencyKey` is threaded to every runner; the side-effecting tools consume it
 *    (`transfer_money`, `apply_virtual_card`, `consume_virtual_card`, `reserve_budget`, `create_scheduled_task`,
 *    `subscribe_investment`, `redeem_investment`) — see `ToolRunOptions`.
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
    search_conversation_history: createSearchConversationHistoryTool(userId, opts?.sessionId),
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
    apply_virtual_card: createApplyVirtualCardTool(userId),
    set_subscription_reminder: createSetSubscriptionReminderTool(userId),
    create_scheduled_task: createCreateScheduledTaskTool(userId),
    // 🔴 RED — require MFA (enforced by `security/`, not here)
    freeze_card: createFreezeCardTool(userId),
    consume_virtual_card: createConsumeVirtualCardTool(userId),
    subscribe_investment: createSubscribeInvestmentTool(userId),
    redeem_investment: createRedeemInvestmentTool(userId),
    report_lost_card: createReportLostCardTool(userId),
    unfreeze_card: createUnfreezeCardTool(userId),
    replace_card: createReplaceCardTool(userId),
    // META — not risk-gated
    submit_plan: submitPlanDeps
      ? createSubmitPlanTool(userId, submitPlanDeps)
      : createUnconfiguredSubmitPlanTool(),
  };

  // Model-free runners: also exhaustive over `ToolName` (missing key ⇒ compile error). `userId` is
  // the closed-over one — it is NEVER read from `args`. Every runner may accept the optional `opts`;
  // the side-effecting ones read `opts.idempotencyKey` (see `ToolRunOptions`), the rest ignore it.
  const runners: Record<ToolName, ToolRunner> = {
    get_balance: runGetBalance,
    get_transactions: runGetTransactions,
    search_contact: runSearchContact,
    search_conversation_history: (uid, args) => runSearchConversationHistory(uid, args, opts?.sessionId),
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
    consume_virtual_card: runConsumeVirtualCard,
    apply_virtual_card: runApplyVirtualCard,
    set_subscription_reminder: runSetSubscriptionReminder,
    create_scheduled_task: runCreateScheduledTask,
    subscribe_investment: runSubscribeInvestment,
    redeem_investment: runRedeemInvestment,
    report_lost_card: runReportLostCard,
    unfreeze_card: runUnfreezeCard,
    replace_card: runReplaceCard,
    submit_plan: async (uid, args) => {
      if (!submitPlanDeps) {
        return { ok: false, errorCode: 'INTERNAL', error: SUBMIT_PLAN_UNCONFIGURED };
      }
      return runSubmitPlan(uid, args, submitPlanDeps);
    },
  };

  const registry: ToolRegistry = {
    tools,
    list(): AgentTool<any>[] {
      return TOOL_NAMES.map((name) => tools[name]);
    },
    get(name: ToolName): AgentTool<any> {
      if (!isCatalogToolName(name)) throw new AppError('SECURITY_DENIED', 'This banking capability is unavailable.');
      if (catalogEntry(name)?.agentEnabled === false) throw new AppError('SECURITY_DENIED', 'Card creation and deletion require the card management page.');
      return tools[name];
    },
    async executeDirect(
      name: ToolName,
      args: Record<string, unknown>,
      opts?: ToolRunOptions,
    ): Promise<ToolExecutionResult> {
      if (!isCatalogToolName(name)) return toolFailure(new AppError('SECURITY_DENIED', 'This banking capability is unavailable.'));
      if (catalogEntry(name)?.agentEnabled === false) return { ok: false, errorCode: 'SECURITY_DENIED', error: 'Card creation and deletion require the card management page.' };
      try {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AppError('VALIDATION', 'Tool arguments must be an object.');
        const parameters = { ...args };
        if (name === 'submit_plan') validateSchemaParameters(name, parameters, 'direct', SubmitPlanParams);
        else validateBankingParameters(name, parameters, 'direct');
      } catch (error) { return toolFailure(error); }
      if (name === 'compare_investments') {
        try { args = await resolveBankingArgs(userId, name, args); }
        catch (error) { return toolFailure(error); }
      }
      const writeContext = writeAuditContext(name, userId, opts);
      let auditedInTransaction = false;
      const context: BankingExecutionContext = {
          sessionId: opts?.sessionId,
          fence: opts?.fence,
          onTransferCommit: opts?.onTransferCommit,
          onTransactionCommitted: opts?.onTransactionCommitted,
          ...(writeContext.onWriteCommit ? { onWriteCommit: async (client, event) => {
            await writeContext.onWriteCommit!(client, event);
            auditedInTransaction = true;
          } } : {}),
      };
      if (!isWriteTool(name)) {
        try { return await withBankingExecution(context, () => runners[name](userId, args, opts)); }
        catch (error) { return toolFailure(error); }
      }
      try {
        const command = prepareBankingCommand(userId, opts?.idempotencyKey ?? newId('operation'), name, args);
        return await executeBankingCommand(command, () => runners[name](userId, command.args, { ...opts, idempotencyKey: command.operationKey }), {
        context,
        onCommit: opts?.onCommandCommit ?? (context.onWriteCommit ? async (client, result) => {
          if (auditedInTransaction) return;
          await context.onWriteCommit!(client, {
          toolName: name, identity: command.operationKey, args: { ...command.args, userId }, data: result.data,
          });
        } : undefined),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  };
  // Runtime calls and human decisions use exactly the same command execution boundary.
  for (const name of TOOL_NAMES) {
    const definition = tools[name];
    const prepareArguments = (value: unknown) => {
      try {
        if (name === 'submit_plan') validateSchemaParameters(name, value as Record<string, unknown>, 'model', SubmitPlanParams);
        else validateBankingParameters(name, value as Record<string, unknown>, 'model');
      } catch (error) { throw new Error(modelToolError(error)); }
      return value;
    };
    if (name === 'submit_plan') { tools[name] = { ...definition, prepareArguments }; continue; }
    tools[name] = { ...definition, prepareArguments, execute: async (callId, params, signal) => {
      if (signal?.aborted) return toModelToolResult(toolFailure(new AppError('CONFLICT', 'The tool call was cancelled before execution.')));
      const args = params as Record<string, unknown>;
      const identity = opts?.automaticWriteAudit?.();
      const ownedFence = await opts?.automaticWriteFence?.();
      const result = await registry.executeDirect(name, args, {
        ...(isWriteTool(name) ? { idempotencyKey: await opts?.operationIdentity?.(callId, name, args) ?? newId('operation') } : {}),
        fence: async client => {
          if (signal?.aborted) throw new AppError('CONFLICT', 'The tool call was cancelled before committing.');
          await ownedFence?.(client);
        },
        ...identity,
      });
      return toModelToolResult(result);
    } };
  }
  return registry;
}

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
import type { ToolName } from '@/lib/contracts/tools';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { SubmitPlanDeps } from './planning';

/** Uniform result of running a tool model-free (the `executeDirect` contract). */
export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  tier?: RiskLevel;
}

/** The per-user tool registry exposed to the agent runtime. */
export interface ToolRegistry {
  /** Every registered tool, keyed by its exact `ToolName` (all 26). */
  tools: Record<ToolName, AgentTool<unknown>>;
  list(): AgentTool<unknown>[];
  get(name: ToolName): AgentTool<unknown>;
  /** Gateway-authorized execution path: run a tool's args through the SDK WITHOUT the model. */
  executeDirect(name: ToolName, args: Record<string, unknown>): Promise<ToolExecutionResult>;
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

/**
 * Build the agent tools bound to `userId`.
 *
 * Wiring (intended implementation):
 *  - 25 SDK-backed tools come from the family modules' `AgentTool` exports, assembled into
 *    `Record<ToolName, AgentTool>`; `list()`/`get()` read from it.
 *  - `executeDirect(name, args)` dispatches to the matching family `run<X>(userId, args)` runner,
 *    and to `planning.runSubmitPlan(userId, args, opts.submitPlan)` for `submit_plan` (which needs
 *    the injected `SubmitPlanDeps`).
 *
 * Signature note: the frozen form `createToolRegistry(userId: string): ToolRegistry` is preserved —
 * `opts` is an ADDITIVE optional parameter, needed only because `submit_plan` requires an injected
 * `sessionId` + gateway-routed `runTool` that the model cannot supply. One-argument calls remain valid.
 */
export function createToolRegistry(
  userId: string,
  opts?: CreateToolRegistryOptions,
): ToolRegistry {
  throw new Error('not implemented');
}

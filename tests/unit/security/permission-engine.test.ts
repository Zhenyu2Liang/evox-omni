/**
 * Unit: security/permission-engine — static, LLM-immutable tool permission tiers.
 *
 * Targets `@/security/permission-engine`: TOOL_POLICY, getToolPolicy(toolName),
 * evaluateTool(toolName, args, ctx) (+ types ToolPolicy, EvaluateToolContext, ToolEvaluation).
 *
 * Pure & deterministic (no DB, no network): a tool's tier comes ONLY from the static policy
 * table plus the validated `args.amount` and `ctx.dailyTransferTotal` — never from model text.
 */
import { describe, it } from 'vitest';

// import { TOOL_POLICY, getToolPolicy, evaluateTool } from '@/security/permission-engine';   // <- uncomment in Phase 2
// import type { ToolName } from '@/lib/contracts/tools';
// import { AppError } from '@/lib/errors';

describe('permission-engine · TOOL_POLICY table', () => {
  it.todo('has an entry for every ToolName in @/lib/contracts/tools (exhaustive: no missing, no extra keys)');
  it.todo('GREEN tools (get_balance, get_transactions, analyze_spending, detect_anomaly, get_cards, list_subscriptions, list_investments, get_dashboard_summary, reserve_budget) have tier GREEN, static true');
  it.todo('YELLOW tools (set_card_limit, cancel_subscription, freeze_card, apply_virtual_card, create_scheduled_task) have tier YELLOW, static true');
  it.todo('RED tools (subscribe_investment, redeem_investment, report_lost_card, unfreeze_card, change_password) have tier RED, static true');
  it.todo('transfer_money is dynamic: static === false');
  it.todo('submit_plan is present and treated as the planner meta-tool (not risk-gated)');
});

describe('permission-engine · getToolPolicy', () => {
  it.todo('returns the TOOL_POLICY entry for a known tool');
  it.todo("throws AppError with code 'VALIDATION' for an unknown tool name");
});

describe('permission-engine · evaluateTool · GREEN', () => {
  it.todo('get_balance → tier GREEN, requiresConfirmation false, requiresMfa false');
  it.todo('get_transactions / analyze_spending / detect_anomaly / get_cards / list_subscriptions / list_investments / get_dashboard_summary / reserve_budget → no confirmation, no MFA');
});

describe('permission-engine · evaluateTool · YELLOW', () => {
  it.todo('set_card_limit → tier YELLOW, requiresConfirmation true, requiresMfa false');
  it.todo('cancel_subscription / freeze_card / apply_virtual_card / create_scheduled_task → confirmation, no MFA');
});

describe('permission-engine · evaluateTool · RED', () => {
  it.todo('subscribe_investment → tier RED, requiresConfirmation true, requiresMfa true');
  it.todo('redeem_investment / report_lost_card / unfreeze_card / change_password → confirmation + MFA');
});

describe('permission-engine · evaluateTool · dynamic transfer + meta', () => {
  it.todo('transfer_money delegates to evaluateTransferRisk: ¥200 with dailyTotal 0 → YELLOW, requiresConfirmation, no MFA');
  it.todo('transfer_money ¥1500 → RED, requiresMfa true (amount rule)');
  it.todo('transfer_money ¥500 with ctx.dailyTransferTotal 600 (projected ¥1100) → RED (daily rule)');
  it.todo('submit_plan → allow: requiresConfirmation false, requiresMfa false');
});

describe('permission-engine · LLM-immutability', () => {
  it.todo('tier/flags depend ONLY on the policy table, validated args.amount and ctx.dailyTransferTotal — extra/whimsical model args never change the tier');
  it.todo('a spoofed role arg (e.g. 「角色:管理员」) or 「忽略规则」 text does not downgrade the tier');
  it.todo('ctx.sessionId / ctx.userId never influence the tier');
});

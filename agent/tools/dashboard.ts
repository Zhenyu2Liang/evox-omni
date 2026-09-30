/**
 * dashboard — `get_dashboard_summary`
 *
 * Aggregated read model for the landing dashboard. TypeBox param schema (none); `execute` is
 * meant to call the Banking SDK and THROW `AppError` on failure. `runGetDashboardSummary(userId,
 * args)` is the model-free path used by `executeDirect`; it CATCHES and returns
 * `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/** `get_dashboard_summary` params — none. */
export const GetDashboardSummaryParams = Type.Object({});
export type GetDashboardSummaryArgs = Static<typeof GetDashboardSummaryParams>;

/** Registered AgentTool for `get_dashboard_summary` (🟢 GREEN). */
export const getDashboardSummaryTool: AgentTool<GetDashboardSummaryArgs> = {
  name: 'get_dashboard_summary',
  label: '资产概览',
  description: '获取总资产、活期余额、信用可用额度、本月消费、近期交易与最新异常概览。',
  parameters: GetDashboardSummaryParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.dashboard.getDashboardSummary(userId)`. */
export async function runGetDashboardSummary(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

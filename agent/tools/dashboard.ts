/**
 * dashboard — `get_dashboard_summary`
 *
 * Aggregated read model for the landing dashboard. TypeBox param schema (none); `execute` calls the
 * Banking SDK and THROWS `AppError` on failure. `runGetDashboardSummary(userId, args)` is the
 * model-free path used by `executeDirect`; it CATCHES and returns
 * `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import type { DashboardSummary } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { formatCNY } from '@/lib/money';
import { formatDecimalCNY } from '@/lib/decimal';
import type { ToolExecutionResult } from './index';

/** `get_dashboard_summary` params — none. */
export const GetDashboardSummaryParams = Type.Object({});
export type GetDashboardSummaryArgs = Static<typeof GetDashboardSummaryParams>;

/** Factory: build the `get_dashboard_summary` AgentTool bound to `userId` (🟢 GREEN). */
export function createGetDashboardSummaryTool(
  userId: string,
): AgentTool<typeof GetDashboardSummaryParams> {
  return {
    name: 'get_dashboard_summary',
    label: '资产概览',
    description: '获取总资产、活期余额、信用可用额度、本月消费、近期交易与最新异常概览。',
    parameters: GetDashboardSummaryParams,
    execute: async () => {
      const result = await runGetDashboardSummary(userId, {});
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'get_dashboard_summary failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.dashboard.getDashboardSummary(userId)`. */
export async function runGetDashboardSummary(
  userId: string,
  _args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const summary = await banking.dashboard.getDashboardSummary(userId);
    return { ok: true, data: summary, summary: summarizeDashboard(summary) };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

/** Concise Chinese summary of a dashboard read (the text the model narrates). */
function summarizeDashboard(summary: DashboardSummary): string {
  const parts = [
    `Estimated total assets ${formatDecimalCNY(summary.totalAssets)}`,
    `活期 ${formatCNY(summary.checkingBalance)}`,
    `信用可用 ${formatCNY(summary.creditAvailable)}`,
    `${summary.month} \u5df2\u5165\u8d26\u6d88\u8d39\uff08\u4e0d\u542b\u6295\u8d44\uff09${formatCNY(summary.monthSpend)}`,
    `近期交易 ${summary.recentTransactions.length} 笔`,
  ];
  if (summary.latestAnomaly !== null) {
    const anomaly = summary.latestAnomaly.transaction;
    parts.push(`最新异常 ${anomaly.merchant} ${formatCNY(anomaly.amount)}（${summary.latestAnomaly.severity}）`);
  }
  return `${parts.join('，')}。`;
}

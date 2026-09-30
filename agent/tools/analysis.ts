/**
 * analysis — `analyze_spending`
 *
 * Spending analysis over a month window. TypeBox param schema; `execute` is meant to call the
 * Banking SDK and THROW `AppError` on failure. `runAnalyzeSpending(userId, args)` is the
 * model-free path used by `executeDirect`; it CATCHES and returns `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/** `analyze_spending` params — `YYYY-MM` window (SDK `SpendingQuery`); defaults to current month. */
export const AnalyzeSpendingParams = Type.Object({
  month: Type.Optional(Type.String({ description: '分析月份 YYYY-MM，默认本月' })),
});
export type AnalyzeSpendingArgs = Static<typeof AnalyzeSpendingParams>;

/** Registered AgentTool for `analyze_spending` (🟢 GREEN). */
export const analyzeSpendingTool: AgentTool<AnalyzeSpendingArgs> = {
  name: 'analyze_spending',
  label: '消费分析',
  description: '分析指定月份消费：总额、环比、分类占比、最大单笔与月度趋势。',
  parameters: AnalyzeSpendingParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.transaction.analyzeSpending(userId, { month })`. */
export async function runAnalyzeSpending(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

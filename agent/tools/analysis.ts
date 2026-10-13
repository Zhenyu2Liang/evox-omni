/**
 * analysis — `analyze_spending`
 *
 * Spending analysis over a month window. TypeBox param schema; `execute` calls the Banking SDK and
 * THROWS `AppError` on failure. `runAnalyzeSpending(userId, args)` is the model-free path used by
 * `executeDirect`; it CATCHES and returns `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import type { SpendingAnalysis } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { AppError } from '@/lib/errors';
import { absoluteMinor, centsToMoney, formatCNY, moneyToCents } from '@/lib/money';
import { compareDecimal } from '@/lib/decimal';
import type { ToolExecutionResult } from './index';

/** `analyze_spending` params — `YYYY-MM` window (SDK `SpendingQuery`); defaults to current month. */
export const AnalyzeSpendingParams = Type.Object({
  month: Type.Optional(Type.String({ description: '分析月份 YYYY-MM，默认本月' })),
});
export type AnalyzeSpendingArgs = Static<typeof AnalyzeSpendingParams>;

/** Factory: build the `analyze_spending` AgentTool bound to `userId` (🟢 GREEN). */
export function createAnalyzeSpendingTool(userId: string): AgentTool<typeof AnalyzeSpendingParams> {
  return {
    name: 'analyze_spending',
    label: '消费分析',
    description: '分析指定月份消费：总额、环比、分类占比、最大单笔与月度趋势。',
    parameters: AnalyzeSpendingParams,
    execute: async (_toolCallId, params) => {
      const result = await runAnalyzeSpending(userId, { month: params.month });
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'analyze_spending failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.transaction.analyzeSpending(userId, { month })`. */
export async function runAnalyzeSpending(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const month = typeof args.month === 'string' && args.month.trim() !== '' ? args.month : undefined;
    const analysis = await banking.transaction.analyzeSpending(
      userId,
      month !== undefined ? { month } : {},
    );
    return { ok: true, data: analysis, summary: summarizeSpending(analysis) };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

/** Concise Chinese summary of a spending analysis (the text the model narrates). */
function summarizeSpending(analysis: SpendingAnalysis): string {
  const mom = compareDecimal(analysis.momChangePct, '0') > 0 ? `+${analysis.momChangePct}%` : `${analysis.momChangePct}%`;
  const parts = [`${analysis.month} \u5df2\u5165\u8d26\u6d88\u8d39\u5408\u8ba1 ${formatCNY(analysis.total)}\uff08\u4e0d\u542b\u6295\u8d44\u8d44\u91d1\u6d41\uff1b\u73af\u6bd4 ${mom}\uff09`];

  const topCategory = analysis.byCategory[0];
  if (topCategory !== undefined) {
    parts.push(`最大分类 ${topCategory.category} ${formatCNY(topCategory.amount)}（${topCategory.share}%）`);
  }
  if (analysis.topMerchant !== null) {
    parts.push(`最高商家 ${analysis.topMerchant.merchant} ${formatCNY(analysis.topMerchant.amount)}`);
  }
  if (analysis.largest !== null) {
    parts.push(
      `最大单笔 ${analysis.largest.merchant} ${formatCNY(centsToMoney(absoluteMinor(moneyToCents(analysis.largest.amount))))}` +
        `（${formatDateTime(analysis.largest.occurredAt)}）`,
    );
  }
  return `${parts.join('；')}。`;
}

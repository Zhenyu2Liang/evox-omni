/**
 * transaction — `get_transactions`, `detect_anomaly`
 *
 * Transaction reads and anomaly detection. TypeBox param schemas; `execute` calls the Banking SDK
 * and THROWS `AppError` on failure. The `run<X>(userId, args)` runners are the model-free path used
 * by `executeDirect`; they CATCH and return `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import { banking } from '@/banking-sdk';
import type { AnomalyReport, TransactionQuery, TransactionView } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { AppError } from '@/lib/errors';
import { formatCNY } from '@/lib/money';
import type { ToolExecutionResult } from './index';

/** `get_transactions` params — window/category/limit filter (SDK `TransactionQuery`). */
export const GetTransactionsParams = Type.Object({
  from: Type.Optional(Type.Number({ description: '起始时间（epoch ms，含）' })),
  to: Type.Optional(Type.Number({ description: '结束时间（epoch ms，含）' })),
  category: Type.Optional(Type.String({ description: '消费分类，如 餐饮/出行/购物/娱乐' })),
  limit: Type.Optional(Type.Integer({ description: '最多返回条数（最近优先）' })),
});
export type GetTransactionsArgs = Static<typeof GetTransactionsParams>;

/** Factory: build the `get_transactions` AgentTool bound to `userId` (🟢 GREEN). */
export function createGetTransactionsTool(userId: string): AgentTool<typeof GetTransactionsParams> {
  return {
    name: 'get_transactions',
    label: '查询交易',
    description: '查询当前用户交易流水，可按时间范围、分类过滤并限制条数。',
    parameters: GetTransactionsParams,
    execute: async (_toolCallId, params) => {
      const result = await runGetTransactions(userId, {
        from: params.from,
        to: params.to,
        category: params.category,
        limit: params.limit,
      });
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'get_transactions failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.transaction.listTransactions(userId, query)`. */
export async function runGetTransactions(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const rows = await banking.transaction.listTransactions(userId, toTransactionQuery(args));
    return { ok: true, data: rows, summary: summarizeTransactions(rows) };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

/** `detect_anomaly` params — none; scans the user's recent transactions. */
export const DetectAnomalyParams = Type.Object({});
export type DetectAnomalyArgs = Static<typeof DetectAnomalyParams>;

/** Factory: build the `detect_anomaly` AgentTool bound to `userId` (🟢 GREEN). */
export function createDetectAnomalyTool(userId: string): AgentTool<typeof DetectAnomalyParams> {
  return {
    name: 'detect_anomaly',
    label: '异常检测',
    description: '扫描近期交易，识别可疑/异常消费（如大额支出）并给出原因与严重级别。',
    parameters: DetectAnomalyParams,
    execute: async () => {
      const result = await runDetectAnomaly(userId, {});
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'detect_anomaly failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.transaction.detectAnomaly(userId)`. */
export async function runDetectAnomaly(
  userId: string,
  _args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const report = await banking.transaction.detectAnomaly(userId);
    return { ok: true, data: report, summary: summarizeAnomalies(report) };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

/* ------------------------------------------------------------------ helpers */

/** Narrows a model-supplied filter value to a finite number (ignores anything else). */
function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Narrows a model-supplied filter value to a non-empty string (ignores anything else). */
function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Builds the SDK `TransactionQuery` from the (schema-validated) tool args; `userId` is never read. */
function toTransactionQuery(args: Record<string, unknown>): TransactionQuery {
  const query: TransactionQuery = {};
  const from = pickNumber(args.from);
  const to = pickNumber(args.to);
  const category = pickString(args.category);
  const limit = pickNumber(args.limit);
  if (from !== undefined) query.from = from;
  if (to !== undefined) query.to = to;
  if (category !== undefined) query.category = category;
  if (limit !== undefined) query.limit = limit;
  return query;
}

/** Concise Chinese summary of a transaction list (the text the model narrates). */
function summarizeTransactions(rows: TransactionView[]): string {
  if (rows.length === 0) return '未找到符合条件的交易。';
  const income = rows.filter((row) => row.amount > 0).reduce((acc, row) => acc + row.amount, 0);
  const expense = rows
    .filter((row) => row.amount < 0)
    .reduce((acc, row) => acc + Math.abs(row.amount), 0);
  const latest = rows[0];
  return (
    `共 ${rows.length} 笔交易：收入 ${formatCNY(income)}、支出 ${formatCNY(expense)}；` +
    `最近一笔为 ${latest.merchant} ${formatCNY(latest.amount)}（${formatDateTime(latest.occurredAt)}）。`
  );
}

/** Concise Chinese summary of an anomaly report (the text the model narrates). */
function summarizeAnomalies(report: AnomalyReport): string {
  if (report.anomalies.length === 0) {
    return `已扫描 ${report.scanned} 笔交易，未发现异常。`;
  }
  const head = report.anomalies
    .slice(0, 3)
    .map((item) => `${item.transaction.merchant} ${formatCNY(item.transaction.amount)}（${item.severity}）`)
    .join('、');
  const extra = report.anomalies.length > 3 ? `，另有 ${report.anomalies.length - 3} 笔` : '';
  return `已扫描 ${report.scanned} 笔交易，发现 ${report.anomalies.length} 笔异常：${head}${extra}。`;
}

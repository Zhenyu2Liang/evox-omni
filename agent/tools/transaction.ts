/**
 * transaction — `get_transactions`, `detect_anomaly`
 *
 * Transaction reads and anomaly detection. Runners return typed SDK results; factories use the
 * shared result adapter to expose complete public model data and Pi errors.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import type { AnomalyReport, TransactionView } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { addMoney, absoluteMinor, centsToMoney, formatCNY, moneyToCents } from '@/lib/money';
import type { ToolExecutionResult } from './index';
import { toModelToolResult, toolFailure } from './result';
import { MAX_DATE_TIMESTAMP, MAX_TRANSACTION_READ_LIMIT, validateTransactionQuery } from '@/banking-sdk/read-query';

/** `get_transactions` params — window/category/limit filter (SDK `TransactionQuery`). */
export const GetTransactionsParams = Type.Object({
  from: Type.Optional(Type.Integer({ minimum: -MAX_DATE_TIMESTAMP, maximum: MAX_DATE_TIMESTAMP, description: 'Start time in epoch milliseconds, inclusive.' })),
  to: Type.Optional(Type.Integer({ minimum: -MAX_DATE_TIMESTAMP, maximum: MAX_DATE_TIMESTAMP, description: 'End time in epoch milliseconds, exclusive.' })),
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'An exact spending category.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TRANSACTION_READ_LIMIT, description: 'Maximum returned rows, newest first. Defaults to 50. Totals describe only these returned rows.' })),
}, { additionalProperties: false });
export type GetTransactionsArgs = Static<typeof GetTransactionsParams>;

/** Factory: build the `get_transactions` AgentTool bound to `userId` (🟢 GREEN). */
export function createGetTransactionsTool(userId: string): AgentTool<typeof GetTransactionsParams> {
  return {
    name: 'get_transactions',
    label: '查询交易',
    description: 'Read owned transaction rows in a half-open time range [from, to), newest first. Returns at most 50 rows by default and 200 per call. Any totals cover returned rows only; use analyze_spending for complete monthly totals.',
    parameters: GetTransactionsParams,
    execute: async (_toolCallId, params) => toModelToolResult(await runGetTransactions(userId, params)),
  };
}

/** Model-free runner — `banking.transaction.listTransactions(userId, query)`. */
export async function runGetTransactions(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const query = validateTransactionQuery(args);
    const rows = await banking.transaction.listTransactions(userId, { ...query, limit: query.limit ?? 50 });
    return { ok: true, data: rows, summary: summarizeTransactions(rows) };
  } catch (e) {
    return toolFailure(e);
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
    description: 'Screen owned transactions for deterministic anomaly flags and return reasons, severity, acknowledgement, and owned cards. Flags are screening observations, not proof of fraud. This read does not freeze cards or acknowledge transactions.',
    parameters: DetectAnomalyParams,
    execute: async () => toModelToolResult(await runDetectAnomaly(userId, {})),
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
    return toolFailure(e);
  }
}

/* ------------------------------------------------------------------ helpers */

/** Concise Chinese summary of a transaction list (the text the model narrates). */
function summarizeTransactions(rows: TransactionView[]): string {
  if (rows.length === 0) return 'No transactions match the requested filters.';
  const income = rows.filter(row => moneyToCents(row.amount) > 0n)
    .reduce((sum, row) => addMoney(sum, row.amount), '0.00');
  const expense = rows
    .filter(row => moneyToCents(row.amount) < 0n)
    .reduce((sum, row) => addMoney(sum, centsToMoney(absoluteMinor(moneyToCents(row.amount)))), '0.00');
  const latest = rows[0];
  return (
    `Returned ${rows.length} newest transactions: income ${formatCNY(income)}, expense ${formatCNY(expense)}. ` +
    `These totals cover the returned rows only, not the entire requested period. ` +
    `The latest transaction is ${latest.merchant} ${formatCNY(latest.amount)} (${formatDateTime(latest.occurredAt)}).`
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

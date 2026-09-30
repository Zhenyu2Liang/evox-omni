/**
 * transaction — `get_transactions`, `detect_anomaly`
 *
 * Transaction reads and anomaly detection. TypeBox param schemas; `execute` is meant to call the
 * Banking SDK and THROW `AppError` on failure. The `run<X>(userId, args)` runners are the
 * model-free path used by `executeDirect`; they CATCH and return `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/** `get_transactions` params — window/category/limit filter (SDK `TransactionQuery`). */
export const GetTransactionsParams = Type.Object({
  from: Type.Optional(Type.Number({ description: '起始时间（epoch ms，含）' })),
  to: Type.Optional(Type.Number({ description: '结束时间（epoch ms，含）' })),
  category: Type.Optional(Type.String({ description: '消费分类，如 餐饮/出行/购物/娱乐' })),
  limit: Type.Optional(Type.Integer({ description: '最多返回条数（最近优先）' })),
});
export type GetTransactionsArgs = Static<typeof GetTransactionsParams>;

/** Registered AgentTool for `get_transactions` (🟢 GREEN). */
export const getTransactionsTool: AgentTool<GetTransactionsArgs> = {
  name: 'get_transactions',
  label: '查询交易',
  description: '查询当前用户交易流水，可按时间范围、分类过滤并限制条数。',
  parameters: GetTransactionsParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.transaction.listTransactions(userId, query)`. */
export async function runGetTransactions(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/** `detect_anomaly` params — none; scans the user's recent transactions. */
export const DetectAnomalyParams = Type.Object({});
export type DetectAnomalyArgs = Static<typeof DetectAnomalyParams>;

/** Registered AgentTool for `detect_anomaly` (🟢 GREEN). */
export const detectAnomalyTool: AgentTool<DetectAnomalyArgs> = {
  name: 'detect_anomaly',
  label: '异常检测',
  description: '扫描近期交易，识别可疑/异常消费（如大额支出）并给出原因与严重级别。',
  parameters: DetectAnomalyParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.transaction.detectAnomaly(userId)`. */
export async function runDetectAnomaly(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

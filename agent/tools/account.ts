/**
 * account — `get_balance`
 *
 * The registered banking tool the model may call for balance reads. Param schema is TypeBox
 * (`Type`/`Static` from `@earendil-works/pi-ai`). The runner returns a typed SDK result;
 * the factory uses the shared result adapter to expose complete public model data and Pi errors.
 *
 * Tier: 🟢 GREEN (read-only; auto-executes).
 * No permission/risk/MFA logic lives here — that is `security/`'s authority, enforced in the
 * agent's `beforeToolCall`. `userId` is SERVER-INJECTED via `createToolRegistry(userId)`; the
 * model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import type { BalanceView } from '@/banking-sdk';
import { formatCNY } from '@/lib/money';
import type { ToolExecutionResult } from './index';
import { toModelToolResult, toolFailure } from './result';

/** `get_balance` params — none; the account set is resolved from the server-injected `userId`. */
export const GetBalanceParams = Type.Object({});
export type GetBalanceArgs = Static<typeof GetBalanceParams>;

/** Factory: build the `get_balance` AgentTool bound to the server-injected `userId` (🟢 GREEN). */
export function createGetBalanceTool(userId: string): AgentTool<typeof GetBalanceParams> {
  return {
    name: 'get_balance',
    label: '查询余额',
    description: '查询当前用户各账户余额（活期/储蓄）与可用总额。',
    parameters: GetBalanceParams,
    execute: async () => toModelToolResult(await runGetBalance(userId, {})),
  };
}

/** Model-free runner — `banking.account.getBalance(userId)`. */
export async function runGetBalance(
  userId: string,
  _args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const balance = await banking.account.getBalance(userId);
    return { ok: true, data: balance, summary: summarizeBalance(balance) };
  } catch (e) {
    return toolFailure(e);
  }
}

/** Concise Chinese summary of a balance read (the text the model narrates). */
function summarizeBalance(balance: BalanceView): string {
  const total = formatCNY(balance.totalAvailable);
  if (balance.accounts.length === 0) {
    return `可用余额合计 ${total}，暂无账户。`;
  }
  const parts = balance.accounts.map((account) => `${account.name}（账户尾号 ${account.numberMasked}）${formatCNY(account.balance)}`);
  return `可用余额合计 ${total}，共 ${balance.accounts.length} 个账户：${parts.join('、')}。`;
}

/**
 * account — `get_balance`
 *
 * The registered banking tool the model may call for balance reads. Param schema is TypeBox
 * (`Type`/`Static` from `@mariozechner/pi-ai`); `execute` calls the Banking SDK and returns an
 * `AgentToolResult`, THROWING `AppError` (`@/lib/errors`) on failure. The plain
 * `runGetBalance(userId, args)` runner is the model-free path used by the registry's
 * `executeDirect` (the gateway-authorized execution path); it CATCHES and returns
 * `ToolExecutionResult{ok:false,error}` instead of throwing.
 *
 * Tier: 🟢 GREEN (read-only; auto-executes).
 * No permission/risk/MFA logic lives here — that is `security/`'s authority, enforced in the
 * agent's `beforeToolCall`. `userId` is SERVER-INJECTED via `createToolRegistry(userId)`; the
 * model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import { banking } from '@/banking-sdk';
import type { BalanceView } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { formatCNY } from '@/lib/money';
import type { ToolExecutionResult } from './index';

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
    execute: async () => {
      const result = await runGetBalance(userId, {});
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'get_balance failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
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
    return { ok: false, error: AppError.from(e).message };
  }
}

/** Concise Chinese summary of a balance read (the text the model narrates). */
function summarizeBalance(balance: BalanceView): string {
  const total = formatCNY(balance.totalAvailable);
  if (balance.accounts.length === 0) {
    return `可用余额合计 ${total}，暂无账户。`;
  }
  const parts = balance.accounts.map((account) => `${account.name} ${formatCNY(account.balance)}`);
  return `可用余额合计 ${total}，共 ${balance.accounts.length} 个账户：${parts.join('、')}。`;
}

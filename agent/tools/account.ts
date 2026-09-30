/**
 * account — `get_balance`
 *
 * The registered banking tool the model may call for balance reads. Param schema is TypeBox
 * (`Type`/`Static` from `@mariozechner/pi-ai`); `execute` is meant to call the Banking SDK and
 * return an `AgentToolResult`, THROWING `AppError` (`@/lib/errors`) on failure. The plain
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
import type { ToolExecutionResult } from './index';

/** `get_balance` params — none; the account set is resolved from the server-injected `userId`. */
export const GetBalanceParams = Type.Object({});
export type GetBalanceArgs = Static<typeof GetBalanceParams>;

/** Registered AgentTool for `get_balance` (🟢 GREEN). */
export const getBalanceTool: AgentTool<GetBalanceArgs> = {
  name: 'get_balance',
  label: '查询余额',
  description: '查询当前用户各账户余额（活期/储蓄）与可用总额。',
  parameters: GetBalanceParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.account.getBalance(userId)`. */
export async function runGetBalance(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

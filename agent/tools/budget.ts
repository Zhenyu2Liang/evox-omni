/**
 * budget — `reserve_budget`
 *
 * Reserve a budget envelope (e.g. "预留 ¥5000 下月房租"). TypeBox param schema; `execute` is
 * meant to call the Banking SDK and THROW `AppError` on failure. `runReserveBudget(userId, args)`
 * is the model-free path used by `executeDirect`; it CATCHES and returns
 * `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (per the frozen tool catalogue; does not move money out of an account).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/** `reserve_budget` params (SDK `ReserveBudgetInput` minus the server-injected `userId`). */
export const ReserveBudgetParams = Type.Object({
  name: Type.String({ description: '预算名称' }),
  amount: Type.Number({ description: '预留金额（CNY）' }),
  purpose: Type.Optional(Type.String({ description: '用途说明' })),
  dueDate: Type.Optional(Type.Number({ description: '到期时间（epoch ms）' })),
});
export type ReserveBudgetArgs = Static<typeof ReserveBudgetParams>;

/** Registered AgentTool for `reserve_budget` (🟢 GREEN). */
export const reserveBudgetTool: AgentTool<ReserveBudgetArgs> = {
  name: 'reserve_budget',
  label: '预留预算',
  description: '为一笔计划支出预留预算（名称、金额、用途、可选到期日）。',
  parameters: ReserveBudgetParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.budget.reserveBudget({ userId, name, amount, purpose, dueDate })`. */
export async function runReserveBudget(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

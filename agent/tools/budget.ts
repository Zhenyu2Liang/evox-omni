/**
 * budget — `reserve_budget`
 *
 * Reserve a budget envelope (e.g. "预留 ¥5000 下月房租"). TypeBox param schema; `execute` calls the
 * Banking SDK and returns native Pi success or failure content. `runReserveBudget(userId, args)` is the model-free
 * path used by `executeDirect`; it CATCHES and returns `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (per the frozen tool catalogue; does not move money out of an account).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { centsToMoney, formatCNY, moneyToCents } from '@/lib/money';
import type { ToolExecutionResult, ToolRunOptions } from './index';
import { MoneyParameter } from './money-schema';
import { toModelToolResult, toolFailure } from './result';

/** `reserve_budget` params (SDK `ReserveBudgetInput` minus the server-injected `userId`). */
export const ReserveBudgetParams = Type.Object({
  name: Type.String({ minLength: 1, description: 'Budget envelope name.' }),
  amount: MoneyParameter,
  purpose: Type.Optional(Type.String({ description: '用途说明' })),
  dueDate: Type.Optional(Type.Integer({ description: 'Due date as a valid UTC epoch in milliseconds.' })),
});
export type ReserveBudgetArgs = Static<typeof ReserveBudgetParams>;

/** Build the `reserve_budget` tool bound to `userId` (🟢 GREEN — auto-executes). */
export function createReserveBudgetTool(userId: string): AgentTool<typeof ReserveBudgetParams> {
  return {
    name: 'reserve_budget',
    label: '预留预算',
    description: 'Record a bookkeeping budget envelope with a name, amount and optional purpose or due date. This does not freeze, reserve or transfer account funds, and does not prove that money is available for the planned expense.',
    parameters: ReserveBudgetParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runReserveBudget(userId, params));
    },
  };
}

/** Model-free runner — `banking.budget.reserveBudget({ userId, name, amount, purpose, dueDate, idempotencyKey })`. */
export async function runReserveBudget(
  userId: string,
  args: Record<string, unknown>,
  opts?: ToolRunOptions,
): Promise<ToolExecutionResult> {
  const input = args as unknown as ReserveBudgetArgs;
  // Only the trusted gateway or plan node supplies an execution identity.
  const idempotencyKey = opts?.idempotencyKey;
  try {
    const sdkInput = {
      userId,
      name: input.name,
      amount: centsToMoney(moneyToCents(input.amount)),
      purpose: input.purpose,
      dueDate: input.dueDate,
      idempotencyKey,
    };
    const budget = await banking.budget.reserveBudget(sdkInput);
    const purpose = budget.purpose ? `，用途：${budget.purpose}` : '';
    const due = budget.dueDate ? `，到期：${formatDateTime(budget.dueDate)}` : '';
    return {
      ok: true,
      data: budget,
      summary: `已预留预算「${budget.name}」${formatCNY(budget.amount)}${purpose}${due}`,
    };
  } catch (e) {
    return toolFailure(e);
  }
}

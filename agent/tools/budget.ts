/**
 * budget — `reserve_budget`
 *
 * Reserve a budget envelope (e.g. "预留 ¥5000 下月房租"). TypeBox param schema; `execute` calls the
 * Banking SDK and THROWS `AppError` on failure. `runReserveBudget(userId, args)` is the model-free
 * path used by `executeDirect`; it CATCHES and returns `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (per the frozen tool catalogue; does not move money out of an account).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { AppError } from '@/lib/errors';
import { centsToMoney, formatCNY, moneyToCents } from '@/lib/money';
import type { ToolExecutionResult, ToolRunOptions } from './index';
import { MoneyParameter } from './money-schema';

/** `reserve_budget` params (SDK `ReserveBudgetInput` minus the server-injected `userId`). */
export const ReserveBudgetParams = Type.Object({
  name: Type.String({ description: '预算名称' }),
  amount: MoneyParameter,
  purpose: Type.Optional(Type.String({ description: '用途说明' })),
  dueDate: Type.Optional(Type.Number({ description: '到期时间（epoch ms）' })),
  idempotencyKey: Type.Optional(
    Type.String({ description: '幂等键：同一键的重复调用复用原记录（通常由服务端注入）' }),
  ),
});
export type ReserveBudgetArgs = Static<typeof ReserveBudgetParams>;

/** Build the `reserve_budget` tool bound to `userId` (🟢 GREEN — auto-executes). */
export function createReserveBudgetTool(userId: string): AgentTool<typeof ReserveBudgetParams> {
  return {
    name: 'reserve_budget',
    label: '预留预算',
    description: '为一笔计划支出预留预算（名称、金额、用途、可选到期日）。',
    parameters: ReserveBudgetParams,
    execute: async (_toolCallId, params) => {
      const result = await runReserveBudget(userId, params as Record<string, unknown>);
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? '预留预算失败');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '预留预算成功' }],
        details: result.data,
      };
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
  // At-most-once key: the SERVER-INJECTED `opts.idempotencyKey` (the gateway/plan-node path) wins;
  // a direct `args.idempotencyKey` is honoured otherwise. A replay of the SAME key reuses the row
  // (the SDK dedupes on it), so a repeated (plan, node) never double-creates a reservation.
  const idempotencyKey = opts?.idempotencyKey ?? input.idempotencyKey;
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
    return { ok: false, error: AppError.from(e).message };
  }
}

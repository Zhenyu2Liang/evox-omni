/**
 * transfer — `transfer_money`
 *
 * Money movement. TypeBox param schema; `execute` calls the Banking SDK and THROWS
 * `AppError` on failure. `runTransferMoney(userId, args)` is the model-free path used by
 * `executeDirect` (invoked ONLY after the gateway authorizes a confirmed action):
 * it CATCHES and returns `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: DYNAMIC — 🟡 YELLOW for ≤ ¥1000 and daily total ≤ ¥1000, 🔴 RED above; computed by
 * `security/`'s risk engine from the amount + daily total, NEVER here and NEVER by the model.
 * This module only declares capability. `userId` is SERVER-INJECTED; the model never supplies it.
 *
 * NOTE: the model's tool call is BLOCKED by `beforeToolCall` until a human confirms; the
 * confirmed AND validated original args are what reach `runTransferMoney` — never model text.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import { banking } from '@/banking-sdk';
import type { TransferResult } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { formatCNY } from '@/lib/money';
import type { ToolExecutionResult } from './index';

/** `transfer_money` params (SDK `TransferInput` minus the server-injected `userId`). */
export const TransferMoneyParams = Type.Object({
  contactId: Type.Optional(Type.String({ description: '收款联系人 id（优先）' })),
  phone: Type.Optional(Type.String({ description: '或按手机号指定收款人' })),
  name: Type.Optional(Type.String({ description: '或按姓名指定收款人（重名时报冲突）' })),
  amount: Type.Number({ description: '转账金额（正数，CNY）' }),
  remark: Type.Optional(Type.String({ description: '转账备注' })),
  sourceAccountId: Type.Optional(Type.String({ description: '付款账户；默认主活期账户' })),
});
export type TransferMoneyArgs = Static<typeof TransferMoneyParams>;

/**
 * Registered AgentTool for `transfer_money` (🟡/🔴 dynamic).
 *
 * `execute` runs only after a human confirmation, via the gateway-authorized path; the model
 * proposing this tool merely parks a `PendingAction`.
 */
export function createTransferMoneyTool(userId: string): AgentTool<typeof TransferMoneyParams> {
  return {
    name: 'transfer_money',
    label: '转账',
    description: '向联系人转账（金额/日累计决定风险等级，超过阈值需要验证码）。',
    parameters: TransferMoneyParams,
    execute: async (_toolCallId, params) => {
      const result = await runTransferMoney(userId, params);
      if (!result.ok) throw new AppError('TOOL_FAILED', result.error ?? 'transfer_money failed');
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.transfer.createTransfer({ userId, ... })`. */
export async function runTransferMoney(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const amount = args.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new AppError('VALIDATION', 'transfer_money 需要合法的 amount');
    }
    const result: TransferResult = await banking.transfer.createTransfer({
      userId,
      contactId: typeof args.contactId === 'string' ? args.contactId : undefined,
      phone: typeof args.phone === 'string' ? args.phone : undefined,
      name: typeof args.name === 'string' ? args.name : undefined,
      amount,
      remark: typeof args.remark === 'string' ? args.remark : undefined,
      sourceAccountId: typeof args.sourceAccountId === 'string' ? args.sourceAccountId : undefined,
    });
    const balance = result.newBalance != null ? `，账户余额 ${formatCNY(result.newBalance)}` : '';
    return {
      ok: true,
      data: result,
      summary: `已向 ${result.recipient.name} 转账 ${formatCNY(result.amount)}${balance}。`,
    };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

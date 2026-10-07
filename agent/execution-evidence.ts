import { banking } from '@/banking-sdk';
import { ledgerKeyForAction } from '@/lib/ledger';
import { safeParse } from '@/lib/json';
import type { ToolExecutionResult } from './tools';
import { formatCNY } from '@/lib/money';

export interface ExecutionEvidenceAction {
  id: string;
  userId: string;
  taskId: string | null;
  nodeId: string | null;
  toolName: string;
  argsJson: string;
}

/** Query both receipts and pre-receipt ledgers through the SDK's request-identity verifier. */
export async function committedExecutionResult(action: ExecutionEvidenceAction): Promise<ToolExecutionResult | undefined> {
  if (action.toolName !== 'transfer_money') return undefined;
  const args = safeParse<Record<string, unknown>>(action.argsJson, {});
  const text = (key: string) => typeof args[key] === 'string' ? args[key] as string : undefined;
  const result = await banking.transfer.getCommittedTransfer({
    userId: action.userId, idempotencyKey: ledgerKeyForAction(action), amount: args.amount as number,
    name: text('name'), contactId: text('contactId'), phone: text('phone'),
    sourceAccountId: text('sourceAccountId'), remark: text('remark'),
  });
  if (result === null) return undefined;
  const balance = result.newBalance === undefined ? '' : `，账户余额 ${formatCNY(result.newBalance)}`;
  return { ok: true, data: result, summary: `已向 ${result.recipient.name} 转账 ${formatCNY(result.amount)}${balance}。` };
}

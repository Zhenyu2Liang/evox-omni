import { banking } from '@/banking-sdk';
import { ledgerKeyForAction } from '@/lib/ledger';
import { safeParse } from '@/lib/json';
import type { ToolExecutionResult } from './tools';
import { formatCNY } from '@/lib/money';
import { prepareBankingCommand } from '@/lib/contracts/command';
import { readCommandReceipt } from './command-execution';
import type { ToolName } from '@/lib/contracts/tools';

export interface ExecutionEvidenceAction {
  id: string;
  userId: string;
  taskId: string | null;
  nodeId: string | null;
  toolName: string;
  argsJson: string;
}

/** Query current command receipts and direct SDK receipts without reconstructing missing results. */
export async function committedExecutionResult(action: ExecutionEvidenceAction): Promise<ToolExecutionResult | undefined> {
  const args = safeParse<Record<string, unknown>>(action.argsJson, {});
  const committed = await readCommandReceipt(prepareBankingCommand(action.userId, ledgerKeyForAction(action), action.toolName as ToolName, args));
  if (committed) return committed;
  if (action.toolName !== 'transfer_money') return undefined;
  const text = (key: string) => typeof args[key] === 'string' ? args[key] as string : undefined;
  const result = await banking.transfer.getCommittedTransfer({
    userId: action.userId, idempotencyKey: ledgerKeyForAction(action), amount: args.amount as string,
    name: text('name'), contactId: text('contactId'), phone: text('phone'),
    sourceAccountId: text('sourceAccountId'), remark: text('remark'),
  });
  if (result === null) return undefined;
  return { ok: true, data: result, summary: `Transferred ${formatCNY(result.amount)} to ${result.recipient.name}. Account balance: ${formatCNY(result.newBalance)}.` };
}

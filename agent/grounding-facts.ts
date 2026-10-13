import { addMoney, subtractMoney, moneyToCents, centsToMoney, type MoneyAmount } from '@/lib/money';
import { financialOperationKey } from './financial-operation-key';
import type { ToolExecutionResult } from './tools';

export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'transfer_money', 'reserve_budget', 'set_card_limit', 'cancel_subscription', 'freeze_card',
  'apply_virtual_card', 'set_subscription_reminder', 'create_scheduled_task', 'subscribe_investment',
  'redeem_investment', 'report_lost_card', 'unfreeze_card', 'change_password',
]);

export interface TrustedAccount {
  id?: string;
  name?: string;
  type?: string;
  balance: MoneyAmount;
  balanceKnown?: boolean;
}
export interface TrustedRecipient { name?: string; contactId?: string; phone?: string }
export type TrustedWriteOutcome = 'succeeded' | 'failed' | 'unknown';
export interface TrustedWrite {
  toolName: string;
  outcome: TrustedWriteOutcome;
  toolCallId?: string;
  actionId?: string;
  taskId?: string;
  nodeId?: string;
  amount?: MoneyAmount;
  recipient?: TrustedRecipient;
  balanceAfter?: MoneyAmount;
  accountId?: string;
  summary?: string;
  error?: string;
}
export interface FinancialFacts {
  accounts: TrustedAccount[];
  currentBalances: TrustedAccount[];
  balances: MoneyAmount[];
  totalBalance?: MoneyAmount;
  writes: TrustedWrite[];
  hasToolResults: boolean;
}
export interface FactInput {
  toolName: string;
  result: ToolExecutionResult;
  toolCallId?: string;
  actionId?: string;
  taskId?: string;
  nodeId?: string;
  sourceAccountId?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function amount(value: unknown): MoneyAmount | undefined {
  try { return centsToMoney(moneyToCents(value)); } catch { return; }
}

function trustedWrite(entry: FactInput): TrustedWrite {
  const { toolName, result } = entry;
  const data = isRecord(result.data) ? result.data : {};
  const unknown = data.outcome === 'unknown' || data.needsReconciliation === true || data.status === 'needs_reconciliation' ||
    /人工核对|无法核实|待核对|needs reconciliation/i.test(`${result.error ?? ''} ${result.summary ?? ''}`);
  const recipient = isRecord(data.recipient) ? data.recipient : undefined;
  const identity = (key: 'toolCallId' | 'actionId' | 'taskId' | 'nodeId') => entry[key] ? { [key]: entry[key] } : {};
  return {
    toolName, outcome: unknown ? 'unknown' : result.ok ? 'succeeded' : 'failed',
    ...identity('toolCallId'), ...identity('actionId'), ...identity('taskId'), ...identity('nodeId'),
    amount: amount(data.amount), balanceAfter: amount(data.newBalance),
    accountId: entry.sourceAccountId ?? (typeof data.sourceAccountId === 'string' ? data.sourceAccountId : undefined),
    recipient: recipient ? { name: typeof recipient.name === 'string' ? recipient.name : undefined,
      contactId: typeof recipient.contactId === 'string' ? recipient.contactId : undefined,
      phone: typeof recipient.phone === 'string' ? recipient.phone : undefined } : undefined,
    summary: result.summary, error: result.error,
  };
}

/** Server result projection uses exact decimal values and immutable operation identities. */
export function buildFinancialFacts(entries: readonly FactInput[]): FinancialFacts {
  const accounts: TrustedAccount[] = [];
  const current = new Map<string, TrustedAccount>();
  const balances: MoneyAmount[] = [];
  const writes: TrustedWrite[] = [];
  const byOperation = new Map<string, TrustedWrite>();
  let totalBalance: MoneyAmount | undefined;
  for (const entry of entries) {
    const data = isRecord(entry.result.data) ? entry.result.data : {};
    if (entry.toolName === 'get_balance' && entry.result.ok) {
      totalBalance = amount(data.totalAvailable);
      for (const raw of Array.isArray(data.accounts) ? data.accounts : []) {
        if (!isRecord(raw)) continue;
        const balance = amount(raw.balance);
        if (balance === undefined) continue;
        const account: TrustedAccount = { balance,
          id: typeof raw.id === 'string' ? raw.id : undefined,
          name: typeof raw.name === 'string' ? raw.name : undefined,
          type: typeof raw.type === 'string' ? raw.type : undefined };
        accounts.push(account); balances.push(balance);
        current.set(account.id ?? `${account.name}|${account.type}`, { ...account });
      }
    }
    if (entry.toolName === 'get_dashboard_summary' && entry.result.ok) {
      for (const key of ['checkingBalance', 'totalAssets', 'creditAvailable']) {
        const value = amount(data[key]); if (value !== undefined) balances.push(value);
      }
    }
    if (!SIDE_EFFECT_TOOLS.has(entry.toolName)) continue;
    const write = trustedWrite(entry);
    const key = financialOperationKey(entry);
    const previous = key ? byOperation.get(key) : undefined;
    if (previous?.outcome === 'succeeded') continue;
    if (previous) writes.splice(writes.indexOf(previous), 1);
    writes.push(write); if (key) byOperation.set(key, write);
    const candidates = [...current.values()];
    const checking = candidates.filter(account => account.type === 'CHECKING');
    const target = write.accountId ? candidates.find(account => account.id === write.accountId)
      : checking.length === 1 ? checking[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (write.outcome === 'succeeded' && write.balanceAfter !== undefined) {
      if (target) {
        totalBalance = totalBalance !== undefined && target.balanceKnown !== false
          ? addMoney(totalBalance, subtractMoney(write.balanceAfter, target.balance)) : undefined;
        target.balance = write.balanceAfter; target.balanceKnown = undefined;
      } else totalBalance = undefined;
    } else if (['transfer_money', 'subscribe_investment', 'redeem_investment'].includes(entry.toolName) && write.outcome !== 'failed') {
      for (const account of target ? [target] : candidates) account.balanceKnown = false;
      totalBalance = undefined;
    }
  }
  return { accounts, currentBalances: [...current.values()], balances, totalBalance, writes, hasToolResults: entries.length > 0 };
}

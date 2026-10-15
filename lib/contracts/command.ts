import type { ToolName } from './tools';
import { moneyToCents, centsToMoney } from '../money';
import { requestDigest } from '../ledger';

export interface BankingCommand {
  userId: string;
  operationKey: string;
  toolName: ToolName | import('./card-management').ManualCardCommandName;
  args: Record<string, unknown>;
  digest: string;
}

const MONETARY_FIELDS = new Set(['amount', 'creditLimit', 'monthlyLimit', 'expectedRedemptionAmount', 'redeemAmount']);

/** Equivalent decimal inputs have one identity; presentation text never grants authority. */
export function canonicalCommandArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'idempotencyKey').map(([key, value]) => {
    if (MONETARY_FIELDS.has(key) && value !== undefined && value !== null) return [key, centsToMoney(moneyToCents(value))];
    if (value && typeof value === 'object' && !Array.isArray(value)) return [key, canonicalCommandArgs(value as Record<string, unknown>)];
    return [key, value];
  }));
}

export function prepareBankingCommand(userId: string, operationKey: string, toolName: ToolName, args: Record<string, unknown>): BankingCommand {
  const normalized = canonicalCommandArgs(args);
  return { userId, operationKey, toolName, args: normalized,
    digest: requestDigest({ version: 1, userId, toolName, args: normalized }) };
}

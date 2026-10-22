import type { ToolName } from './tools';
import { moneyToCents, centsToMoney } from '../money';
import { nonNegativeDecimal } from '../decimal';
import { requestDigest } from '../ledger';

export interface BankingCommand {
  userId: string;
  operationKey: string;
  toolName: ToolName | import('./card-management').ManualCardCommandName;
  args: Record<string, unknown>;
  digest: string;
}

/** Booked money arguments: normalized to one canonical cent text before they can grant authority. */
const MONETARY_FIELDS = new Set([
  'amount', 'creditLimit', 'monthlyLimit', 'expectedSettlementAmount',
]);

/**
 * 「净值 + 份额」 arguments (`docs/cn/investments.md`): the redemption口径 (`shares`) and the
 * server-snapshotted confirmation (`expectedShares` / `expectedNetValue`) are exact decimal text, so
 * `'1.50'` and `'1.5'` are ONE identity — while ANY change of value changes the digest, which is what
 * invalidates the old authorization.
 */
const DECIMAL_FIELDS = new Set(['shares', 'expectedShares', 'expectedNetValue']);

/** Equivalent decimal inputs have one identity; presentation text never grants authority. */
export function canonicalCommandArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'idempotencyKey').map(([key, value]) => {
    if (MONETARY_FIELDS.has(key) && value !== undefined && value !== null) return [key, centsToMoney(moneyToCents(value))];
    if (DECIMAL_FIELDS.has(key) && typeof value === 'string') return [key, nonNegativeDecimal(value)];
    if (value && typeof value === 'object' && !Array.isArray(value)) return [key, canonicalCommandArgs(value as Record<string, unknown>)];
    return [key, value];
  }));
}

export function prepareBankingCommand(userId: string, operationKey: string, toolName: ToolName, args: Record<string, unknown>): BankingCommand {
  const normalized = canonicalCommandArgs(args);
  return { userId, operationKey, toolName, args: normalized,
    digest: requestDigest({ version: 1, userId, toolName, args: normalized }) };
}

/**
 * Risk Engine — the DYNAMIC half of the security policy.
 *
 * Computes runtime risk that cannot be expressed in a static table: the transfer
 * tier depends on the amount AND the day's running transfer total. All inputs are
 * explicit (the caller passes `dailyTransferTotal`; `now` is injectable) so evaluation
 * is deterministic and unit-testable without a network or clock.
 */
import type { RiskLevel } from '../lib/contracts/risk';
import { DAILY_TRANSFER_LIMIT } from '../lib/constants';
import { sumOutgoingTransfersSince } from '../lib/db/repositories/transaction';

export interface TransferRiskInput {
  /** Requested transfer amount in CNY (already validated/normalized by the caller). */
  amount: number;
  /** Sum of today's outgoing transfers BEFORE this request (excludes `amount`). */
  dailyTransferTotal: number;
}

export interface TransferRiskResult {
  /** `YELLOW` for a small transfer, `RED` when a threshold is crossed. */
  tier: RiskLevel;
  /** Always `true` for transfers. */
  requiresConfirmation: boolean;
  /** `true` iff `tier === 'RED'`. */
  requiresMfa: boolean;
  reasons: string[];
  amount: number;
  /** `dailyTransferTotal` passed in. */
  dailyTotal: number;
  /** `dailyTransferTotal + amount` — the projected day total used for the rule. */
  projectedDailyTotal: number;
}

/**
 * Evaluate the dynamic transfer tier.
 * RED iff `amount > DAILY_TRANSFER_LIMIT` OR `dailyTransferTotal + amount > DAILY_TRANSFER_LIMIT`;
 * otherwise YELLOW. Transfers ALWAYS require user confirmation.
 */
export function evaluateTransferRisk(input: TransferRiskInput): TransferRiskResult {
  throw new Error('not implemented');
}

/**
 * Sum `userId`'s outgoing transfers for the calendar day containing `now`
 * (defaults to `Date.now()`) via the transaction repository.
 * `now` is injected so tests are deterministic.
 */
export async function computeDailyTransferTotal(userId: string, now?: number): Promise<number> {
  throw new Error('not implemented');
}

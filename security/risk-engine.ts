/**
 * Risk Engine — the DYNAMIC half of the security policy.
 *
 * Computes runtime risk that cannot be expressed in a static table: the transfer
 * tier depends on the amount AND the day's running transfer total. All inputs are
 * explicit (the caller passes `dailyTransferTotal`; `now` is injectable) so evaluation
 * is deterministic and unit-testable without a network or clock.
 */
import type { Prisma } from '@prisma/client';
import type { RiskLevel } from '../lib/contracts/risk';
import { DAILY_TRANSFER_LIMIT } from '../lib/constants';
import { demoNow } from '../lib/clock';
import { startOfDay } from '../lib/date';
import { formatCNY, parseAmount } from '../lib/money';
import { safeParse } from '../lib/json';
import { prisma } from '../lib/db/client';
import { listTransactions } from '../lib/db/repositories/transaction';

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
  const { amount, dailyTransferTotal } = input;
  const projectedDailyTotal = dailyTransferTotal + amount;

  // STRICT `>`: an amount of exactly the limit (or a projected total of exactly the limit) stays YELLOW.
  const amountOverLimit = amount > DAILY_TRANSFER_LIMIT;
  const dailyOverLimit = projectedDailyTotal > DAILY_TRANSFER_LIMIT;
  const red = amountOverLimit || dailyOverLimit;

  const reasons: string[] = [];
  if (red) {
    if (amountOverLimit) {
      reasons.push(
        `转账金额 ${formatCNY(amount)} 超过单笔限额 ${formatCNY(DAILY_TRANSFER_LIMIT)}，需强验证`,
      );
    }
    if (dailyOverLimit) {
      reasons.push(
        `今日累计转账将达到 ${formatCNY(projectedDailyTotal)}，超过日累计限额 ${formatCNY(DAILY_TRANSFER_LIMIT)}，需强验证`,
      );
    }
  } else {
    reasons.push(
      `转账金额 ${formatCNY(amount)} 未超过限额（单笔/日累计均为 ${formatCNY(DAILY_TRANSFER_LIMIT)}），属中等风险，需确认`,
    );
  }

  return {
    tier: red ? 'RED' : 'YELLOW',
    requiresConfirmation: true,
    requiresMfa: red,
    reasons,
    amount,
    dailyTotal: dailyTransferTotal,
    projectedDailyTotal,
  };
}

/**
 * Sum `userId`'s outgoing transfer debits for the calendar day containing `now`
 * (defaults to the DEMO clock), via the transaction repository.
 *
 * The window is `[startOfDay(now), now]` — INCLUSIVE at BOTH ends: a transfer only
 * counts as "today's" if it has already happened (`occurredAt <= now`), so FUTURE-dated
 * rows are excluded. `listTransactions`'s range is half-open (`occurredAt < to`), so the
 * upper bound is passed as `now + 1 ms`, which is inclusive at millisecond precision.
 * `now` is injected so tests are deterministic.
 */
export async function computeDailyTransferTotal(userId: string, now?: number): Promise<number> {
  const nowMs = demoNow(now);
  const start = startOfDay(new Date(nowMs)).getTime();
  const rows = await listTransactions({
    userId,
    from: new Date(start),
    to: new Date(nowMs + 1), // half-open [start, now + 1) === [start, now] inclusive (ms precision)
    channel: 'TRANSFER',
    direction: 'DEBIT',
  });
  // DEBIT amounts are stored negative; the repository call this replaced returned the ABSOLUTE total.
  return rows.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
}

/**
 * Execution-time re-evaluation of a transfer's risk against a FRESH day total.
 *
 * WHY THIS EXISTS: multiple YELLOW transfers can be parked (each blocked pending user
 * confirmation) at different moments. Each is validated at PARK time against the day total as it
 * was THEN. Because none of them has executed yet, every parked transfer sees the same stale
 * total — so N parked transfers of ¥500 each are each individually YELLOW, yet collectively they
 * exceed the ¥1000 daily limit at EXECUTION time and must escalate to RED (MFA). Evaluating only
 * at park time therefore lets repeated small transfers bypass the RED/MFA threshold.
 *
 * This helper RE-COMPUTES the day's outgoing-transfer total FRESH (`computeDailyTransferTotal`)
 * at execution time and re-runs `evaluateTransferRisk` on it, so the confirmation/execution path
 * (to be wired later in the agent/app layer) can enforce RED/MFA against the real running total.
 * It returns the same {@link TransferRiskResult} shape (`tier` / `requiresMfa` / `dailyTotal` /
 * `projectedDailyTotal`). `now` is injectable (defaults to the demo clock) for determinism.
 */
export async function reEvaluateTransferRisk(
  userId: string,
  amount: number,
  now?: number,
): Promise<TransferRiskResult> {
  const dailyTotal = await computeDailyTransferTotal(userId, now);
  return evaluateTransferRisk({ amount, dailyTransferTotal: dailyTotal });
}

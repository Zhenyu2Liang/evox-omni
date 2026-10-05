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
import { idempotentTransferTxId } from '../lib/ledger';

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
 * A Prisma surface that can be EITHER the shared client or a transaction client. Both
 * expose `transaction` / `pendingAction`, so the aggregate helpers below run unchanged
 * inside (`$transaction`) and outside a transaction.
 */
export type PrismaLike = Prisma.TransactionClient | typeof prisma;

/**
 * Statuses of a parked `transfer_money` that has ALREADY been authorized (its claim is
 * committed) but has not necessarily been written to the ledger yet. `confirmed` is the
 * only settled/authorized status in `PendingActionStatus`; `executing` is included
 * defensively so an explicit in-flight marker (if the contract ever adds one) is covered.
 */
const IN_FLIGHT_TRANSFER_STATUSES = ['confirmed', 'executing'] as const;

/**
 * Sum the amounts of `userId`'s IN-FLIGHT (authorized-but-not-yet-ledgered) parked
 * `transfer_money` PendingActions, using the caller's Prisma surface (client OR tx) so it
 * can run inside a transaction. `excludeActionId` drops the action currently being
 * evaluated (its own amount is passed separately to `evaluateTransferRisk`).
 *
 * DEDUP vs the LEDGER: an action can be authorized (status `confirmed`) while its ledger
 * `Transaction` row ALREADY exists — the Banking SDK writes that row deterministically keyed by
 * `idempotentTransferTxId(userId, action.id)`, and `recordActionResult` (which flips the action to
 * its terminal status) has not run yet. Such an action is ALREADY counted by the executed-ledger
 * total in `computeEffectiveTransferTotalWith`, so counting it here again would DOUBLE-count it
 * and spuriously escalate a later legitimately-YELLOW transfer to RED/MFA. We therefore EXCLUDE
 * every in-flight action whose deterministic ledger row already exists. Actions with no ledger row
 * yet (genuinely parked) still contribute, which is what preserves the concurrency defence: two
 * ¥600 actions with no ledger rows still sum to ¥1200.
 *
 * The amount lives inside the JSON `argsJson` blob, so each row is parsed defensively: a
 * malformed/unparsable row (or a non-finite amount) is SKIPPED, never thrown on.
 */
export async function computeInFlightTransferTotal(
  client: PrismaLike,
  userId: string,
  excludeActionId?: string,
): Promise<number> {
  const rows = await client.pendingAction.findMany({
    where: {
      userId,
      toolName: 'transfer_money',
      status: { in: [...IN_FLIGHT_TRANSFER_STATUSES] },
      ...(excludeActionId !== undefined ? { id: { not: excludeActionId } } : {}),
    },
  });

  if (rows.length === 0) return 0;

  // The deterministic ledger ids these parked actions WOULD have produced. Any that already exist
  // were already written to the ledger (and thus already counted as EXECUTED), so they must be
  // excluded from the in-flight sum to avoid counting the same money movement twice.
  const ledgerIds = rows.map((row) => idempotentTransferTxId(userId, row.id));
  const existingLedgerRows = await client.transaction.findMany({
    where: { id: { in: ledgerIds } },
    select: { id: true },
  });
  const alreadyLedgered = new Set(existingLedgerRows.map((tx) => tx.id));

  let total = 0;
  for (const row of rows) {
    if (alreadyLedgered.has(idempotentTransferTxId(userId, row.id))) continue;
    const args = safeParse<Record<string, unknown>>(row.argsJson, {});
    const amount = parseAmount(args.amount as string | number | null | undefined);
    if (Number.isFinite(amount)) total += amount;
  }
  return total;
}

/**
 * Sum `userId`'s already-EXECUTED outgoing transfer debits for today, through the caller's
 * Prisma surface (so it runs inside a transaction). Same window as `computeDailyTransferTotal`
 * — `[startOfDay(now), now]` inclusive — but a raw query because the transaction repository
 * helper always uses the bare client.
 */
async function computeExecutedDailyTransferTotalWith(
  client: PrismaLike,
  userId: string,
  now?: number,
): Promise<number> {
  const nowMs = demoNow(now);
  const start = startOfDay(new Date(nowMs)).getTime();
  const rows = await client.transaction.findMany({
    where: {
      userId,
      occurredAt: { gte: new Date(start), lt: new Date(nowMs + 1) },
      channel: 'TRANSFER',
      direction: 'DEBIT',
    },
  });
  // DEBIT amounts are stored negative; the aggregate reported is the ABSOLUTE total.
  return rows.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
}

/**
 * Compute the EFFECTIVE day transfer total for `userId` at execution time, through the
 * caller's Prisma surface: today's already-EXECUTED transfer debits PLUS every in-flight
 * (authorized-not-yet-ledgered) parked `transfer_money` action except `excludeActionId`.
 *
 * WHY THIS EXISTS: as soon as one transfer is confirmed its claim is committed, but the
 * ledger write (and thus `computeDailyTransferTotal`, which only counts executed rows) has
 * not happened yet. Two concurrently-confirmed transfers therefore both read the pre-transfer
 * executed total and each pass the ¥1000 confirmation-only rule. Counting the in-flight
 * actions closes that gap. `now` defaults to the demo clock.
 *
 * The in-flight half is deduped against the ledger (see `computeInFlightTransferTotal`), so a
 * transfer that has ALREADY been written to the ledger while its action is still `confirmed` is
 * counted exactly once — via the executed half.
 */
export async function computeEffectiveTransferTotalWith(
  client: PrismaLike,
  userId: string,
  now?: number,
  excludeActionId?: string,
): Promise<number> {
  const executed = await computeExecutedDailyTransferTotalWith(client, userId, now);
  const inFlight = await computeInFlightTransferTotal(client, userId, excludeActionId);
  return executed + inFlight;
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
 * at execution time and re-runs `evaluateTransferRisk` on it. It is the EXECUTED-only public API;
 * the gateway additionally counts in-flight PendingActions via `computeEffectiveTransferTotalWith`
 * inside its atomic claim transaction. It returns the same {@link TransferRiskResult} shape
 * (`tier` / `requiresMfa` / `dailyTotal` / `projectedDailyTotal`). `now` is injectable (defaults
 * to the demo clock) for determinism.
 */
export async function reEvaluateTransferRisk(
  userId: string,
  amount: number,
  now?: number,
): Promise<TransferRiskResult> {
  const dailyTotal = await computeDailyTransferTotal(userId, now);
  return evaluateTransferRisk({ amount, dailyTransferTotal: dailyTotal });
}

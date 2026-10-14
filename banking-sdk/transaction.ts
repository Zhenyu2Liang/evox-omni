/**
 * Banking SDK — transaction reads & analysis. GREEN tier (auto-execute).
 * Spend analysis / anomaly detection read `Transaction` rows via `lib/db/repositories`;
 * every function here is READ-ONLY and persists nothing.
 *
 * Execute-only: no permission/confirmation/risk logic lives here (that is `security/`).
 */
import { ANOMALY_AMOUNT_THRESHOLD } from '../lib/constants';
import { demoNow } from '../lib/clock';
import { businessCalendarParts, businessDate, monthRange, previousMonthRange } from '../lib/date';
import { absoluteMinor, centsToMoney, moneyToCents, percentageRatio } from '../lib/money';
import { compareDecimal } from '../lib/decimal';
import { transactions } from '../lib/db/repositories';
import { dbClient } from '../lib/db/client';
import { getCards } from './card';
import { INVESTMENT_FLOW_CATEGORY, SPENDING_CATEGORIES } from './categories';
import { runInTransaction } from './tx';
import { validateSpendingMonth, validateTransactionQuery } from './read-query';
import type {
  AnomalyItem,
  AnomalyReport,
  AnomalySeverity,
  CategorySpend,
  MerchantSpend,
  MonthlyTrendPoint,
  SpendingAnalysis,
  SpendingQuery,
  TransactionChannel,
  TransactionDirection,
  TransactionQuery,
  TransactionView,
} from './types';

/** Row shape returned by the `transactions` repository (kept internal — never leaked). */
type TransactionRow = Awaited<ReturnType<typeof transactions.listTransactions>>[number];

/** Number of months (incl. the analysed one) in the rolling `monthlyTrend` window. */
const TREND_MONTHS = 6;

/** Fallback anomaly reason for rows whose `anomalyReason` is empty. */
const DEFAULT_ANOMALY_REASON = `Large consumption above CNY ${ANOMALY_AMOUNT_THRESHOLD}.`;

/** Transactions for the user, filtered by the query, most recent first. */
export async function listTransactions(
  userId: string,
  query: TransactionQuery = {},
): Promise<TransactionView[]> {
  query = validateTransactionQuery(query);
  const rows = await transactions.listTransactions({
    userId,
    ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
    ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
    ...(query.category !== undefined ? { category: query.category } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
  return rows.map(toTransactionView);
}

/** Spending breakdown for a month (defaults to the current month of the demo clock). */
export async function analyzeSpending(
  userId: string,
  query: SpendingQuery = {},
): Promise<SpendingAnalysis> {
  const month = validateSpendingMonth(query.month);
  const base = month !== undefined ? parseMonth(month) : new Date(demoNow());
  const { start, end } = monthRange(base);
  const prev = previousMonthRange(base);
  const calendar = businessCalendarParts(base);

  return runInTransaction(async () => {
    const trendStart = businessDate(calendar.year, calendar.month - TREND_MONTHS + 1);
    const rows = (await transactions.listTransactions({ userId, from: trendStart, to: end }))
      .filter(row => row.direction === 'DEBIT' && row.category !== INVESTMENT_FLOW_CATEGORY);
    const windowRows = (from: Date, to: Date) => rows.filter(row => row.occurredAt >= from && row.occurredAt < to);
    const booked = windowRows(start, end);
    const totalMinor = sumDebits(booked);
    const prevMinor = sumDebits(windowRows(prev.start, prev.end));
    const byCategory = buildByCategory(booked, totalMinor);
    const categoryTotals: Record<string, string> = Object.fromEntries(SPENDING_CATEGORIES.map(category => [category, '0.00']));
    for (const row of rows) categoryTotals[row.category] = '0.00';
    for (const category of byCategory) categoryTotals[category.category] = category.amount;
    const monthlyTrend: MonthlyTrendPoint[] = [];
    for (let offset = TREND_MONTHS - 1; offset >= 0; offset -= 1) {
      const monthDate = businessDate(calendar.year, calendar.month - offset);
      const range = monthRange(monthDate);
      monthlyTrend.push({ month: formatMonth(monthDate), amount: centsToMoney(sumDebits(windowRows(range.start, range.end))) });
    }
    const total = centsToMoney(totalMinor);
    return {
      month: formatMonth(base), total, bookedTotal: total,
      flaggedTotal: centsToMoney(sumDebits(booked.filter(row => row.isAnomaly))),
      prevTotal: centsToMoney(prevMinor),
      momChangePct: percentageRatio(totalMinor - prevMinor, prevMinor),
      byCategory, categoryTotals, topMerchant: buildTopMerchant(booked), monthlyTrend,
      largest: buildLargest(booked),
    };
  });
}

/** Scan transactions for anomalies (large/irregular spends) and return a report. READ-ONLY. */
export async function detectAnomaly(userId: string): Promise<AnomalyReport> {
  const rows = await transactions.listTransactions({ userId });
  const anomalies = rows
    .filter(
      (row) =>
        row.isAnomaly ||
        (row.direction === 'DEBIT' &&
          row.category !== INVESTMENT_FLOW_CATEGORY &&
          absoluteMinor(row.amountMinor) > moneyToCents(ANOMALY_AMOUNT_THRESHOLD)),
    )
    .map((row) => toAnomalyItem(row));

  const acknowledgements = await dbClient().auditLog.findMany({ where: { userId, toolName: 'acknowledge_transaction' }, select: { detail: true } });
  const acknowledged = new Set(acknowledgements.map(row => row.detail));
  return { anomalies: anomalies.map(item => ({ ...item, acknowledged: acknowledged.has(item.transaction.id) })),
    cards: await getCards(userId), scanned: rows.length, generatedAt: demoNow() };
}

/** Previously flagged anomalies for the user (rows with `isAnomaly = true`). */
export async function listAnomalies(userId: string): Promise<AnomalyItem[]> {
  const rows = await transactions.listAnomalies(userId);
  return rows.map((row) => toAnomalyItem(row));
}

/* ------------------------------------------------------------------ helpers */

/** Maps a repository row onto the frozen `TransactionView` DTO. */
function toTransactionView(row: TransactionRow): TransactionView {
  return {
    id: row.id,
    accountId: row.accountId,
    amount: centsToMoney(row.amountMinor),
    currency: row.currency,
    direction: row.direction as TransactionDirection,
    category: row.category,
    merchant: row.merchant,
    ...(row.channel != null ? { channel: row.channel as TransactionChannel } : {}),
    ...(row.remark != null ? { remark: row.remark } : {}),
    ...(row.counterpartyId != null ? { counterpartyId: row.counterpartyId } : {}),
    occurredAt: row.occurredAt.getTime(),
    isAnomaly: row.isAnomaly,
    ...(row.anomalyReason != null ? { anomalyReason: row.anomalyReason } : {}),
  };
}

/** Maps a repository row onto an `AnomalyItem` (severity derived from magnitude). */
function toAnomalyItem(row: TransactionRow): AnomalyItem {
  return {
    transaction: toTransactionView(row),
    reason: row.anomalyReason ?? DEFAULT_ANOMALY_REASON,
    severity: severityFor(absoluteMinor(row.amountMinor)),
  };
}

/** Deterministic severity bucket relative to `ANOMALY_AMOUNT_THRESHOLD`. */
function severityFor(absoluteAmount: bigint): AnomalySeverity {
  const threshold = moneyToCents(ANOMALY_AMOUNT_THRESHOLD);
  if (absoluteAmount > threshold * 2n) return 'high';
  if (absoluteAmount * 2n > threshold * 3n) return 'medium';
  return 'low';
}

/** Sum booked consumption in minor units, including flagged rows. */
function sumDebits(rows: TransactionRow[]): bigint {
  return rows.reduce((total, row) => total + absoluteMinor(row.amountMinor), 0n);
}

/** Per-category totals, greatest first (ties broken by category name for determinism). */
function buildByCategory(rows: TransactionRow[], total: bigint): CategorySpend[] {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    totals.set(row.category, (totals.get(row.category) ?? 0n) + absoluteMinor(row.amountMinor));
  }
  return [...totals.entries()]
    .map(([category, amount]) => ({
      category,
      amount: centsToMoney(amount),
      share: percentageRatio(amount, total),
    }))
    .sort((a, b) => compareDecimal(b.amount, a.amount) || a.category.localeCompare(b.category));
}

/** The merchant with the greatest booked consumption, or null when there is none. */
function buildTopMerchant(rows: TransactionRow[]): MerchantSpend | null {
  const totals = new Map<string, { amount: bigint; count: number }>();
  for (const row of rows) {
    const current = totals.get(row.merchant) ?? { amount: 0n, count: 0 };
    totals.set(row.merchant, {
      amount: current.amount + absoluteMinor(row.amountMinor),
      count: current.count + 1,
    });
  }

  let top: MerchantSpend | null = null;
  for (const [merchant, { amount, count }] of totals) {
    const isGreater = top === null || amount > moneyToCents(top.amount);
    const isTieBreak = top !== null && amount === moneyToCents(top.amount) && merchant.localeCompare(top.merchant) < 0;
    if (isGreater || isTieBreak) top = { merchant, amount: centsToMoney(amount), count };
  }
  return top;
}

/** The largest booked consumption by magnitude, including flagged rows. */
function buildLargest(rows: TransactionRow[]): TransactionView | null {
  let largest: TransactionRow | null = null;
  for (const row of rows) {
    if (largest === null || absoluteMinor(row.amountMinor) > absoluteMinor(largest.amountMinor)) largest = row;
  }
  return largest === null ? null : toTransactionView(largest);
}

/** Parses a month label into its first banking-calendar instant. */
function parseMonth(month: string): Date {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5)) - 1;
  return businessDate(year, monthIndex);
}

/** Formats an instant as a banking-calendar month label. */
function formatMonth(date: Date): string {
  const calendar = businessCalendarParts(date);
  return `${calendar.year}-${String(calendar.month + 1).padStart(2, '0')}`;
}

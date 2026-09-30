/**
 * Banking SDK — transaction reads & analysis. GREEN tier (auto-execute).
 * Spend analysis / anomaly detection read `Transaction` rows via `lib/db/repositories`;
 * every function here is READ-ONLY and persists nothing.
 *
 * Execute-only: no permission/confirmation/risk logic lives here (that is `security/`).
 */
import { ANOMALY_AMOUNT_THRESHOLD } from '../lib/constants';
import { demoNow } from '../lib/clock';
import { monthRange, previousMonthRange } from '../lib/date';
import { AppError } from '../lib/errors';
import { addMoney, round2 } from '../lib/money';
import { transactions } from '../lib/db/repositories';
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
const DEFAULT_ANOMALY_REASON = `大额消费（>¥${ANOMALY_AMOUNT_THRESHOLD.toLocaleString('en-US')}）`;

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/** Transactions for the user, filtered by the query, most recent first. */
export async function listTransactions(
  userId: string,
  query: TransactionQuery = {},
): Promise<TransactionView[]> {
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
  const base = query.month !== undefined ? parseMonth(query.month) : new Date(demoNow());
  const { start, end } = monthRange(base);
  const prev = previousMonthRange(base);

  const monthOrdinary = await ordinaryDebits(userId, start, end);
  const prevOrdinary = await ordinaryDebits(userId, prev.start, prev.end);

  const total = sumDebits(monthOrdinary);
  const prevTotal = sumDebits(prevOrdinary);
  const momChangePct = prevTotal === 0 ? 0 : round2(((total - prevTotal) / prevTotal) * 100);

  return {
    month: formatMonth(base),
    total,
    prevTotal,
    momChangePct,
    byCategory: buildByCategory(monthOrdinary, total),
    topMerchant: buildTopMerchant(monthOrdinary),
    monthlyTrend: await buildMonthlyTrend(userId, base),
    largest: buildLargest(monthOrdinary),
  };
}

/** Scan transactions for anomalies (large/irregular spends) and return a report. READ-ONLY. */
export async function detectAnomaly(userId: string): Promise<AnomalyReport> {
  const rows = await transactions.listTransactions({ userId });
  const anomalies = rows
    .filter((row) => Math.abs(row.amount) > ANOMALY_AMOUNT_THRESHOLD)
    .map((row) => toAnomalyItem(row));

  return { anomalies, scanned: rows.length, generatedAt: demoNow() };
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
    amount: row.amount,
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
    severity: severityFor(Math.abs(row.amount)),
  };
}

/** Deterministic severity bucket relative to `ANOMALY_AMOUNT_THRESHOLD`. */
function severityFor(absoluteAmount: number): AnomalySeverity {
  if (absoluteAmount > ANOMALY_AMOUNT_THRESHOLD * 2) return 'high';
  if (absoluteAmount > ANOMALY_AMOUNT_THRESHOLD * 1.5) return 'medium';
  return 'low';
}

/**
 * Ordinary DEBIT rows in `[from, to)`. Rows flagged `isAnomaly` are EXCLUDED so the seeded
 * ¥6,999 Apple Store anomaly never inflates the spend totals (本月 must be exactly ¥5,800).
 */
async function ordinaryDebits(userId: string, from: Date, to: Date): Promise<TransactionRow[]> {
  const rows = await transactions.listTransactions({ userId, from, to });
  return rows.filter((row) => row.direction === 'DEBIT' && !row.isAnomaly);
}

/** Cent-safe sum of the magnitudes of the given (DEBIT) rows. */
function sumDebits(rows: TransactionRow[]): number {
  return rows.reduce((acc, row) => addMoney(acc, Math.abs(row.amount)), 0);
}

/** Per-category totals, greatest first (ties broken by category name for determinism). */
function buildByCategory(rows: TransactionRow[], total: number): CategorySpend[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.category, addMoney(totals.get(row.category) ?? 0, Math.abs(row.amount)));
  }
  return [...totals.entries()]
    .map(([category, amount]) => ({
      category,
      amount,
      share: total === 0 ? 0 : round2((amount / total) * 100),
    }))
    .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
}

/** The merchant with the greatest ordinary spend, or null when there is none. */
function buildTopMerchant(rows: TransactionRow[]): MerchantSpend | null {
  const totals = new Map<string, { amount: number; count: number }>();
  for (const row of rows) {
    const current = totals.get(row.merchant) ?? { amount: 0, count: 0 };
    totals.set(row.merchant, {
      amount: addMoney(current.amount, Math.abs(row.amount)),
      count: current.count + 1,
    });
  }

  let top: MerchantSpend | null = null;
  for (const [merchant, { amount, count }] of totals) {
    const isGreater = top === null || amount > top.amount;
    const isTieBreak = top !== null && amount === top.amount && merchant.localeCompare(top.merchant) < 0;
    if (isGreater || isTieBreak) top = { merchant, amount, count };
  }
  return top;
}

/** The largest ordinary DEBIT in the window by |amount|, or null when there is none. */
function buildLargest(rows: TransactionRow[]): TransactionView | null {
  let largest: TransactionRow | null = null;
  for (const row of rows) {
    if (largest === null || Math.abs(row.amount) > Math.abs(largest.amount)) largest = row;
  }
  return largest === null ? null : toTransactionView(largest);
}

/** Ordinary spend for each of the last `TREND_MONTHS` months, oldest → newest. */
async function buildMonthlyTrend(userId: string, base: Date): Promise<MonthlyTrendPoint[]> {
  const points: MonthlyTrendPoint[] = [];
  for (let offset = TREND_MONTHS - 1; offset >= 0; offset -= 1) {
    const monthDate = new Date(base.getFullYear(), base.getMonth() - offset, 1);
    const { start, end } = monthRange(monthDate);
    points.push({ month: formatMonth(monthDate), amount: sumDebits(await ordinaryDebits(userId, start, end)) });
  }
  return points;
}

/** Parses a `YYYY-MM` label into the first instant of that local month. */
function parseMonth(month: string): Date {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) {
    throw new AppError('VALIDATION', `Invalid month "${month}", expected "YYYY-MM".`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new AppError('VALIDATION', `Invalid month "${month}": month must be 01–12.`);
  }
  return new Date(year, monthIndex, 1);
}

/** Formats a `Date` as a local `YYYY-MM` label. */
function formatMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

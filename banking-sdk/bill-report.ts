import { z } from 'zod';
import { transactions } from '@/lib/db/repositories';
import { demoNow } from '@/lib/clock';
import { businessCalendarParts, businessDate, formatBusinessDate } from '@/lib/date';
import { absoluteMinor, centsToMoney, percentageRatio, type MoneyAmount } from '@/lib/money';
import { AppError } from '@/lib/errors';
import { INVESTMENT_FLOW_CATEGORY } from './categories';

const yearText = z.string().regex(/^[1-9]\d{3}$/);
const querySchema = z.union([
  z.strictObject({ period: z.literal('month').optional(), month: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/).optional() }),
  z.strictObject({ period: z.literal('year'), year: yearText.optional() }),
]);

export type BillReportQuery = { period?: 'month'; month?: string } | { period: 'year'; year?: string };
export interface ReportTotals {
  inflow: MoneyAmount;
  outflow: MoneyAmount;
  net: MoneyAmount;
  spending: MoneyAmount;
  count: number;
  anomalyCount: number;
}
export interface BillReportEntry {
  id: string;
  amount: MoneyAmount;
  direction: 'DEBIT' | 'CREDIT';
  category: string;
  merchant: string;
  description: string;
  occurredAt: number;
  isAnomaly: boolean;
}
export interface BillReport {
  period: 'month' | 'year';
  label: string;
  currency: 'CNY';
  timeZone: 'Asia/Shanghai';
  from: number;
  to: number;
  totals: ReportTotals;
  previous: { label: string; totals: ReportTotals; spendingChangePct: string | null };
  categories: { category: string; amount: MoneyAmount; count: number; sharePct: string }[];
  trend: (ReportTotals & { label: string })[];
  transactions: BillReportEntry[];
}

/** Strict filters shared by the page, SDK and export. Never widen an invalid period. */
export function resolveBillReportQuery(input: unknown = {}): { period: 'month' | 'year'; label: string } {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Choose a month (YYYY-MM) or a year (1000–9999).');
  const now = businessCalendarParts(demoNow());
  return parsed.data.period === 'year'
    ? { period: 'year', label: parsed.data.year ?? String(now.year) }
    : { period: 'month', label: parsed.data.month ?? `${now.year}-${String(now.month + 1).padStart(2, '0')}` };
}

type Row = Awaited<ReturnType<typeof transactions.listTransactions>>[number];
function sum(rows: Row[]): ReportTotals {
  let inflow = 0n, outflow = 0n, spending = 0n;
  for (const row of rows) {
    const amount = absoluteMinor(row.amountMinor);
    if (row.direction === 'CREDIT') inflow += amount;
    else {
      outflow += amount;
      if (row.category !== INVESTMENT_FLOW_CATEGORY) spending += amount;
    }
  }
  return { inflow: centsToMoney(inflow), outflow: centsToMoney(outflow), net: centsToMoney(inflow - outflow),
    spending: centsToMoney(spending), count: rows.length, anomalyCount: rows.filter(row => row.isAnomaly).length };
}
function spendingMinor(rows: Row[]): bigint {
  return rows.reduce((total, row) => total + (row.direction === 'DEBIT' && row.category !== INVESTMENT_FLOW_CATEGORY ? absoluteMinor(row.amountMinor) : 0n), 0n);
}

/** One owner-scoped SELECT gives a consistent ledger snapshot, without the interactive read cap. */
export async function getBillReport(userId: string, input: BillReportQuery = {}): Promise<BillReport> {
  const { period, label } = resolveBillReportQuery(input);
  const year = Number(label.slice(0, 4));
  const month = period === 'month' ? Number(label.slice(5)) - 1 : 0;
  const start = businessDate(year, month);
  const end = businessDate(year + (period === 'year' ? 1 : 0), month + (period === 'month' ? 1 : 0));
  const previousStart = businessDate(year - (period === 'year' ? 1 : 0), month - (period === 'month' ? 1 : 0));
  const all = await transactions.listTransactions({ userId, currency: 'CNY', from: previousStart, to: end });
  const rows = all.filter(row => row.occurredAt >= start);
  const prior = all.filter(row => row.occurredAt < start);
  const totalSpending = spendingMinor(rows), priorSpending = spendingMinor(prior);
  const categories = new Map<string, { amount: bigint; count: number }>();
  for (const row of rows) {
    if (row.direction !== 'DEBIT' || row.category === INVESTMENT_FLOW_CATEGORY) continue;
    const value = categories.get(row.category) ?? { amount: 0n, count: 0 };
    value.amount += absoluteMinor(row.amountMinor); value.count++;
    categories.set(row.category, value);
  }
  const points = period === 'year' ? 12 : businessCalendarParts(end.getTime() - 1).day;
  const trend = Array.from({ length: points }, (_, index) => {
    const from = period === 'year' ? businessDate(year, index) : businessDate(year, month, index + 1);
    const to = period === 'year' ? businessDate(year, index + 1) : businessDate(year, month, index + 2);
    return { label: formatBusinessDate(from).slice(0, period === 'year' ? 7 : 10),
      ...sum(rows.filter(row => row.occurredAt >= from && row.occurredAt < to)) };
  });
  return {
    period, label, currency: 'CNY', timeZone: 'Asia/Shanghai', from: start.getTime(), to: end.getTime(), totals: sum(rows),
    previous: { label: formatBusinessDate(previousStart).slice(0, period === 'year' ? 4 : 7), totals: sum(prior),
      spendingChangePct: priorSpending === 0n ? null : percentageRatio(totalSpending - priorSpending, priorSpending) },
    categories: [...categories].sort(([a, x], [b, y]) => x.amount === y.amount ? a.localeCompare(b) : x.amount > y.amount ? -1 : 1)
      .map(([category, value]) => ({ category, amount: centsToMoney(value.amount), count: value.count, sharePct: percentageRatio(value.amount, totalSpending) })),
    trend,
    transactions: rows.map(row => ({ id: row.id, amount: centsToMoney(row.direction === 'DEBIT' ? -absoluteMinor(row.amountMinor) : absoluteMinor(row.amountMinor)),
      direction: row.direction as 'DEBIT' | 'CREDIT', merchant: row.merchant, category: row.category, description: row.remark ?? '',
      occurredAt: row.occurredAt.getTime(), isAnomaly: row.isAnomaly })),
  };
}

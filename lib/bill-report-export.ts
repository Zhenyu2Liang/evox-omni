import type { BillReport } from '@/banking-sdk/bill-report';
import { formatDateTime } from './date';
import { createTranslator, type Locale } from './i18n/shared';

/** Quote every cell; neutralize spreadsheet formulas in user-authored text. */
export function csvText(value: string): string {
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function billReportCsv(report: BillReport, locale: Locale): string {
  const t = createTranslator(locale);
  // Metadata is repeated on each row so importing the ledger remains a rectangular table.
  const header = ['period', 'currency', 'timeZone', 'time', 'merchant', 'category', 'direction', 'amount', 'status', 'description'] as const;
  const lines = [header.map(key => csvText(t(`pages.reports.${key}`))).join(',')];
  for (const row of report.transactions) {
    const cells = [report.label, report.currency, report.timeZone, formatDateTime(row.occurredAt), row.merchant, row.category,
      t(row.direction === 'DEBIT' ? 'pages.reports.outflow' : 'pages.reports.inflow')];
    // The amount is canonical server-generated decimal text, never a user-provided formula.
    lines.push([...cells.map(csvText), `"${row.amount}"`, csvText(t(row.isAnomaly ? 'pages.reports.flagged' : 'pages.reports.booked')), csvText(row.description)].join(','));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

export { billReportHtml } from "./bill-report-html";

import type { BillReport, ReportTotals } from '@/banking-sdk/bill-report';
import { addMoney, formatCNY, moneyToChartNumber } from './money';
import { createTranslator, type Locale } from './i18n/shared';

/** The only HTML/SVG interpolation boundary; all recorded and generated text is escaped. */
export const reportEscape = (value: string | number): string => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export type ReportDisplayPoint = ReportTotals & { label: string };

/** Display grouping leaves the exact daily SDK ledger contract intact. */
export function reportDisplayTrend(report: BillReport): ReportDisplayPoint[] {
  if (report.period === 'year') return report.trend;
  const groups: ReportDisplayPoint[] = [];
  for (let offset = 0; offset < report.trend.length; offset += 7) {
    const days = report.trend.slice(offset, offset + 7);
    const total = days.reduce<ReportTotals>((sum, day) => ({
      inflow: addMoney(sum.inflow, day.inflow), outflow: addMoney(sum.outflow, day.outflow),
      net: addMoney(sum.net, day.net), spending: addMoney(sum.spending, day.spending),
      count: sum.count + day.count, anomalyCount: sum.anomalyCount + day.anomalyCount,
    }), { inflow: '0.00', outflow: '0.00', net: '0.00', spending: '0.00', count: 0, anomalyCount: 0 });
    groups.push({ label: `${days[0].label.slice(-2)}-${days.at(-1)!.label.slice(-2)}`, ...total });
  }
  return groups;
}

/** Inline vectors are shared by the page, offline HTML and the PDF renderer. */
export function reportTrendSvg(report: BillReport, locale: Locale): string {
  const t = createTranslator(locale), e = reportEscape, points = reportDisplayTrend(report);
  const max = Math.max(1, ...points.flatMap(p => [moneyToChartNumber(p.inflow), moneyToChartNumber(p.outflow)]));
  const width = 660, height = 170, step = width / points.length, bar = Math.min(24, step * .27);
  const bars = points.map((point, index) => {
    const x = 44 + step * (index + .5);
    const a = moneyToChartNumber(point.inflow) / max * height, b = moneyToChartNumber(point.outflow) / max * height;
    const title = `${point.label} · ${t('pages.reports.inflow')} ${formatCNY(point.inflow)} · ${t('pages.reports.outflow')} ${formatCNY(point.outflow)}`;
    return `<g data-report-bucket="${e(point.label)}"><title>${e(title)}</title><rect x="${x - bar - 2}" y="${190 - a}" width="${bar}" height="${a}" rx="3" fill="var(--color-banking-flow-in,#6385cc)"/><rect x="${x + 2}" y="${190 - b}" width="${bar}" height="${b}" rx="3" fill="var(--color-banking-flow-out,#a28bc6)"/><text x="${x}" y="212" text-anchor="middle">${e(report.period === 'year' ? point.label.slice(-2) : point.label)}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 740 260" role="img" aria-label="${e(t('pages.reports.trend'))}" style="display:block;width:100%;height:auto;font:12px system-ui,sans-serif;fill:var(--color-banking-navy,#786b63)"><title>${e(t('pages.reports.trend'))}</title>${[0, .5, 1].map(scale => `<line x1="44" x2="704" y1="${190 - scale * height}" y2="${190 - scale * height}" stroke="var(--color-banking-border,#e8e0d9)" stroke-dasharray="4 5"/>`).join('')}${bars}<rect x="225" y="238" width="10" height="10" rx="2" fill="var(--color-banking-flow-in,#6385cc)"/><text x="242" y="247">${e(t('pages.reports.inflow'))}</text><rect x="405" y="238" width="10" height="10" rx="2" fill="var(--color-banking-flow-out,#a28bc6)"/><text x="422" y="247">${e(t('pages.reports.outflow'))}</text></svg>`;
}

export function reportCategorySvg(report: BillReport, locale: Locale): string {
  const e = reportEscape, t = createTranslator(locale), rows = report.categories.slice(0, 6);
  const height = Math.max(90, rows.length * 38 + 15);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 740 ${height}" role="img" aria-label="${e(t('pages.reports.categories'))}" style="display:block;width:100%;height:auto;font:13px system-ui,sans-serif;fill:var(--color-banking-navy,#786b63)"><title>${e(t('pages.reports.categories'))}</title>${rows.map((row, index) => `<g><title>${e(`${row.category} · ${formatCNY(row.amount)} · ${row.sharePct}%`)}</title><text x="5" y="${index * 38 + 24}">${e(Array.from(row.category).slice(0, 12).join(''))}</text><rect x="190" y="${index * 38 + 10}" width="440" height="19" rx="5" fill="var(--color-banking-subtle,#f3eee8)"/><rect x="190" y="${index * 38 + 10}" width="${Number(row.sharePct) * 4.4}" height="19" rx="5" fill="var(--color-banking-teal,#476e6d)"/><text x="647" y="${index * 38 + 24}">${e(row.sharePct)}%</text></g>`).join('')}</svg>`;
}

export type ReportFactId = 'cashflow' | 'change' | 'category' | 'anomalies';
export interface ReportFact { id: ReportFactId; title: string; text: string }
export interface BillReportAnalysis {
  source: 'model' | 'mock';
  generatedAt: number;
  snapshot: string;
  blocks: { factId: ReportFactId; explanation: string }[];
  suggestions: string[];
}

/** The host owns every number. Model commentary refers to these facts by closed identifiers. */
export function reportFacts(report: BillReport, locale: Locale): ReportFact[] {
  const t = createTranslator(locale);
  const facts: ReportFact[] = [
    { id: 'cashflow', title: t('pages.reports.net'), text: t('pages.reports.fact.cashflow', {
      inflow: formatCNY(report.totals.inflow), outflow: formatCNY(report.totals.outflow), net: formatCNY(report.totals.net) }) },
    { id: 'change', title: t('pages.reports.spending'), text: t('pages.reports.fact.change', {
      spending: formatCNY(report.totals.spending), previous: formatCNY(report.previous.totals.spending),
      change: report.previous.spendingChangePct === null ? t('pages.reports.noComparison') : `${report.previous.spendingChangePct}%` }) },
  ];
  const top = report.categories[0];
  if (top) facts.push({ id: 'category', title: t('pages.reports.categories'), text: t('pages.reports.fact.category', { category: top.category, amount: formatCNY(top.amount), share: top.sharePct }) });
  facts.push({ id: 'anomalies', title: t('pages.reports.status'), text: t('pages.reports.fact.anomalies', { count: report.totals.anomalyCount }) });
  return facts;
}

import type { BillReport } from '@/banking-sdk/bill-report';
import { formatDateTime } from './date';
import { formatCNY } from './money';
import { createTranslator, type Locale } from './i18n/shared';
import { reportEscape as e, reportFacts, reportTrendSvg, reportCategorySvg, reportDisplayTrend, type BillReportAnalysis } from './bill-report-presentation';

/** Offline report: embedded vectors and escaped commentary, with no scripts or remote assets. */
export function billReportHtml(report: BillReport, locale: Locale, analysis: BillReportAnalysis | null = null): string {
  const t = createTranslator(locale), facts = reportFacts(report, locale);
  const title = `${report.label} · ${t(report.period === 'year' ? 'pages.reports.yearly' : 'pages.reports.monthly')}`;
  const table = (headers: string[], rows: (string | number)[][]) => `<table><thead><tr>${headers.map(h => `<th scope="col">${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const totals = (['inflow', 'outflow', 'net', 'spending'] as const).map(key => `<div><span>${e(t(`pages.reports.${key}`))}</span><strong>${e(formatCNY(report.totals[key]))}</strong></div>`).join('');
  const commentary = analysis ? `<section class="analysis"><h2>${e(t('pages.reports.analysis'))}</h2>
    <p class="muted">${e(t(analysis.source === 'model' ? 'pages.reports.analysisSource' : 'pages.reports.analysisMock', { time: formatDateTime(analysis.generatedAt) }))}</p>
    <div class="facts">${analysis.blocks.map(block => {
      const fact = facts.find(value => value.id === block.factId);
      return fact ? `<article><h3>${e(fact.title)}</h3><p>${e(fact.text)}</p><p>${e(block.explanation)}</p></article>` : '';
    }).join('')}</div><h3>${e(t('pages.reports.suggestions'))}</h3><ul>${analysis.suggestions.map(text => `<li>${e(text)}</li>`).join('')}</ul></section>`
    : `<p class="muted">${e(t('pages.reports.analysisMissing'))}</p>`;
  const trend = reportDisplayTrend(report);
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${e(title)}</title><style>
  *{box-sizing:border-box}body{font:13px/1.65 system-ui,'Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#3e3430;background:#fbf8f5;max-width:1000px;margin:32px auto;padding:28px}
  h1{font-size:30px;line-height:1.3;letter-spacing:-.5px;margin:10px 0 16px}h2{font-size:19px;margin:0 0 16px}h3{font-size:13px;margin:0 0 8px}p{margin:8px 0}.muted,.eyebrow{color:#786b63}.eyebrow{letter-spacing:1px;font-size:11px}
  .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0 14px}.summary div{background:#fff;border:1px solid #e8e0d9;border-radius:12px;padding:16px;overflow-wrap:anywhere}.summary div:first-child{background:#edf5f3}.summary div:nth-child(3){background:#eef4f8}.summary span,.summary strong{display:block}.summary span{color:#786b63;font-size:11px}.summary strong{font-size:18px;margin-top:8px;font-variant-numeric:tabular-nums}
  section{background:#fff;border:1px solid #e8e0d9;border-radius:14px;padding:22px;margin:22px 0}.facts{display:grid;grid-template-columns:1fr 1fr;gap:12px}.facts article{background:#fbf8f5;border-radius:10px;padding:14px;break-inside:avoid;overflow-wrap:anywhere}.facts p{margin:0;font-size:12px}.analysis{break-inside:avoid}.analysis p+ p{margin-top:8px;color:#786b63}.analysis h3{margin-top:12px}.analysis li{margin:6px 0}.analysis ul{break-inside:avoid}.chart{break-inside:avoid}.chart svg{margin:12px 0}.subtitle{font-size:11px;color:#786b63;margin-top:-10px}
  table{width:100%;border-collapse:collapse;font-size:11px}th,td{text-align:left;padding:9px 7px;border-bottom:1px solid #e8e0d9;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}th{background:#f3eee8;font-weight:600}tr{break-inside:avoid}thead{display:table-header-group}.scroll{overflow-x:auto}.scope{font-size:11px;color:#786b63}.ledger table{table-layout:fixed}.ledger th:first-child{width:18%}.ledger th:nth-child(4){width:16%}.ledger th:nth-child(5){width:10%}
  @media(max-width:640px){body{margin:0;padding:16px}.summary,.facts{grid-template-columns:1fr 1fr}.summary div{padding:12px}.summary strong{font-size:15px}section{padding:16px}}
  @media print{body{background:white;margin:0;padding:0;max-width:none;font-size:11px;-webkit-print-color-adjust:exact;print-color-adjust:exact}h1{font-size:26px}.summary{margin:16px 0}.summary strong{font-size:16px}section{padding:16px;margin:16px 0}.scroll{overflow:visible}h2,h3{break-after:avoid}.ledger{break-before:page;border:0;padding:0}.ledger table{font-size:9px}.ledger td,.ledger th{padding:7px 5px}.facts article{padding:11px}.facts p{font-size:11px}@page{size:A4 portrait;margin:14mm 13mm 18mm}}
  </style></head><body>
  <header><p class="eyebrow">${e(t('pages.reports.title'))} · CNY · UTC+08:00</p><h1>${e(title)}</h1><p class="muted">${e(t('pages.reports.range', { from: formatDateTime(report.from), to: formatDateTime(report.to) }))}</p></header>
  <div class="summary">${totals}</div><p class="muted">${e(t('pages.reports.counts', { count: report.totals.count, anomalies: report.totals.anomalyCount }))}</p>
  <p class="scope">${e(t('pages.reports.scope'))}</p>
  ${analysis ? '' : `<section><h2>${e(t('pages.reports.dataSummary'))}</h2><div class="facts">${facts.map(fact => `<article><h3>${e(fact.title)}</h3><p>${e(fact.text)}</p></article>`).join('')}</div></section>`}
  ${commentary}
  <section class="chart"><h2>${e(t('pages.reports.trend'))}</h2><p class="subtitle">${e(t(report.period === 'year' ? 'pages.reports.byMonth' : 'pages.reports.weekly'))}</p>${reportTrendSvg(report, locale)}
    ${table([t('pages.reports.period'), ...(['inflow', 'outflow', 'net', 'spending'] as const).map(key => t(`pages.reports.${key}`))], trend.map(row => [row.label, ...(['inflow', 'outflow', 'net', 'spending'] as const).map(key => formatCNY(row[key]))]))}</section>
  <section><h2>${e(t('pages.reports.categories'))}</h2><div class="chart">${reportCategorySvg(report, locale)}</div>
    ${table([t('pages.reports.category'), t('pages.reports.amount'), t('pages.reports.share'), t('pages.reports.count')], report.categories.map(row => [row.category, formatCNY(row.amount), `${row.sharePct}%`, row.count]))}</section>
  <section class="ledger"><h2>${e(t('pages.reports.ledger'))}</h2>${report.transactions.length === 0 ? `<p>${e(t('pages.reports.empty'))}</p>` : ''}<div class="scroll">
    ${table(['time', 'merchant', 'category', 'amount', 'status', 'description'].map(key => t(`pages.reports.${key}` as Parameters<typeof t>[0])), report.transactions.map(row => [formatDateTime(row.occurredAt), row.merchant, row.category, formatCNY(row.amount), t(row.isAnomaly ? 'pages.reports.flagged' : 'pages.reports.booked'), row.description]))}</div></section>
  </body></html>`;
}

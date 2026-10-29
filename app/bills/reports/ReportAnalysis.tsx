'use client';

import { useState } from 'react';
import type { BillReportQuery } from '@/banking-sdk/bill-report';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { formatDateTime } from '@/lib/date';
import type { BillReportAnalysis, ReportFact } from '@/lib/bill-report-presentation';

export function ReportAnalysis({ query, facts, initialAnalysis, empty }: {
  query: BillReportQuery; facts: ReportFact[]; initialAnalysis: BillReportAnalysis | null; empty: boolean;
}) {
  const { t, locale } = useI18n();
  const [analysis, setAnalysis] = useState(initialAnalysis);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function generate() {
    if (pending) return;
    setPending(true); setError(undefined);
    try {
      const response = await fetch('/api/bills/reports/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, locale }) });
      if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'failed');
      const result = await response.json();
      setAnalysis(result.data);
    } catch (failure) { setError(t(failure instanceof Error && failure.message === 'conflict' ? 'pages.reports.analysisConflict' : 'pages.reports.analysisError')); }
    finally { setPending(false); }
  }
  return <section aria-label={t('pages.reports.analysis')} className="rounded-2xl border border-banking-border bg-banking-surface p-5 sm:p-7">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h2 className="text-lg font-semibold text-banking-deep">{t('pages.reports.analysis')}</h2>
        <p className="mt-1 text-sm text-banking-navy">{analysis ? t(analysis.source === 'model' ? 'pages.reports.analysisSource' : 'pages.reports.analysisMock', { time: formatDateTime(analysis.generatedAt) }) : t(empty ? 'pages.reports.analysisEmpty' : 'pages.reports.analysisHint')}</p></div>
      {!analysis && !empty ? <button onClick={generate} disabled={pending} className="min-h-11 rounded-xl bg-banking-accent px-5 text-sm font-semibold text-white hover:bg-banking-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-banking-accent disabled:cursor-wait disabled:opacity-60">{t(pending ? 'pages.reports.generating' : 'pages.reports.generate')}</button> : null}
    </div>
    <div aria-live="polite">{pending ? <p role="status" className="mt-4 text-sm text-banking-navy">{t('pages.reports.generating')}</p> : null}
      {error ? <p role="alert" className="mt-4 text-sm text-banking-danger">{error}</p> : null}</div>
    {analysis ? <div className="mt-5 space-y-5">
      <div className="grid gap-4 md:grid-cols-2">{analysis.blocks.map(block => {
        const fact = facts.find(item => item.id === block.factId);
        return fact ? <article key={block.factId} className="rounded-xl bg-banking-light p-4"><h3 className="text-sm font-semibold text-banking-deep">{fact.title}</h3><p className="mt-2 text-sm leading-6 text-banking-deep">{fact.text}</p><p className="mt-2 text-sm leading-6 text-banking-navy">{block.explanation}</p></article> : null;
      })}</div>
      <div><h3 className="text-sm font-semibold text-banking-deep">{t('pages.reports.suggestions')}</h3><ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-banking-navy">{analysis.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul></div>
    </div> : null}
  </section>;
}

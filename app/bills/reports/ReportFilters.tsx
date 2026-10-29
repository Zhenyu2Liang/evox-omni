'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export function ReportFilters({ period, month, year }: { period: 'month' | 'year'; month: string; year: string }) {
  const [selected, setSelected] = useState(period);
  const { t } = useI18n();
  const input = 'bank-input min-h-12 w-full rounded-xl border border-banking-input-border bg-banking-surface px-4 text-base text-banking-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-banking-accent';
  return <form action="/bills/reports" method="get" className="grid gap-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-banking-navy">{t('pages.reports.period')}</legend>
      <div className="flex min-h-12 gap-1 rounded-xl bg-banking-subtle p-1">
        {(['month', 'year'] as const).map(value => <label key={value} className={`relative flex flex-1 cursor-pointer items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-banking-accent ${selected === value ? 'bg-banking-surface text-banking-deep shadow-sm' : 'text-banking-navy hover:text-banking-deep'}`}>
          <input className="sr-only" type="radio" name="period" value={value} checked={selected === value} onChange={() => setSelected(value)} />
          {t(value === 'month' ? 'pages.reports.monthly' : 'pages.reports.yearly')}
        </label>)}
      </div>
    </fieldset>
    <div>
      <label htmlFor="report-date" className="mb-2 block text-sm font-medium text-banking-navy">{t(selected === 'month' ? 'pages.reports.month' : 'pages.reports.year')}</label>
      {selected === 'month'
        ? <input key="month" id="report-date" className={input} name="month" type="month" min="1000-01" max="9999-12" defaultValue={month} required />
        : <input key="year" id="report-date" className={input} name="year" type="number" min="1000" max="9999" step="1" defaultValue={year} required />}
    </div>
    <button className="min-h-12 rounded-xl bg-banking-accent px-7 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-banking-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-banking-accent" type="submit">{t('pages.reports.view')}</button>
  </form>;
}

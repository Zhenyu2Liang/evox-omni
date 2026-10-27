'use client';

import { useI18n } from '@/lib/i18n/LocaleProvider';
import Image from 'next/image';

const SUGGESTIONS = [
  { title: 'chat.suggestion.balance.title', description: 'chat.suggestion.balance.description', prompt: 'chat.suggestion.balance.prompt', symbol: 'balance' },
  { title: 'chat.suggestion.spending.title', description: 'chat.suggestion.spending.description', prompt: 'chat.suggestion.spending.prompt', symbol: 'spending' },
  { title: 'chat.suggestion.subscription.title', description: 'chat.suggestion.subscription.description', prompt: 'chat.suggestion.subscription.prompt', symbol: 'subscription' },
  { title: 'chat.suggestion.transfer.title', description: 'chat.suggestion.transfer.description', prompt: 'chat.suggestion.transfer.prompt', symbol: 'transfer' },
] as const;

function SuggestionIcon({ symbol }: { symbol: typeof SUGGESTIONS[number]['symbol'] }) {
  const paths = {
    balance: <><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 10h18M7 15h3M7 6V4h10v2" /></>,
    spending: <><path d="M4 20V10m8 10V4m8 16v-7M2 20h20" /></>,
    subscription: <><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-12 5h4" /></>,
    transfer: <><path d="M4 8h16m-5-5 5 5-5 5M20 16H4m5-5-5 5 5 5" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">{paths[symbol]}</svg>;
}

export function ChatWelcome({ onSelect, disabled }: { onSelect: (prompt: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-start py-5 sm:py-16">
      <div aria-hidden="true" className="mb-5 flex h-12 w-14 items-center justify-center sm:mb-6 sm:h-14 sm:w-16">
        <Image src="/brand/rongxu-x.svg" alt="" width={64} height={56} className="h-full w-full object-contain" />
      </div>
      <h2 className="max-w-lg text-3xl font-semibold leading-tight tracking-tight text-banking-deep sm:text-4xl">{t('chat.welcome.title')}</h2>
      <p className="mt-4 max-w-lg text-sm leading-6 text-banking-navy">{t('chat.welcome.description')}</p>
      <div className="mt-6 grid w-full grid-cols-2 gap-3 sm:mt-8">
        {SUGGESTIONS.map(suggestion => (
          <button key={suggestion.symbol} type="button" disabled={disabled} onClick={() => onSelect(t(suggestion.prompt))} className="group flex items-center gap-2 rounded-2xl border border-slate-200/80 bg-white p-3 text-left transition hover:border-banking-accent/40 hover:shadow-xs disabled:opacity-50 sm:block sm:p-4">
            <span className="inline-flex shrink-0 rounded-xl bg-slate-50 p-1.5 text-banking-interactive transition group-hover:bg-banking-accent/10 sm:mb-3 sm:p-2"><SuggestionIcon symbol={suggestion.symbol} /></span>
            <span className="block text-xs font-semibold leading-5 text-banking-deep sm:text-sm">{t(suggestion.title)}</span>
            <span className="mt-1 hidden text-xs leading-5 text-banking-navy sm:block">{t(suggestion.description)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

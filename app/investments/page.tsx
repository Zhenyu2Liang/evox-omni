import Link from 'next/link';
import { banking } from '@/banking-sdk';
import { getConfig } from '@/lib/config';
import { getServerI18n } from '@/lib/i18n/server';
import { EmptyState, InvestmentProductTile } from '@/components';

export const dynamic = 'force-dynamic';

export default async function InvestmentsPage() {
  const { t } = await getServerI18n();
  const [products, holdings] = await Promise.all([
    banking.investment.listProducts(),
    banking.investment.listHoldings(getConfig().demoUserId),
  ]);
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="bank-page-heading text-2xl font-semibold text-banking-deep">{t('pages.investments.title')}</h1>
          <p className="mt-1 text-sm text-banking-navy">{t('pages.investments.summary', { products: products.length, holdings: holdings.length })}</p>
        </div>
        <Link href="/agent" className="rounded-xl bg-banking-accent px-4 py-2 text-sm font-medium text-white hover:bg-banking-accent-hover">{t('pages.investments.manage')}</Link>
      </header>
      <div className="space-y-2 rounded-2xl border border-banking-blue/15 bg-banking-blue-soft p-4 text-sm text-banking-navy">
        <p>{t('pages.investments.description')}</p>
        <p className="text-xs text-banking-navy/60">{t('business.investments.profitScope')}</p>
        <p className="text-xs text-banking-navy/60">{t('business.investments.disclaimer')}</p>
      </div>
      <section className="space-y-4" data-investment-products>
        <h2 className="text-lg font-semibold text-banking-deep">{t('pages.investments.products')}</h2>
        {products.length === 0 ? <EmptyState title={t('pages.investments.emptyProducts')} description={t('pages.investments.emptyDescription')} /> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{products.map(product => <InvestmentProductTile key={product.id} product={product} />)}</div>
        )}
      </section>
      <section className="space-y-4" data-investment-holdings>
        <h2 className="text-lg font-semibold text-banking-deep">{t('pages.investments.holdings')}</h2>
        {holdings.length === 0 ? <EmptyState title={t('pages.investments.emptyHoldings')} description={t('pages.investments.emptyDescription')} /> : (
          <div className="grid gap-4 sm:grid-cols-2">{holdings.map(holding => <InvestmentProductTile key={holding.id} product={holding.product} holding={holding} />)}</div>
        )}
      </section>
    </main>
  );
}

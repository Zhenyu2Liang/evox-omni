/**
 * Subscriptions — `/subscriptions` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read model — no HTTP hop):
 *   `banking.subscription.listSubscriptions(userId)` → `SubscriptionView[]`
 *     (name · amount · cycle · nextChargeAt · status · remind).
 *   User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
 *   ACTIVE subscriptions only (cancelled ones are excluded by the SDK).
 *
 * Composes (`../components` — read-only sibling):
 *   SubscriptionTile per row (name / monthly fee / cycle / next charge / remind),
 *   an annual-cost summary, and the empty state.
 *
 * Read-only: cancelling a subscription (`cancel_subscription`) and toggling its reminder
 * (`set_subscription_reminder`) are YELLOW agent tools — they are executed through the security
 * gateway's confirmation flow, never directly by this page.
 */
import { getConfig } from '@/lib/config';
import { addMoney, centsToMoney, moneyToCents, type MoneyAmount } from '@/lib/money';
import { banking } from '@/banking-sdk';
import type { SubscriptionCycle, SubscriptionView } from '@/banking-sdk';
import { Badge, Card, EmptyState, Money, SubscriptionTile } from '@/components';
import { getServerI18n } from '@/lib/i18n/server';

/** Billings per year for each cycle — used to annualise a subscription's fee. */
const BILLINGS_PER_YEAR: Record<SubscriptionCycle, bigint> = {
  MONTHLY: 12n,
  QUARTERLY: 4n,
  YEARLY: 1n,
};

/** Annualised cost of a single subscription (cent-safe). */
function annualCost(subscription: SubscriptionView): MoneyAmount {
  return centsToMoney(moneyToCents(subscription.amount) * BILLINGS_PER_YEAR[subscription.cycle]);
}

/** Sum of every subscription's annualised cost, cent-safe. */
function totalAnnualCost(rows: SubscriptionView[]): MoneyAmount {
  return rows.reduce((sum, row) => addMoney(sum, annualCost(row)), '0.00');
}

// Reads live Prisma data, so it must render per request — never statically prerendered at build.
export const dynamic = 'force-dynamic';

export default async function SubscriptionsPage() {
  const { t } = await getServerI18n();
  const userId = getConfig().demoUserId;

  const subscriptions: SubscriptionView[] = await banking.subscription.listSubscriptions(userId);

  const annualTotal = totalAnnualCost(subscriptions);
  const remindCount = subscriptions.filter((row) => row.remind).length;

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="bank-page-heading text-2xl font-semibold tracking-tight text-banking-deep">{t('pages.subscriptions.title')}</h1>
        <p className="mt-1 text-sm text-banking-navy">
          {t('pages.subscriptions.summary', { count: subscriptions.length })}
        </p>
      </header>

      <Card title={t('pages.subscriptions.annualSummary')} description={t('pages.subscriptions.annualDescription')}>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-banking-navy">{t('pages.subscriptions.count')}</dt>
            <dd className="mt-1 text-lg font-semibold text-banking-deep">
              {t('pages.subscriptions.itemCount', { count: subscriptions.length })}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-banking-navy">{t('pages.subscriptions.annualCost')}</dt>
            <dd className="mt-1 text-lg font-semibold text-banking-deep">
              <Money amount={annualTotal} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-banking-navy">{t('pages.subscriptions.enabledReminders')}</dt>
            <dd className="mt-1">
              <Badge tone={remindCount > 0 ? 'success' : 'neutral'}>{t('pages.subscriptions.itemCount', { count: remindCount })}</Badge>
            </dd>
          </div>
        </dl>
      </Card>

      {subscriptions.length === 0 ? (
        <EmptyState title={t('pages.subscriptions.emptyTitle')} description={t('pages.subscriptions.emptyDescription')} />
      ) : (
        <Card
          title={t('pages.subscriptions.list')}
          description={t('pages.subscriptions.listDescription')}
          padding="lg"
          footer={t('pages.subscriptions.footer')}
        >
          <ul className="flex flex-col gap-3">
            {subscriptions.map((subscription) => (
              <li key={subscription.id}>
                <SubscriptionTile subscription={subscription} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}

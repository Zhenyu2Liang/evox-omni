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
  const userId = getConfig().demoUserId;

  const subscriptions: SubscriptionView[] = await banking.subscription.listSubscriptions(userId);

  const annualTotal = totalAnnualCost(subscriptions);
  const remindCount = subscriptions.filter((row) => row.remind).length;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">订阅</h1>
        <p className="mt-1 text-sm text-banking-navy">
          共 {subscriptions.length} 项订阅 · 月费 / 下次扣费 / 年度成本
        </p>
      </header>

      <Card title="年度成本汇总" description="按计费周期折算的年化支出">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-banking-navy">订阅数量</dt>
            <dd className="mt-1 text-lg font-semibold text-banking-deep">
              {subscriptions.length} 项
            </dd>
          </div>
          <div>
            <dt className="text-xs text-banking-navy">年度成本</dt>
            <dd className="mt-1 text-lg font-semibold text-banking-deep">
              <Money amount={annualTotal} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-banking-navy">已开启续费提醒</dt>
            <dd className="mt-1">
              <Badge tone={remindCount > 0 ? 'success' : 'neutral'}>{remindCount} 项</Badge>
            </dd>
          </div>
        </dl>
      </Card>

      {subscriptions.length === 0 ? (
        <EmptyState title="暂无订阅" description="当前没有进行中的订阅。" />
      ) : (
        <Card
          title="订阅列表"
          description="名称 / 月费 / 计费周期 / 下次扣费"
          padding="lg"
          footer="取消订阅 / 修改提醒由 AI Agent 确认后执行。"
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

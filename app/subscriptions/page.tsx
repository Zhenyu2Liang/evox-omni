/**
 * Subscriptions — `/subscriptions` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read model — no HTTP hop):
 *   `banking.subscription.listSubscriptions(userId)` → `SubscriptionView[]`
 *     (name · amount · cycle · nextChargeAt · status · remind).
 *   User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
 *
 * Composes (`../components` — referenced by name only; the component library owns the API):
 *   subscription list (name / monthly fee / next charge), annual-cost summary, and the
 *   reminder-toggle / cancel actions (client cards call `/api/*` / the agent tools).
 */
import { getConfig } from '@/lib/config';
import { banking } from '@/banking-sdk';
import type { SubscriptionView } from '@/banking-sdk';

export default async function SubscriptionsPage() {
  const userId = getConfig().demoUserId;

  // TODO: wire read model — the user's subscriptions with fees, cycles and next-charge dates.
  const subscriptions: SubscriptionView[] = await banking.subscription.listSubscriptions(userId);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">订阅</h1>
        <p className="mt-1 text-sm text-banking-navy">
          共 {subscriptions.length} 项订阅 · 月费 / 下次扣费 / 年度成本
        </p>
      </header>

      {/*
        TODO: wire read model into the component library (`@/components`, read-only sibling):
          <SubscriptionList rows={subscriptions} />   // name / monthly fee / next charge
          <AnnualCostSummary rows={subscriptions} />  // annualised spend
          + reminder-toggle / cancel actions on each row.
      */}
      <section className="rounded-2xl bg-white p-6 text-sm text-banking-navy shadow-sm">
        订阅列表、年度成本汇总与提醒 / 取消操作将由 `@/components` 渲染。
      </section>
    </main>
  );
}

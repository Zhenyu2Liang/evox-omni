/**
 * Cards — `/cards` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read model — no HTTP hop):
 *   `banking.card.getCards(userId)` → `CardView[]`
 *     (type 储蓄卡/信用卡/虚拟卡 · numberMasked · status · creditLimit/availableLimit
 *      · monthlyLimit · per-category limits).
 *   User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
 *
 * Composes (`../components` — referenced by name only; the component library owns the API):
 *   CardTile (储蓄卡 / 信用卡 / 虚拟卡), credit-limit display, status badges, and the
 *   freeze / unfreeze / set-limit actions (client cards call `/api/*` / the agent tools).
 */
import { getConfig } from '@/lib/config';
import { banking } from '@/banking-sdk';
import type { CardView } from '@/banking-sdk';

export default async function CardsPage() {
  const userId = getConfig().demoUserId;

  // TODO: wire read model — the user's cards with statuses, limits and balances.
  const cards: CardView[] = await banking.card.getCards(userId);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">卡片</h1>
        <p className="mt-1 text-sm text-banking-navy">共 {cards.length} 张卡片 · 额度与状态管理</p>
      </header>

      {/*
        TODO: wire read model into the component library (`@/components`, read-only sibling):
          <CardTile card={card} />  for each card (储蓄卡 / 信用卡 / 虚拟卡) with the
          status badge and the freeze / unfreeze / set-limit actions.
      */}
      <section className="rounded-2xl bg-white p-6 text-sm text-banking-navy shadow-sm">
        卡片磁贴、额度显示与冻结 / 解冻 / 限额操作将由 `@/components` 渲染。
      </section>
    </main>
  );
}

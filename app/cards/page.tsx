/**
 * Cards — `/cards` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read model — no HTTP hop):
 *   `banking.card.getCards(userId)` → `CardView[]`
 *     (type 储蓄卡/信用卡/虚拟卡 · numberMasked · status · creditLimit/availableLimit
 *      · monthlyLimit · per-category limits).
 *   User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
 *
 * Composes (`../components` — read-only sibling; the component library owns the API):
 *   `CardTile` — one per card, rendering the type, masked number, status badge and the
 *   credit / available / monthly limits (and any per-category limits).
 *   `EmptyState` — zero-card placeholder.
 *   Card mutations (freeze / unfreeze / set-limit) are NOT wired here: they are YELLOW/RED
 *   gated tools and run through the agent's confirmation flow (see the link to `/agent`).
 */
import Link from 'next/link';
import { getConfig } from '@/lib/config';
import { banking } from '@/banking-sdk';
import type { CardView } from '@/banking-sdk';
import { CardTile, EmptyState } from '@/components';

export default async function CardsPage() {
  const userId = getConfig().demoUserId;

  // Read model: the user's cards with statuses, limits and balances.
  const cards: CardView[] = await banking.card.getCards(userId);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-banking-deep">卡片</h1>
          <p className="mt-1 text-sm text-banking-navy">共 {cards.length} 张卡片 · 额度与状态管理</p>
        </div>
        <Link
          href="/agent"
          className="rounded-xl bg-banking-accent px-4 py-2 text-sm font-medium text-white"
        >
          在 AI Agent 中管理卡片
        </Link>
      </header>

      {cards.length === 0 ? (
        <EmptyState
          title="暂无卡片"
          description="当前账户下没有已绑定的储蓄卡 / 信用卡 / 虚拟卡。"
        />
      ) : (
        <section className="grid gap-4 sm:grid-cols-2">
          {cards.map((card) => (
            <CardTile key={card.id} card={card} />
          ))}
        </section>
      )}
    </main>
  );
}

import { getConfig } from '@/lib/config';
import { banking } from '@/banking-sdk';
import CardManager from './CardManager';

// Reads live Prisma data, so it must render per request — never statically prerendered at build.
export const dynamic = 'force-dynamic';

/** Render the latest card records; manual changes remain on this page. */
export default async function CardsPage() {
  const { cards, accounts } = await banking.card.getCardPage(getConfig().demoUserId);
  return <CardManager initialCards={cards} initialAccounts={accounts} />;
}

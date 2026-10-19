/**
 * Banking SDK — card replacement FAMILY (补办链) reads.
 *
 * WHY THIS MODULE EXISTS: a lost card is replaced by a NEW `Card` row that is linked back through the
 * historical `Card.replacedByCardId` reference. The spend history is NEVER rewritten (`every
 * CardConsumption.cardId` stays exactly where it was booked), yet the monthly limit travels WITH the
 * plastic: the replacement continues the SAME billing month as the card it replaces. The current
 * month's spend therefore belongs to the whole replacement FAMILY, not to one row. The limit check in
 * `./card#consumeCard` and the derived `payableAmount` of the card projection both read the spend here
 * at the SAME business instant, so the enforced number and the displayed number cannot diverge.
 *
 * The walk is BOUNDED (`MAX_CARD_FAMILY`) with a visited/expanded set, so a corrupted
 * `replacedByCardId` cycle terminates instead of hanging, and only cards owned by the SAME user are
 * admitted, so a corrupted cross-owner pointer cannot widen the attribution.
 *
 * Read-only: nothing here writes. Card identity, ownership and the spending fences stay in `./card`.
 */
import { demoMonthRange } from '../lib/clock';
import type { DbClient } from '../lib/db/client';

/** Hard cap on how many cards ONE family walk may visit (cycle / data-drift defence). */
export const MAX_CARD_FAMILY = 64;

/**
 * Ids of `cardId` plus every card reachable through `replacedByCardId` in BOTH directions.
 *
 * `Card.replacedByCardId` is a historical reference (not a Prisma relation): a card's PREDECESSOR is
 * any row whose `replacedByCardId` is this card's id, and a card's SUCCESSOR is its own
 * `replacedByCardId`. Both directions are followed so a multi-generation chain
 * (`A → B → C`) is attributed as ONE family no matter which member is asked about.
 *
 * Only rows owned by `userId` are admitted, each id is expanded at most once, and the walk stops after
 * `MAX_CARD_FAMILY` cards — a cycle (`A → B → A`) therefore terminates with a bounded set. When the
 * card itself is not an owned row, the walk returns nothing to attribute to (never a wrong family).
 */
export async function cardFamilyIds(client: DbClient, cardId: string, userId: string): Promise<string[]> {
  const family = new Set<string>();
  const expanded = new Set<string>();
  let frontier: string[] = [cardId];

  while (frontier.length > 0 && family.size < MAX_CARD_FAMILY) {
    const ids = frontier.filter((id) => !expanded.has(id));
    if (ids.length === 0) break;
    for (const id of ids) expanded.add(id);

    const rows = await client.card.findMany({
      where: { userId, OR: [{ id: { in: ids } }, { replacedByCardId: { in: ids } }] },
      select: { id: true, replacedByCardId: true },
    });

    const next: string[] = [];
    for (const row of rows) {
      if (family.size >= MAX_CARD_FAMILY) break;
      // Skip a row already admitted: its own successor was queued when it was admitted.
      if (family.has(row.id)) continue;
      family.add(row.id);
      if (!expanded.has(row.id)) next.push(row.id);
      if (row.replacedByCardId !== null && !expanded.has(row.replacedByCardId)) next.push(row.replacedByCardId);
    }
    frontier = next;
  }

  return [...family];
}

/**
 * Current business-month card spend (CNY minor units, positive magnitude) attributed to the whole
 * replacement FAMILY of `cardId`, in the demo UTC+08:00 billing month of `now` — the SAME instant a
 * caller enforces and books with — or `demoNow()` when omitted. The rows are summed exactly, no floats.
 */
export async function cardFamilyMonthSpend(
  client: DbClient,
  cardId: string,
  userId: string,
  now?: number | Date,
): Promise<bigint> {
  const { start, end } = demoMonthRange(now);
  const family = await cardFamilyIds(client, cardId, userId);
  if (family.length === 0) return 0n;
  const rows = await client.cardConsumption.findMany({
    where: { userId, cardId: { in: family }, occurredAt: { gte: start, lt: end } },
    select: { amountMinor: true },
  });
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
}

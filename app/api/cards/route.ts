/**
 * GET /api/cards — cards read model (used by the client to refresh the `/cards` page).
 *
 * Contract:
 *  - NO query params (a `?userId=`/`?sessionId=` param is IGNORED — identity is never query-trusted).
 *  - The user is the single seeded demo user, resolved SERVER-SIDE from runtime config only
 *    (`_lib/session#resolveUserId`) — the NON-AUTHORITATIVE demo-read user for this simulated-data
 *    read. It is never used for any auth/ownership decision.
 *  - Delegates to `@/banking-sdk`: `banking.card.getCards(userId)` (GREEN read).
 *  - Success: `200 { ok: true, data: { cards: CardView[] } }`.
 *
 * Note: card MUTATIONS (freeze / unfreeze / set limit / report lost / virtual card) are NOT
 * exposed here — they are gated tools the agent invokes through the Security Gateway.
 */
import type { NextRequest } from 'next/server';
import { banking, type CardView } from '@/banking-sdk';
import { errorResponse, jsonResponse } from '../_lib/http';
import { resolveUserId } from '../_lib/session';

/** Success payload shape for `GET /api/cards`. */
export interface CardsData {
  cards: CardView[];
}

export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const userId = resolveUserId();
    const cards = await banking.card.getCards(userId);
    const data: CardsData = { cards };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}

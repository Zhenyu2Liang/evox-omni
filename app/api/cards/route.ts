/**
 * GET /api/cards — cards read model (used by the client to refresh the `/cards` page).
 *
 * Contract:
 *  - Query (validated with `cardsQuerySchema`): `{ userId?: string }`.
 *  - Delegates to `@/banking-sdk`: `banking.card.getCards(userId)` (GREEN read).
 *  - Success: `200 { ok: true, data: { cards: CardView[] } }`.
 *
 * Note: card MUTATIONS (freeze / unfreeze / set limit / report lost / virtual card) are NOT
 * exposed here — they are gated tools the agent invokes through the Security Gateway.
 */
import type { NextRequest } from 'next/server';
import { banking, type CardView } from '@/banking-sdk';
import { errorResponse, jsonResponse, parseQuery } from '../_lib/http';
import { userIdQuerySchema } from '../_lib/schemas';
import { resolveUserId } from '../_lib/session';

/** Query schema for `GET /api/cards` (private — a Next route may only export handlers). */
const cardsQuerySchema = userIdQuerySchema;

/** Success payload shape for `GET /api/cards`. */
export interface CardsData {
  cards: CardView[];
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    parseQuery(cardsQuerySchema, req);
    const userId = resolveUserId(req);
    const cards = await banking.card.getCards(userId);
    const data: CardsData = { cards };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}

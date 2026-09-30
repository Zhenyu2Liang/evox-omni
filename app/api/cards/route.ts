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
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
import { banking, type CardView } from '@/banking-sdk';
import { userIdQuerySchema } from '../_lib/schemas';

/** Query schema for `GET /api/cards`. */
export const cardsQuerySchema = userIdQuerySchema;

/** Success payload shape for `GET /api/cards`. */
export interface CardsData {
  cards: CardView[];
}

export async function GET(_req: NextRequest): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void banking;

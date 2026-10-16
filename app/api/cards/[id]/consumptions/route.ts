/**
 * GET /api/cards/[id]/consumptions — a virtual card's consumption ledger for the fixed demo user.
 *
 * Contract:
 *  - Path `id` is the card id; the optional `?limit=` (1–500) is validated by the shared
 *    `limitQuerySchema`. Card ownership is enforced INSIDE the SDK.
 *  - Identity is resolved SERVER-SIDE (`_lib/session#resolveUserId`) — the client can never name
 *    the user.
 *  - Delegates to `@/banking-sdk`: `banking.card.listCardConsumptions(userId, { cardId, limit })`
 *    (newest first; the SDK defaults to 20 and caps at 200).
 *  - Success: `200 { ok: true, data: { consumptions: CardConsumptionView[] } }`.
 */
import type { NextRequest } from 'next/server';
import { banking } from '@/banking-sdk';
import { errorResponse, jsonResponse, parseQuery } from '../../../_lib/http';
import { limitQuerySchema } from '../../../_lib/schemas';
import { resolveUserId } from '../../../_lib/session';
import type { IdRouteContext } from '../../../_lib/types';

export async function GET(request: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const { limit } = parseQuery(limitQuerySchema, request);
    const consumptions = await banking.card.listCardConsumptions(resolveUserId(), {
      cardId: (await ctx.params).id,
      limit,
    });
    return jsonResponse({ consumptions });
  } catch (error) {
    return errorResponse(error);
  }
}

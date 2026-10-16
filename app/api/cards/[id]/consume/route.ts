/**
 * POST /api/cards/[id]/consume — spend from a virtual card (local card consumption).
 *
 * Contract:
 *  - Path `id` is the card id; there are NO query params.
 *  - Identity is resolved SERVER-SIDE (`_lib/session#resolveUserId`) — a client can never name the
 *    user or spend another user's card; card ownership is enforced INSIDE the SDK.
 *  - Body: `{ amount, category?, merchant?, occurredAt?, executionKey? }`; `amount` is exact CNY
 *    decimal text (precision/format is enforced by the SDK, never here).
 *  - Delegates to `@/banking-sdk`: `banking.card.consumeCard(...)` — debits the bound account and
 *    writes a `channel='CARD'` ledger row + `CardConsumption` in one transaction, guarded by the
 *    card's monthly limit; idempotent on `executionKey`.
 *  - Success: `200 { ok: true, data: ConsumeCardResult }`. A domain refusal (unknown/foreign card,
 *    unbound/inactive card, over-limit, insufficient funds, bad amount) is the mapped error envelope.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { banking } from '@/banking-sdk';
import { errorResponse, jsonResponse, parseBody } from '../../../_lib/http';
import { resolveUserId } from '../../../_lib/session';
import type { IdRouteContext } from '../../../_lib/types';

/** Route-local body schema (module-private — only HTTP handlers/route config/types may be exported). */
const consumeCardSchema = z.object({
  amount: z.string().min(1),
  category: z.string().min(1).optional(),
  merchant: z.string().min(1).optional(),
  occurredAt: z.number().int().optional(),
  executionKey: z.string().optional(),
});

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const input = await parseBody(consumeCardSchema, req);
    const result = await banking.card.consumeCard({
      userId: resolveUserId(),
      cardId: (await ctx.params).id,
      amount: input.amount,
      category: input.category,
      merchant: input.merchant,
      occurredAt: input.occurredAt,
      executionKey: input.executionKey,
    });
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/cards/[id]/consume — spend from a virtual card (local card consumption).
 *
 * Contract:
 *  - Path `id` is the card id; there are NO query params.
 *  - Identity is resolved SERVER-SIDE (`_lib/session#resolveUserId`) — a client can never name the
 *    user or spend another user's card; card ownership is enforced INSIDE the SDK.
 *  - Body: `{ amount, category?, merchant?, executionKey? }`; `amount` is exact CNY decimal text
 *    (precision/format is enforced by the SDK, never here).
 *  - The consumption TIME is SERVER-OWNED: the SDK books every consumption at the business clock, so
 *    the card's monthly limit is always attributed to the month the server is in. There is no client
 *    time parameter at all, and a body that CONTAINS an `occurredAt` key is REJECTED — never silently
 *    stripped — before any delegation:
 *      `400 { ok: false, error: { code: 'VALIDATION', message: "Consumption time is server-owned:
 *      'occurredAt' must not be sent" } }`
 *    Key presence is judged on the RAW body, so past, future, string, number, `null` and malformed
 *    values are all rejected alike; an ABSENT key is the only accepted case. A rejected request has
 *    no side effect: no funds move, no ledger row and no `CardConsumption` row is written.
 *  - Delegates to `@/banking-sdk`: `banking.card.consumeCard(...)` — debits the bound account and
 *    writes a `channel='CARD'` ledger row + `CardConsumption` in one transaction, guarded by the
 *    card's monthly limit; idempotent on `executionKey`.
 *  - Success: `200 { ok: true, data: ConsumeCardResult }`. Every refusal — the `occurredAt` rejection
 *    above as well as a domain refusal (unknown/foreign card, unbound/inactive card, over-limit,
 *    insufficient funds, bad amount) — is the shared `_lib/http#errorResponse` envelope.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { banking } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { errorResponse, jsonResponse, parseBody } from '../../../_lib/http';
import { resolveUserId } from '../../../_lib/session';
import type { IdRouteContext } from '../../../_lib/types';

/** Route-local body schema (module-private — only HTTP handlers/route config/types may be exported). */
const consumeCardSchema = z.object({
  amount: z.string().min(1),
  category: z.string().min(1).optional(),
  merchant: z.string().min(1).optional(),
  executionKey: z.string().optional(),
});

/** Booking time is server-owned, so sending this key at all refuses the request. */
const SERVER_OWNED_TIME_KEY = 'occurredAt';
const SERVER_OWNED_TIME_MESSAGE = "Consumption time is server-owned: 'occurredAt' must not be sent";

/**
 * Validate the consume body while REJECTING a body that carries the server-owned time key.
 *
 * `parseBody` validates with a zod OBJECT schema, and zod object schemas STRIP unknown keys — so a
 * stripped `occurredAt` cannot be detected on the zod output. This reads the RAW body first and
 * refuses on KEY PRESENCE (any value: past/future/string/number/`null`), then hands the untouched raw
 * body back to the shared `parseBody` for the JSON + schema validation. An absent key is the only
 * accepted case; nothing reaches the SDK when the key is present.
 *
 * Only this route needs forbidden-key rejection today, so the plumbing stays module-private; lift it
 * into `_lib/http` if a second route needs the same guarantee.
 */
async function parseConsumeBody(req: NextRequest): Promise<z.infer<typeof consumeCardSchema>> {
  const raw = await req.text();
  let body: unknown;
  try {
    body = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION', 'Request body must be valid JSON');
  }
  if (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, SERVER_OWNED_TIME_KEY)
  ) {
    throw new AppError('VALIDATION', SERVER_OWNED_TIME_MESSAGE, { forbiddenKey: SERVER_OWNED_TIME_KEY });
  }
  // Re-wrap the already-read raw body so the shared `parseBody` owns the JSON + schema validation.
  return parseBody(
    consumeCardSchema,
    new Request(req.url, {
      method: 'POST',
      body: raw.trim() === '' ? '{}' : raw,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const input = await parseConsumeBody(req);
    const result = await banking.card.consumeCard({
      userId: resolveUserId(),
      cardId: (await ctx.params).id,
      amount: input.amount,
      category: input.category,
      merchant: input.merchant,
      executionKey: input.executionKey,
    });
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}

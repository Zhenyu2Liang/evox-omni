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
 *  - Delegates to `security/card-consumption`: the first request creates a RED proposal without
 *    moving money. A repeat with its `actionId`, `confirmed:true` and `code` authorizes the exact
 *    saved arguments through the shared MFA gateway and execution fence.
 *  - Success: `200 { ok:true, data: CardConsumptionResponse }`; only an executed response contains
 *    `result: ConsumeCardResult`. Every refusal — the `occurredAt` rejection
 *    above as well as a domain refusal (unknown/foreign card, unbound/inactive card, over-limit,
 *    insufficient funds, bad amount) — is the shared `_lib/http#errorResponse` envelope.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { submitCardConsumption } from '@/security/card-consumption';
import { moneyToCents } from '@/lib/money';
import { SPENDING_CATEGORIES } from '@/lib/contracts/spending';
import { AppError } from '@/lib/errors';
import { errorResponse, jsonResponse, readJsonBody } from '../../../_lib/http';
import { requireIdentity } from '../../../_lib/session';
import type { IdRouteContext } from '../../../_lib/types';

/** Route-local body schema (module-private — only HTTP handlers/route config/types may be exported). */
const consumeCardSchema = z.object({
  amount: z.string().min(1).max(24).refine(value => { try { return moneyToCents(value) > 0n; } catch { return false; } }),
  category: z.enum(SPENDING_CATEGORIES).optional(),
  merchant: z.string().min(1).max(64).optional(),
  executionKey: z.string().min(1).max(128).optional(),
  actionId: z.string().min(1).max(128).optional(),
  code: z.string().regex(/^\d{6}$/).optional(),
  confirmed: z.boolean().optional(),
}).strict();

/** Booking time is server-owned, so sending this key at all refuses the request. */
const SERVER_OWNED_TIME_KEY = 'occurredAt';
const SERVER_OWNED_TIME_MESSAGE = "Consumption time is server-owned: 'occurredAt' must not be sent";

/**
 * Validate the consume body while REJECTING a body that carries the server-owned time key.
 *
 * The bounded shared JSON reader checks origin, media type and bytes before decoding. Inspect the
 * raw object for the forbidden time key before strict schema validation, preserving its specific
 * error message for any value (past/future/string/number/`null`). An absent key is the only
 * accepted case; nothing reaches the SDK when the key is present.
 *
 * Only this route needs forbidden-key rejection today, so the plumbing stays module-private; lift it
 * into `_lib/http` if a second route needs the same guarantee.
 */
async function parseConsumeBody(req: NextRequest): Promise<z.infer<typeof consumeCardSchema>> {
  const body = await readJsonBody(req, true);
  if (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, SERVER_OWNED_TIME_KEY)
  ) {
    throw new AppError('VALIDATION', SERVER_OWNED_TIME_MESSAGE, { forbiddenKey: SERVER_OWNED_TIME_KEY });
  }
  const parsed = consumeCardSchema.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION', 'Invalid request body');
  return parsed.data;
}

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const input = await parseConsumeBody(req);
    const result = await submitCardConsumption(await requireIdentity(req), {
      cardId: (await ctx.params).id,
      amount: input.amount,
      category: input.category,
      merchant: input.merchant,
      executionKey: input.executionKey,
      actionId: input.actionId,
      code: input.code,
      confirmed: input.confirmed,
    });
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}

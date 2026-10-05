/**
 * app/api/_lib/schemas.ts — zod schemas shared across route handlers.
 *
 * Only genuinely shared, cross-route fragments live here. Identity (`sessionId`/`userId`) is NEVER
 * accepted from the query string — it is resolved server-side from the `banking_session` cookie
 * (`_lib/session.ts`), so there are no `sessionId`/`userId` query fragments here.
 */
import { z } from 'zod';

/** Query fragment for paginated reads (`limit` coerced from the query string). */
export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

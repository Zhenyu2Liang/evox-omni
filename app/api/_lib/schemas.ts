/**
 * app/api/_lib/schemas.ts — zod schemas shared across route handlers.
 *
 * Only genuinely shared, cross-route fragments live here (the `userId?` / `sessionId?` query
 * fragments). Route-specific schemas are declared and exported in their own route file.
 */
import { z } from 'zod';

/** Query fragment for read routes that accept an optional demo-user override. */
export const userIdQuerySchema = z.object({
  userId: z.string().min(1).optional(),
});

/** Query fragment for routes that filter by agent session. */
export const sessionIdQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
});

/** Query fragment for paginated reads (`limit` coerced from the query string). */
export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

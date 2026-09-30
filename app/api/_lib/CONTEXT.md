# app/api/_lib — shared handler plumbing (private)

## Intent

Private support code for `app/api` route handlers: the ONE place that knows the response
envelope, the `AppError` → HTTP status mapping, zod body/query parsing, SSE frame encoding, and
demo session/user resolution. Consequence: route handlers stay thin
(`validate (zod) → delegate → serialize`) and the transport contract never drifts between routes.

The leading `_` makes this a **Next.js private folder** — it is excluded from routing and can
never become an endpoint. It is not a public module: nothing outside `app/api/**` should import it.

## API Surface

- `types.ts` — app-layer transport types: `ApiEnvelope<T>`, `ApiSuccess<T>`, `ApiFailure`,
  `ApiErrorBody`, `ActionResponse`, `IdRouteContext`.
- `http.ts` — `ok`, `fail`, `mapAppError`, `jsonResponse`, `errorResponse`, `parseBody`,
  `parseQuery`; SSE helpers `SSE_HEADERS`, `sseFrame`, `sseResponse`.
- `schemas.ts` — shared zod query fragments: `userIdQuerySchema`, `sessionIdQuerySchema`,
  `limitQuerySchema`.
- `session.ts` — `resolveUserId(req?)`, `resolveSessionId(req?)`.

## Constraints

- **Pure transport only** — no business logic, no Prisma, no permission/risk decisions.
- `mapAppError` MUST map a non-`AppError` to `INTERNAL` with a generic message and MUST NOT leak
  the MFA code, stack traces, or Prisma errors.
- `parseBody`/`parseQuery` throw `AppError('VALIDATION')` on malformed input.
- The `AppError.code → HTTP` table here is the single source of truth (see `../CONTEXT.md`).

## Routing Table

- (no child nodes — leaf support modules)

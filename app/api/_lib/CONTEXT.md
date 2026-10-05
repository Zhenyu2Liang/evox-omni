# app/api/_lib — shared handler plumbing (private)

## Intent

Private support code for `app/api` route handlers: the ONE place that knows the response
envelope, the `AppError` → HTTP status mapping, zod body/query parsing, SSE frame encoding, the
TRUSTED request identity, the agent-bridge (ownership + task control + plan forwarding) and the
persisted-row → `TaskPlan` mapping. Consequence: route handlers stay thin
(`validate (zod) → delegate → serialize`) and the transport contract never drifts between routes.

The leading `_` makes this a **Next.js private folder** — it is excluded from routing and can
never become an endpoint. It is not a public module: nothing outside `app/api/**` should import it.

## API Surface

- `types.ts` — app-layer transport types: `ApiEnvelope<T>`, `ApiSuccess<T>`, `ApiFailure`,
  `ApiErrorBody`, `ActionResponse`, `IdRouteContext`.
- `http.ts` — `ok`, `fail`, `mapAppError`, `jsonResponse`, `errorResponse`, `parseBody`,
  `parseQuery`; SSE helpers `SSE_HEADERS`, `sseFrame`, `sseResponse`; the frozen
  `STATUS_BY_CODE` (`AppError.code → HTTP`) table.
- `schemas.ts` — the ONLY shared zod query fragment: `limitQuerySchema` (`{ limit? }`). Identity is
  never a query fragment (see below).
- `session.ts` — the TRUSTED identity surface:
  - `RequestIdentity { sessionId; userId }`.
  - `resolveSessionId(req?) → string | undefined` — the `banking_session` cookie (`SESSION_COOKIE`)
    ONLY; a `?sessionId=` query param is IGNORED.
  - `async resolveIdentity(req?) → RequestIdentity | null` — cookie session id, validated against a
    persisted `AgentSession` row (`getSession`); `userId` is read SERVER-SIDE from that row; `null`
    when the cookie is absent or the session is unknown.
  - `async requireIdentity(req?) → RequestIdentity` — `resolveIdentity`, else throws
    `AppError('SECURITY_DENIED')`. The fail-closed guard every authenticated handler uses.
  - `resolveUserId() → string` — takes NO `req`; `getConfig().demoUserId || DEFAULT_DEMO_USER_ID`.
    The NON-AUTHORITATIVE demo-read user, used ONLY by the four GREEN read routes
    (`dashboard`/`bills`/`cards`/`subscriptions`) that render the single seeded user's simulated
    data. It MUST NOT be used for any auth/ownership/write decision.
- `agent-bridge.ts` — the ONE module that knows the agent control/ownership/plan API:
  `resolveTaskControl(action) → TaskControlFn` (Record lookup over the STATIC `@/agent` imports
  `pauseTask`/`resumeTask`/`cancelTask`/`retryTask`, failing LOUDLY with `TOOL_FAILED` when an
  entry is missing); `confirmOwned`/`verifyOwned`/`cancelOwned` (forward the `{ userId, sessionId }`
  ownership bag); `locateOwningPlan(sessionId, actionId) → LocatedPlan | undefined`;
  `withPlanUpdate(outcome, located)` (append a refreshed `plan_update` to a SUCCESSFUL outcome).
- `task-plans.ts` — pure mapping from persisted `AgentTask`/`AgentTaskNode` rows to the
  APP-LOCAL plan type: `AgentTaskWithNodes`, `toTaskPlan(row) → AppTaskPlan`, plus
  `AppTaskPlan = Omit<TaskPlan,'results'> & { results: AppTaskNodeResult[] }` and
  `AppTaskNodeResult = TaskNodeResult & { pendingActionId? }` — `pendingActionId` is lifted from the
  node's parsed `output` (`{ pendingActionId?: string }`) via `@/agent`'s `readPendingActionId`.
  JSON columns are decoded with `safeParse`.

## Constraints

- **Pure transport only** — no business logic, no Prisma writes, no permission/risk decisions.
- **Identity is never query-trusted.** `sessionId` comes ONLY from the HttpOnly `banking_session`
  cookie; `userId` is read server-side from the owning `AgentSession` row. A `?sessionId=` /
  `?userId=` param must be ignored and must never widen access.
- `mapAppError` MUST map a non-`AppError` to `INTERNAL` with a generic message and MUST NOT leak
  the MFA code, stack traces, or Prisma errors.
- `parseBody`/`parseQuery` throw `AppError('VALIDATION')` on malformed input.
- The `AppError.code → HTTP` table here is the single source of truth (see `../CONTEXT.md`).
- `AppTaskPlan` stays assignable to the frozen `TaskPlan` — the extra `pendingActionId` is additive
  and the frozen `@/lib/contracts` is never widened here.

## Known Issues

- The root-owned `tests/app/**` specs (`actions-http.test.ts`, `plan-parking-http.test.ts`,
  `tasks-http.test.ts`) still pass identity as a `?sessionId=` QUERY param (`tests/app/harness.ts`
  has no cookie support), so their authenticated calls now get `403 SECURITY_DENIED`. They need a
  `Cookie: banking_session=<id>` header helper in `../tests/app/harness.ts` (a root-owned file).

## Routing Table

- (no child nodes — leaf support modules)

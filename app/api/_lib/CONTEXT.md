# API support context

Write destinations are trusted only through `BANKING_ALLOWED_ORIGINS` (exact canonical origins),
or loopback addresses when it is unset. A matching Host/Origin pair cannot add a trusted origin.
Configured HTTPS origins support TLS termination before Next's internal HTTP listener.

## Responsibility

This private Next.js folder owns HTTP envelopes, error mapping, request parsing, SSE framing,
fixed demo identity, agent delegation and persisted task presentation. It never becomes a route.
Server pages may use the identity helper; client components call HTTP routes instead.

## Modules

- `http.ts#assertSameOriginWrite` delegates trusted host/origin decisions to `lib/request-origin.ts` for reads as well as writes. `proxy.ts` applies the same host boundary to pages and static requests; neither forwarded headers nor matching untrusted Host/Origin values extend configured trust.
- JSON writes require `application/json`. `readJsonBody` enforces 64 KiB while reading the stream, independently of Content-Length. `app/api/chat/route.ts` enforces the 4000-character message schema before admission. Read the body once through these helpers.
- `session.ts`: `resolveUserId()` reads trusted server configuration; `resolveIdentity(req?)` and
  `requireIdentity(req?)` return the configured user and fixed `demo:${userId}` workspace through
  `getDemoSession`. The request parameter does not select identity. There is no login or
  authentication cookie. Generic internal sessions cannot be selected through this interface.
  The chain is `getConfig().demoUserId || DEFAULT_DEMO_USER_ID` → `getDemoSession(userId)` →
  `ensureDemoSession('demo:' + userId)` (idempotent upsert with `update: {}`), so the session id is
  exactly `demo:<userId>` and survives restarts. `getConfig().demoUserId` reads the `DEMO_USER_ID`
  env var with fallback `'user_liming'` (`lib/config.ts`), so `DEFAULT_DEMO_USER_ID` is the
  effective value when the env var is unset.
- `http.ts`: JSON envelopes, `AppError` status mapping, Zod body/query parsing, optional body
  parsing and SSE helpers. Unknown exceptions use a generic internal error without exposing
  credentials, stack traces or database internals.
- `schemas.ts`: shared `limitQuerySchema`; user/session identifiers are not query schema fields.
- `types.ts`: `ApiEnvelope`, `ActionResponse`, `SurfacedPendingAction` and `IdRouteContext`.
  The latter receives a promised dynamic-route `params` object. Action attention is advisory;
  it grants no permission or execution ownership. `ActionResponse.mfaResult` is one of
`'success' | 'failed' | 'not_required'` and the decision routes always set it. A refusal is TYPED:
the optional `code`, `failure: SecurityFailure` and that failure's `attemptsLeft`/`maxAttempts` are
the lock/MFA signals, so a client never parses `message`.
`SecurityFailure`/`SecurityFailureReason` are imported here only from `@/lib/contracts/security`;
`AuthorizationResult` (declared in `security/security-gateway.ts`) is never imported by this folder —
the decision routes receive an `@/agent` `ConfirmationOutcome` and copy its `code`/`failure` verbatim.
- `agent-bridge.ts`: static delegation for action confirmation, verification, cancellation and
  recovery; task controls; owning-plan lookup and refreshed plan events. It forwards the fixed
  `{ userId, sessionId }` ownership context to agent contracts. It contains no banking mutations.
- `task-plans.ts`: pure persisted-row mapping to `AppTaskPlan`, including each node's pending
  action identifier parsed from output. Financial values retain canonical string representations.
- `locked-action.ts`: `isLockedPendingActionRow(row)` and `lockedActionRefusal(actionId, row)` — the
  ONE terminal-lock guard for the action decision routes. A `locked` `PendingAction` is never
  executable, verifiable, cancellable or recoverable: `cancel`/`recover` answer it BEFORE any
  delegation with `events: []`, no write and no domain call. The refusal is a normal `200`
  `data.ok === false` domain outcome carrying `status:'locked'`, `code:'CIRCUIT_OPEN'`,
  `failure.reason:'mfa_session_locked'` and a fixed safe sentence that never interpolates the raw
  status token, contains no verification code and fabricates no attempt counters (this layer may not
  import `security/` internals nor hardcode the limit).
- `task-pending-actions.ts`: `loadPendingActionStatuses` / `annotatePendingActionStatuses` /
  `withPendingActionStatuses(ForPlans)` and the `TaskNodeWithDecisionState` /
  `TaskPlanWithDecisionState` types. Strictly additive `pendingActionStatus` on every node whose
  `pendingActionId` still resolves; one batched lookup per distinct id (never N+1). It never changes
  `node.status`, never strips `pendingActionId`, never writes and omits the field when the row is
  gone (missing evidence proves nothing).
- `public-security-event.ts`: `publicSecurityEvent(event)` plus the `PublicSecurityEvent` /
  `PublicSecurityStatus` types and the `isPublicDetailValue` predicate — the ONE public projection of
  a persisted `SecurityEvent` for the browser-facing read models. Structured facts pass through
  verbatim; a blank or internal-diagnostic `message` (`lib/public-text.ts#isInternalDiagnostic`)
  becomes `''` while real audit prose survives byte-for-byte; a `detail` is kept only when it is a
  plain JSON value whose every STRING leaf is diagnostic-free, otherwise the key is omitted entirely.
  It is the ONLY module in `_lib` importing `lib/public-text.ts` (`isInternalDiagnostic`), because a
  security-center read model must neutralize INTERNAL audit records before serializing them; no `_lib`
  module imports `lib/tool-feedback.ts` and every other type-to-text rendering stays client-side.
  Pure mapping: no I/O, no event filtering and no security decision.

## Identity and execution boundaries

All browsers share the same demo workspace, prepared on page opening. Cookie/query/body identity
values cannot select another workspace; an optional chat body session identifier is a consistency
assertion only. The language cookie stores a locale preference and does not authenticate.

Routes still compare action/task owners against the fixed demo user and session. Downstream banking
execution still requires the current permission policy, explicit confirmation or MFA where required,
matching receipts and valid execution leases. Entering the demo grants neither a payment approval nor
a circuit-breaker unlock. There is no old-session adoption or compatibility path.

## Validation and verification

Malformed schema input maps to `VALIDATION`. The HTTP status map in `http.ts` is authoritative.
Wrong MFA and other domain outcomes may return an HTTP success envelope with `data.ok === false`;
transport failure and domain outcome are separate concepts.

HTTP integration fixtures prepare `getDemoSession` for the configured user. Generic internal
multi-owner fixtures remain useful for proving ownership enforcement, but request cookies do not
select them. Tests sharing the SQLite test database must run sequentially.

# API support context

## Responsibility

This private Next.js folder owns HTTP envelopes, error mapping, request parsing, SSE framing,
fixed demo identity, agent delegation and persisted task presentation. It never becomes a route.
Server pages may use the identity helper; client components call HTTP routes instead.

## Modules

- `session.ts`: `resolveUserId()` reads trusted server configuration; `resolveIdentity(req?)` and
  `requireIdentity(req?)` return the configured user and fixed `demo:${userId}` workspace through
  `getDemoSession`. The request parameter does not select identity. There is no login or
  authentication cookie. Generic internal sessions cannot be selected through this interface.
- `http.ts`: JSON envelopes, `AppError` status mapping, Zod body/query parsing, optional body
  parsing and SSE helpers. Unknown exceptions use a generic internal error without exposing
  credentials, stack traces or database internals.
- `schemas.ts`: shared `limitQuerySchema`; user/session identifiers are not query schema fields.
- `types.ts`: `ApiEnvelope`, `ActionResponse`, `SurfacedPendingAction` and `IdRouteContext`.
  The latter receives a promised dynamic-route `params` object. Action attention is advisory;
  it grants no permission or execution ownership. `ActionResponse.mfaResult` is one of
`'success' | 'failed' | 'not_required'` and the decision routes always set it.
- `agent-bridge.ts`: static delegation for action confirmation, verification, cancellation and
  recovery; task controls; owning-plan lookup and refreshed plan events. It forwards the fixed
  `{ userId, sessionId }` ownership context to agent contracts. It contains no banking mutations.
- `task-plans.ts`: pure persisted-row mapping to `AppTaskPlan`, including each node's pending
  action identifier parsed from output. Financial values retain canonical string representations.

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

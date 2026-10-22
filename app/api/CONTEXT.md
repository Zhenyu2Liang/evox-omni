# HTTP API context

## Responsibility

The Next.js HTTP edge validates input, resolves the fixed demo workspace, delegates to domain
modules and serializes JSON or SSE. Banking mutations, permission decisions, financial arithmetic,
run recovery and workflow transitions remain in their owning modules. Nothing below imports API
route handlers. Shared transport support lives in the private `_lib` folder.

## Routing Table

- `./cards/` -> virtual-card HTTP surface: consume, consumptions, card list/add/delete and manual card changes (see `cards/CONTEXT.md`).
- `./cards/[id]/` -> per-card routes `consume` and `consumptions` (see `cards/[id]/CONTEXT.md`).
- `./_lib/` -> shared envelope, error mapping, session identity and agent bridge (see `_lib/CONTEXT.md`).
- `../cards/` -> card page plus consume/change dialogs (sibling under `app` - read-only here; escalate writes to the `app` node).
- `../../../components/banking/` -> card display components such as `CardTile` (outside `app` - read-only).

## Fixed demo identity

`_lib/session.ts` derives the user from trusted server configuration and loads the persistent
`demo:${userId}` session with `getDemoSession`. Every browser opens the same conversation and banking
workspace without login. Cookies and query identifiers cannot select another user or session.
An optional `/api/chat` body `sessionId` only asserts the canonical workspace identity; a mismatch
returns 409 before a turn is admitted. No authentication cookie is issued. The locale cookie is a
presentation preference. No previous workspace is adopted or migrated.

Resource ownership remains enforced. Action/task/run/manual-review identifiers must belong to the
fixed demo user and session, and foreign resources fail their ownership checks. The demo identity
does not replace current permission, confirmation, MFA, receipts, session revisions or leases.
Generic sessions remain available internally for runtime contracts and ownership tests, not as
selectable browser identities.

## Endpoint groups

| Group | Contract | Owning implementation |
| --- | --- | --- |
| `POST /api/chat` | Text, optional request/session consistency identifiers; SSE by default, JSON with `stream=0` | Agent turn admission and execution |
| `GET /api/actions` | Read surfaced decisions, processing/recoverable operations and reconciliation entries | Pending action repository and agent classification |
| `POST /api/actions/[id]/{confirm,verify,cancel,recover}` | Owned action decision/recovery; verification receives a code | Agent decision, authorization and recovery contracts |
| `GET /api/tasks`, `GET /api/tasks/[id]` | Persisted plans and node state, including pending action identifiers | Task repository and pure `_lib/task-plans` mapping |
| `POST /api/tasks/[id]` | Pause, resume, cancel or retry an owned plan | Agent task controls |
| `GET /api/activity` | Closed business history projection scoped to the fixed workspace | Operation history read model |
| `GET /api/audit` | Developer preference required before validated filters; scoped technical entries and summary | Audit read models |
| `GET /api/security` | Security events, lock state and failure count | Audit and security read models |
| `POST /api/security/reset` | Optional verification code; separately gated and audited unlock | Account circuit-breaker policy |
| `GET /api/{dashboard,bills,cards,subscriptions}` | Simulated banking read models for the configured user | Banking SDK |
| `/api/cards/{,[id]}` and `/api/cards/changes/[id]/{verify,cancel}` | Manual demo-card add/delete proposals plus MFA verify/cancel; returns `CardChangeResponse` | `security/manual-card-management` (see `../cards/CONTEXT.md`) |
| `POST /api/cards/[id]/consume` | Owned virtual-card consumption: exact CNY `amount` string plus optional `category`/`merchant`/`executionKey`; booking time is server-owned, so a body containing `occurredAt` is refused with `400 VALIDATION`; returns `ConsumeCardResult` | Banking SDK card-consumption capability (see `cards/[id]/CONTEXT.md`) |
| `GET /api/cards/[id]/consumptions` | Owned per-card consumption ledger, newest first; optional `limit`; returns `{ consumptions: CardConsumptionView[] }` | Banking SDK card-consumption capability (see `cards/[id]/CONTEXT.md`) |
| `GET /api/contacts`, `POST /api/contacts` | Owned masked contacts; strict name/phone form with no client-selected owner | Contact SDK and atomic contact/audit command |
| `DELETE /api/contacts/[id]` | Owned contact deletion with explicit `{ confirm: true }` decision | Contact SDK and atomic contact/audit command |
| `/api/manual-reviews` and `/api/manual-reviews/[id]` | Owned manual-review requests and recorded resolutions | Agent manual-review contracts |
| `/api/runs` and `/api/runs/[id]` | Owned run summaries; event and recovery subroutes | Durable runtime presentation and recovery |
| `GET /api/schedules`, `POST /api/schedules/tick` | Scheduled records and explicitly triggered due-task dispatch | Agent scheduling contracts |
| `POST /api/transactions/[id]/acknowledge` | Owned anomaly acknowledgement | Banking anomaly contract |
| `GET /api/health` | Operational health and configured model mode | Application configuration |

Collection reads do not execute or recover banking operations. `GET /api/actions` returns advisory
attention states and cannot acquire a lease or replay a write. Explicit action/run recovery delegates
to receipt-first runtime recovery; missing evidence never establishes success or failure. Task
controls preserve succeeded nodes and execute only work permitted by their current persisted state.

## Transport contracts

JSON success uses `{ ok: true, data }`; failure uses `{ ok: false, error: { code, message } }`.
`_lib/http.ts` owns the status map. Domain refusal or wrong MFA can be a normal HTTP 200 response
with `data.ok === false`; the envelope does not imply that money moved. Raw exceptions, stack traces,
database errors, passwords and verification codes must not be exposed.

Chat SSE emits one `data: <JSON>` frame per grounded `AgentStreamEvent` and exactly one final `done`.
The route supplies an awaited `RunTurnDeps.onEvent` sink: runtime events are persisted before they
are published. JSON mode returns the same ordered presentation events. Stable request IDs bind
transport retries to their original run, without selecting identity or granting authorization.
Raw model thinking and original provider events stay in the internal journal.

`ActionResponse` carries the action ID, persisted session ID, effective tier/status, domain outcome,
safe message and continuation events. Confirmation and verification preserve the owning plan link,
refresh its state and expose current MFA requirements without exposing the verification code.
Terminal RED metadata cannot reopen a settled action. UI card state follows current action status.

Decision routes derive `mfaResult` from the domain outcome: `success` when authorized; `failed` for a
FAILED verification (a wrong code, or an exhausted attempt limit / open circuit, i.e. `awaiting_mfa` or
`locked`); otherwise `not_required`. `ConfirmationOutcome` carries no MFA field, so the verify route
derives `mfaResult` from `status` locally; confirm never submits a code and stays `not_required`.
A wrong verification code is `200 { ok:true, data:{ ok:false, status:'awaiting_mfa', mfaResult:'failed' } }`.
Exhausting the attempt limit locks only the MFA challenge and the session circuit breaker and returns
`200` with `status:'locked'` and `mfaResult:'failed'`; the `PendingAction` row keeps its prior
status, so the lock is response-only and `GET /api/actions` keeps surfacing the row as a live decision.
The two tracked counters live outside this layer: per-action `MfaChallenge.attempts`/`maxAttempts`
against threshold `MFA_MAX_ATTEMPTS = 3`, and the authoritative owner-scoped `CircuitBreakerState`.
`POST /api/{confirm,verify,cancel}` build `ActionResponse` inline; confirm hardcodes `mfaResult:'not_required'`.

## Implementation boundaries

Keep route-local schemas private: Next.js route modules export HTTP handlers, supported route
configuration and TypeScript types only. Dynamic route parameters are awaited promises.
Handlers use `_lib/agent-bridge` for action/task delegation and persisted ownership checks before
execution. The fixed demo identity has no missing-cookie rejection branch.

## Known issues

- `POST /api/actions/[id]/verify` (`app/api/actions/[id]/verify/route.ts`) returns HTTP `200` for
  every domain outcome, including the circuit-breaker `status:'locked'` case: it always serializes
  `jsonResponse<ActionResponse>(mapped)` (`:91`) and never throws `CIRCUIT_OPEN`, so the `423` status
  named in the route comment (`:16`) and defined in `_lib/http.ts` is not reached from this route.
- The verify route emits no `action_settled`/`mfa_required`/`confirmation_required` stream events of
  its own (`:88` only forwards `outcomeWithPlan.events`). `action_settled` has no server producer at
  all (client-only, `components/chat/actions.ts`); closing the MFA prompt is left to the client.
- On a `'locked'` verify outcome `events` is `plan_update` only: `blockedOutcome`
  (`agent/confirmation/outcomes.ts`) emits `mfa_required` only for `pending`/`awaiting_mfa`, and the
  decision `withPlanUpdate` (`_lib/agent-bridge.ts:170`) appends is `undefined` because
  `nextPlanDecision` (`agent/task-decision.ts`) ignores rows not in `pending`/`awaiting_mfa`. The
  locked row keeps its prior status, so `attentionFor` (`actions/route.ts:79`) still classes it
  `decision`.

Developer documentation lives in `docs/cn`; this context records AI-facing module boundaries.
HTTP fixtures use the configured demo workspace. Cookie/query forgery fixtures verify that browser
parameters cannot change that workspace; internal foreign-resource fixtures verify that ownership
still fails closed. Database tests run sequentially. Keep test and build output under `logs/`.

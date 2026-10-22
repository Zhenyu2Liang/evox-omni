# HTTP API context

## Responsibility

The Next.js HTTP edge validates input, resolves the fixed demo workspace, delegates to domain
modules and serializes JSON or SSE. Banking mutations, permission decisions, financial arithmetic,
run recovery and workflow transitions remain in their owning modules. Nothing below imports API
route handlers. Shared transport support lives in the private `_lib` folder.

## Routing Table

- `./cards/` -> virtual-card HTTP surface: consume, consumptions, card list/add/delete and manual card changes (see `cards/CONTEXT.md`).
- `./cards/[id]/` -> per-card routes `consume` and `consumptions` (see `cards/[id]/CONTEXT.md`).
- `./_lib/` -> shared envelope, error mapping, session identity, agent bridge, the terminal-lock refusal (`locked-action.ts`), the additive task-plan action-status projection (`task-pending-actions.ts`) and the public security-event projection (`public-security-event.ts`) (see `_lib/CONTEXT.md`).
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
| `POST /api/actions/[id]/{confirm,verify,cancel,recover}` | Owned action decision/recovery; verification receives a code; a `locked` row is refused without any write | Agent decision/authorization/recovery contracts and `_lib/locked-action` |
| `GET /api/tasks`, `GET /api/tasks/[id]` | Persisted plans and node state, including pending action identifiers and each parked action's current status (`pendingActionStatus`) | Task repository, pure `_lib/task-plans` mapping and `_lib/task-pending-actions` |
| `POST /api/tasks/[id]` | Pause, resume, cancel or retry an owned plan | Agent task controls |
| `GET /api/activity` | Closed business history projection scoped to the fixed workspace | Operation history read model |
| `GET /api/audit` | Developer preference required before validated filters; scoped technical entries and summary | Audit read models |
| `GET /api/security` | Public projection of the security events (`events` and `status.recentEvents`, see below), lock state, failure count, a typed `lock` reason while the breaker is open and the session's terminal `lockedActions` | Audit and security read models plus `_lib/public-security-event` |
| `POST /api/security/reset` | Optional body `{ verificationCode? }`; separately gated and audited unlock that reopens no `PendingAction` and executes nothing; success adds `lockedActionsReopened: false` | Account circuit-breaker policy |
| `POST /api/developer/security/reset` | Developer-mode cookie gate, then the unaudited-code demo clear `resetDemoSession` (audit actor `developer`); returns the raw `CircuitBreakerState`, reopens no `PendingAction` | `_lib/developer.ts` + account circuit-breaker policy |
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

## Public security-event projection

`GET /api/security` serializes no raw `SecurityEvent`: both `events` and `status.recentEvents` are
mapped through `_lib/public-security-event.ts#publicSecurityEvent`, because a persisted security
event is an INTERNAL audit record whose text may carry the gateway's `__SECURITY_BLOCK__…` payload.
`id`/`timestamp`/`sessionId`/`userId`/`kind`/`severity` are forwarded verbatim and `status.locked` is
untouched, so the feed keeps every structured fact a client renders.
`message` stays a required string: legitimate audit prose survives byte-for-byte, while a blank,
whitespace-only or internal-diagnostic message (`lib/public-text.ts#isInternalDiagnostic`) becomes
`''` — never a substitute sentence, so the client keeps owning its localized `kind` label.
`detail` is kept only when it is a plain JSON value whose every STRING leaf is diagnostic-free;
otherwise the key is omitted entirely (`'detail' in event === false`), so the breaker-trip evidence
`{ failures, max, result }` survives while `{ note: '__SECURITY_BLOCK__…' }` does not.
No event is dropped and no event count changes: the projection is pure, read-only and decides
nothing, and the gateway marker therefore never leaves this edge through the security center.
`app/security/page.tsx` reads the audit and security nodes directly instead of this route and applies
its own equivalent text funnel, including to `status.recentEvents`.

The rest of this node was swept for the same class of leak and needs no app-layer projection.
`/api/schedules` and `/api/schedules/tick` are thin delegations, and `agent/scheduled-dispatcher.ts`
already reduces a dispatch failure through `publicDispatchError`
(`isInternalDiagnostic(message) ? DISPATCH_FAILURE_NOTICE : message`).
`/api/audit` is a developer-mode-gated technical surface that returns the audit node's own entries and
summary, so its contract stays unchanged.
`/api/activity` returns the closed business history projection of `audit/operation-history.ts`, which
is not built from security events.
`_lib/http.ts#errorResponse`/`mapAppError` already reduce a non-`AppError` throw to a generic internal
error, so a failure envelope carries no diagnostics.
Chat SSE frames, `/api/runs/[id]/events` and `/api/chat/history` still forward `AgentStreamEvent`
frames verbatim (see Known issues): `security_event.message` can carry the raw marker, clients render
those events from typed fields, and scrubbing them belongs to `agent/` and `components/chat`.

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
Exhausting the attempt limit locks the MFA challenge and the session circuit breaker and returns
`200` with `status:'locked'` and `mfaResult:'failed'`; the gateway also persists `PendingAction.status = 'locked'` (a CAS from the prior
status), so the row is terminal and `GET /api/actions` stops surfacing it (`attentionFor` maps `locked` to `undefined`).
The two tracked counters live outside this layer: per-action `MfaChallenge.attempts`/`maxAttempts`
against threshold `MFA_MAX_ATTEMPTS = 3`, and the authoritative owner-scoped `CircuitBreakerState`.
`POST /api/{confirm,verify,cancel}` build `ActionResponse` inline; confirm hardcodes `mfaResult:'not_required'`. `_lib/agent-bridge.ts:163-175` (`withPlanUpdate`) drops any `mfa_required`/`confirmation_required` event whose `actionId` equals the refreshed `nextPlanDecision` action id and appends that decision last, so the persisted plan owns the re-prompt.
A refusal is TYPED, never message-parsed: `ActionResponse` (`_lib/types.ts:44-65`) additively exposes optional `code`, the complete `failure: SecurityFailure` (whose `reason` distinguishes `mfa_code_invalid`, `mfa_attempts_exhausted`, `mfa_session_locked`, `circuit_open`, `denied`) plus that failure's optional `attemptsLeft`/`maxAttempts`. `agent/confirmation/outcomes.ts#blockedOutcome` derives them from the gateway refusal and still emits no events for a `locked` outcome.
Contrast `POST /api/cards/changes/[id]/verify`, which lets `AppError('CIRCUIT_OPEN')` bubble out as a `423` failure envelope WITH `code` (`security/manual-card-management.ts:71,112`), so the cards page localizes by code; the action routes deliberately do not.

`data.message` provenance per route: `verify`/`confirm` copy `ConfirmationOutcome.message` verbatim (the gateway sentence on a refusal; `操作已执行。`/`result.error`/`操作结果尚无法核实…` plus a `（结果播报失败：…）` suffix from `agent/confirmation/authorized-execution.ts:94-100`; `该操作所属的任务计划已取消…` from `cancelledPlanOutcome`; the `AppError.message` from `conflictOutcome`), `cancel` `操作已取消。` (`agent/confirmation.ts:69`) except on a `locked` row, which is refused before delegation with the fixed `_lib/locked-action` sentence, `recover` the recovery outcome's own text (or the same fixed sentence on a `locked` row).
No action route localizes: the i18n fallbacks (`chat.error.toolFailed`, `chat.error.securityLocked`) exist only client-side (`lib/public-text.ts#securityNotice`, `lib/tool-feedback.ts`), so a non-browser caller (e.g. `channels/weixin/`) reading `data.message` gets the server's Chinese sentence, never 「操作未完成。请核对原操作卡片和账户记录。」. No action route under `app/api` imports `lib/public-text.ts` (`securityNotice`, `safePublicText`) or `lib/tool-feedback.ts` (`publicToolError`): the edge forwards the typed `code`/`failure` plus the raw server sentence, so every refusal is rendered client-side.
The only `lib/public-text.ts` consumer in this node is `_lib/public-security-event.ts` (`isInternalDiagnostic`), which neutralizes internal audit text in the `GET /api/security` public projection.
TWO distinct lock sentences reach `data.message` with the SAME `ok:false`/`status:'locked'`: the attempt-limit branch 「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」 (`security/security-gateway.ts` `authorizeWithMfa` attempt-exhausted branch) and every later attempt on the already-persisted `locked` row via `lockedOutcome` 「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」 (`security/security-gateway.ts` `lockedOutcome`, reached from the `row.status === 'locked'` guard at the top of `authorizeAction`). Those two refusals also differ INSIDE `failure`: the attempt-exhausted one carries `failure.code:'MFA_LOCKED'` with `reason:'mfa_attempts_exhausted'` and real `attemptsUsed`/`attemptsLeft`/`maxAttempts` while its top-level `code` is `CIRCUIT_OPEN`, whereas `lockedOutcome` carries `failure.code:'CIRCUIT_OPEN'` (`reason` `mfa_session_locked`/`circuit_open`) with a fixed `attemptsLeft:0`/`maxAttempts`, so a renderer must key on `reason` and never on one field alone.
A `confirm` (no code) on a `locked` row also returns `status:'locked'`/`ok:false`, but with `mfaResult:'not_required'` and `requiresMfa:true` (RED tier), never `'failed'`.

## Terminal MFA lock
Exhausting the MFA attempt limit (`MFA_MAX_ATTEMPTS = 3`) is a TERMINAL state: `security/security-gateway.ts` CASes `PendingAction.status` from `pending`/`awaiting_mfa` to `'locked'`, locks the `MfaChallenge`, trips the account circuit breaker and records the `SecurityEvent` audit. No app-layer path writes a `'locked'` row back to `pending`/`awaiting_mfa`.
Surfacing: `attentionFor` (`actions/route.ts:77-92`) maps only `pending`/`awaiting_mfa` to `'decision'`, `needs_reconciliation` to `'reconciliation'`, and every other status (including `locked`) to `undefined`, so `GET /api/actions` never lists a locked row and offers no verification entry point.
Refusal shape: every action decision route answers a `locked` row with a normal `200 { ok:true, data:{ ok:false } }` domain outcome carrying `status:'locked'`, `code:'CIRCUIT_OPEN'`, `failure:{ code:'CIRCUIT_OPEN', reason:'mfa_session_locked', actionId }` and a fixed safe sentence that names the terminal lock and requires a new request. `confirm`/`verify` derive `mfaResult` (`not_required` / `failed`); `cancel`/`recover` short-circuit through `_lib/locked-action.ts#lockedActionRefusal` BEFORE any delegation with `events: []`, no `cancelOwned`/recovery call and no write, so the row and its owning plan stay exactly as the gateway left them.
Tasks: `GET /api/tasks` and `GET /api/tasks/[id]` additively annotate every node whose `pendingActionId` still resolves with `pendingActionStatus` — the action's CURRENT persisted status. `node.status` (`waiting_confirmation`/`waiting_verification`) and `node.pendingActionId` stay untouched, and a missing row omits the field rather than inventing a status.
Security surface: `GET /api/security` reports `lock?: SecurityFailure` (`{ code:'CIRCUIT_OPEN', reason:'circuit_open' }`, present only while the breaker is open) and `lockedActions: LockedActionSummary[]` (`actionId`/`toolName`/`tier`/`requiresMfa`/`updatedAt`, newest lock first) as factual records, never as actionable items.
Unlock: `POST /api/security/reset` clears only the account circuit breaker (`security/circuit-breaker.ts#commitAuditedReset`, which writes the `SECURITY_RESET` audit and renews `MfaChallenge` rows only for actions still `awaiting_mfa`). It writes no `PendingAction` row, so a locked action keeps its status, never reappears as a decision and is never executed; the success payload states this additively via `lockedActionsReopened: false`. Replacing a locked write requires a NEW request through the normal authorization gate.

App-layer details of that unlock surface:
`lockedActionsReopened` is a compile-time constant (`security/reset/route.ts:52`, emitted at `:92`), NOT an observation — the reset route reads no `PendingAction` and never checks whether locked rows exist.
The request schema is only `{ verificationCode?: string }`; `actor: 'user'` and the Chinese `RESET_REASON` (`:46`) are hardcoded, and an empty-string code is dropped by the `verificationCode ? … : {}` spread (`:84`) before reaching `circuitBreaker.resetSession`.
No `now` is forwarded, so the cooldown gate uses the security node's real clock.
An account locked without a code therefore throws `AppError('CIRCUIT_OPEN')` from the security node and `errorResponse` maps it to HTTP `423` (`_lib/http.ts:24`) with `{ ok:false, error:{ code:'CIRCUIT_OPEN', message } }`; the human sentence is the security node's, never localized here.
Dev-mode is NOT required: the route uses `requireIdentity` only, and the developer-only variant is the separate `POST /api/developer/security/reset` (`_lib/developer.ts#requireDeveloperMode` reads the `banking_developer_mode` cookie).
`GET /api/security` derives `lockedActions` from `listPendingActions({ sessionId, status: 'locked' })` (repository default page = 100 rows), skips `manual_add_card`/`manual_delete_card`, and re-sorts by `updatedAt` desc; `lock` is present only while the breaker is open and is the fixed `{ code:'CIRCUIT_OPEN', reason:'circuit_open' }`.
The `lock?: SecurityFailure` / `lockedActions` fields are additive and optional, so consumers that ignore them keep working.
`confirm` and `verify` apply NO app-layer locked short-circuit (unlike `cancel`/`recover`): they delegate and then derive `mfaResult` from the returned `status`, forwarding whatever `code`/`failure` the agent/security path produced.

## Implementation boundaries

Keep route-local schemas private: Next.js route modules export HTTP handlers, supported route
configuration and TypeScript types only. Dynamic route parameters are awaited promises.
Handlers use `_lib/agent-bridge` for action/task delegation and persisted ownership checks before
execution. The fixed demo identity has no missing-cookie rejection branch.

## Known issues

- `POST /api/actions/[id]/verify` (`app/api/actions/[id]/verify/route.ts`) returns HTTP `200` for
  every domain outcome, including the circuit-breaker `status:'locked'` case: it always serializes
  `jsonResponse<ActionResponse>(mapped)` (`:94`) and never throws `CIRCUIT_OPEN`, so the `423` status
  named in the route comment (`:16`) and defined in `_lib/http.ts` is not reached from this route.
- The verify route emits no `action_settled`/`mfa_required`/`confirmation_required` stream events of
  its own (`:88` only forwards `outcomeWithPlan.events`). `action_settled` has no server producer at
  all (client-only, `components/chat/actions.ts`); closing the MFA prompt is left to the client.
- The edge never rewrites agent text: `verify/route.ts:79-91` copies `outcome.message` and
  `outcomeWithPlan.events` into `ActionResponse` unchanged (`ConfirmationOutcome.result` is dropped),
  and `chat/route.ts:83` writes every `AgentStreamEvent` as a verbatim SSE frame via `_lib/http.ts:124`
  `sseFrame`. A block reason built by `security/security-gateway.ts` `BLOCK_REASON_PREFIX` (`__SECURITY_BLOCK__` + JSON,
  e.g. `{"decisionKind":"deny"}`) therefore reaches the browser inside `security_event.message` and any
  tool-error text. The action routes' own lock refusal IS typed (`code`/`failure`), but stream frames
  stay verbatim, so there is no app-layer scrubbing or error-code
  mapping point for them. The same verbatim pass-through exists at `runs/[id]/events/route.ts:18` (`readRunPresentation` frames) and `../agent/history.ts:36-37` (persisted message cards re-emitted unchanged, so a stored `error` card keeps its text). `agent/turns/events.ts:49,73` puts the RAW marker into `security_event.message` and recognizes it only when the text STARTS WITH the prefix; `confirm`/`recover` forward `outcome.events` unchanged and `resumeTurn` (`agent/run-turn.ts:96`) installs the same handler, so a continuation that re-attempts a blocked tool can stream the marker too. The action routes' own `data.message` carries no marker: `AuthorizationResult.message` is always a human sentence and the prefixed payload lives only in `blockReason` / `GatedToolOutcome.error` (`agent/confirmation/gated-execution.ts:66`).
- A `'locked'` verify outcome appends no `mfa_required`: `blockedOutcome`
  (`agent/confirmation/outcomes.ts`) emits it only for `pending`/`awaiting_mfa`, so the only possible
  appended event is `plan_update` (and `nextPlanDecision`, `agent/task-decision.ts`, skips rows outside
  `pending`/`awaiting_mfa`). The row itself is already persisted `'locked'` by `persistLockedAction`
  (`security/security-gateway.ts` `persistLockedAction`), so `attentionFor` (`actions/route.ts:79`) drops it from
  `GET /api/actions`.
- `app/` never writes `PendingAction.status`: every hit is a comparison or read (`app/agent/history.ts:26`,
  `app/agent/plan-history.ts:24`). No retry/recover/claim/liveness endpoint here can reopen a `'locked'`
  row; all status mutation lives in `@/agent`, `@/security` and `lib/db/repositories/pendingAction.ts`.
- `POST /api/tasks/[id]` forwards control actions to `agent/workflows/controls.ts`, whose `RESUMABLE` set still includes `waiting_confirmation`, so `resume`/`retry` can restart a plan whose parked `PendingAction` is `locked`. This edge only REPORTS the lock (`pendingActionStatus`) and does not veto the control; the gate belongs in `agent/`.
- `components/` and `channels/` do not yet read `pendingActionStatus`, `lock` or `lockedActions`; all three are additive and optional, so existing consumers keep working unchanged.
- `DECISION_STATUSES` (`actions/route.ts:58`) is declared but never referenced: the surfacing filter is `attentionFor` (`:77-92`) alone, and `listPendingActions({ sessionId })` (`:130`) applies NO database status filter — it pages the session's newest 100 rows (`lib/db/repositories/pendingAction.ts:84,120-136`) and the route drops non-attention rows in memory.

Developer documentation lives in `docs/cn`; this context records AI-facing module boundaries.
HTTP fixtures use the configured demo workspace. Cookie/query forgery fixtures verify that browser
parameters cannot change that workspace; internal foreign-resource fixtures verify that ownership
still fails closed. Database tests run sequentially. Keep test and build output under `logs/`.

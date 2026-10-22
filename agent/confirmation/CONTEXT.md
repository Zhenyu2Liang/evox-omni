# Confirmation / authorization-decision context

Human decisions (`confirm` / MFA `verify` / `cancel`) authorize the PERSISTED `PendingAction` arguments through the Security Gateway (`@/security`); the model never grants execution.
This submodule is the agent-side facade plus the durable lease bookkeeping around that gateway, and it owns the PUBLIC projection of every refusal.

## API Surface

- `../confirmation.ts` (parent) — public `confirmAction` / `verifyAction` / `cancelAction`; `confirm`/`verify` are wrapped by `withLiveConfirmation`. `authorizeAndExecute(actionId, opts, mfaCode?)` resolves identity, short-circuits a cancelled owning plan, calls `gateway.authorizeAction`, and returns `blockedOutcome` when `!auth.ok`. `cancelAction` proves the persisted row reached `cancelled` before reporting success.
- `contracts.ts` — `ConfirmOptions`, `ConfirmationOutcome`, `GatedToolOutcome`, `TrustedIdentity`.
- `identity.ts` — `resolveTrustedIdentity`: persisted-owner assertion, never a grant.
- `liveness.ts` — `withLiveConfirmation`: takes the durable execution lease; a lease conflict → `conflictOutcome`.
- `outcomes.ts` — `blockedOutcome`, `cancelledPlanOutcome`, `conflictOutcome`, `unappliedCancelOutcome`, `publicRefusalMessage`, `effectiveTier`, `emitAll`.
- `authorized-execution.ts` — lands authorized command evidence before narration.
- `gated-execution.ts` — `executeGatedTool` (the workflow execution port; re-exported by `../confirmation.ts`).
- `plan-continuation.ts` — resumes downstream graph nodes without rewriting a committed business result.

## Contracts

`ConfirmationOutcome = { ok: boolean; actionId: string; status: PendingActionStatus; tier: RiskLevel; requiresMfa: boolean; message: string; code?: ErrorCode; failure?: SecurityFailure; result?: ToolExecutionResult; events: AgentStreamEvent[] }`.

EVERY `!ok` outcome carries a typed `code`, and a security refusal additionally carries the structured `failure` (`code` + `reason` + attempt facts).
`message` is always public: a server-authored business sentence (`'操作已取消。'`, the cancelled-plan refusal) or one rendered by the ONE funnel `lib/public-text.ts`.
`message` never contains an internal status literal (`locked`, `cancelled`, …), an action/session id, JSON, a stack trace or a `__SECURITY_BLOCK__` payload.
Callers read the typed fields; no caller parses `message`.

`PendingActionStatus` (`@/lib/contracts/security`) = `'pending' | 'awaiting_mfa' | 'confirmed' | 'executed' | 'failed' | 'cancelled' | 'locked' | 'needs_reconciliation'`.

`agent/action-status.ts` is the status vocabulary: `isOpenActionStatus` / `isTerminalActionStatus` / `mayPromptForDecision` replace every local literal comparison in this directory.

The gateway's `AuthorizationResult` (`@/security/security-gateway`) carries `ok, status, actionId, tier, requiresMfa, mfaResult?, code?: ErrorCode, failure?: SecurityFailure, message, action?`; `mfaResult` is not part of `ConfirmationOutcome`.

## Refusal text comes from the funnel

`outcomes.ts` `publicRefusalMessage(text, { code?, failure? }, fallback)` is the single refusal renderer.
Complete typed facts (`failure`) → `securityNotice(failure, t)`, which renders from `reason`/`code`/`attemptsLeft` and never from text.
A code without facts → `publicToolError(text, t, fallback, code)`, i.e. the catalog's rendering for that code (an allow-listed business sentence still wins).
No typed facts at all → `safePublicText(text, t, fallback)`: allow-listed business text, else the catalog fallback; `isInternalDiagnostic` text (`__SECURITY_BLOCK__…`, JSON fragments, stack traces, `undefined`/`null`) always becomes the fallback.
Refusals are server-authored in `DEFAULT_LOCALE` through one module-level `createTranslator(DEFAULT_LOCALE)`; this layer has no per-request locale.

`cancelledPlanOutcome` reports the module constant `'该操作所属的任务计划已取消，已拒绝执行。'` with `code: 'SECURITY_DENIED'` and `failure: { code, reason: 'denied', actionId }`; the owning `taskId` stays in the persisted plan and never enters the text.
`conflictOutcome` forwards a recovered wedge outcome unchanged and types a `!ok` recovery with `code: 'CONFLICT'` (no `failure`, because `'denied'` would misdescribe an unknown outcome).
The plain-conflict branch (the gateway throws `AppError('CONFLICT', …)`, whose text interpolates the raw status literal) reports `code: error.code` + `failure` and funnels the thrown text with the `chat.error.stateChanged` fallback.
`unappliedCancelOutcome` is the cancel that did NOT settle: `ok:false`, the persisted status, `code:'CONFLICT'` + `failure`, and the `chat.error.stateChanged` sentence.

`identity.ts` throws `AppError('NOT_FOUND' | 'SECURITY_DENIED', …)` with business sentences that carry NO action id, session id or internal token; the HTTP error envelope renders that `message`.
`liveness.ts` `beginExecutionLease` treats only `isOpenActionStatus(row?.status)` as a blocking lease conflict, so a terminal row is never held as an undecided decision.

`plan-continuation.ts` never publishes a raw error: the `error` event carries `safePublicText(failure.message, t, 'chat.error.unknownOutcome')` plus `code: AppError.from(error).code`, and a forwarded node error that `isInternalDiagnostic` is replaced by `securityNotice({ code: result.errorCode }, t)` (or `t('chat.error.operationNotStarted')` when no code exists).

## Constraints

- Ownership is fail-closed: `ConfirmationOutcome` is built from persisted state, never from request-supplied text. `verifyAction` can still THROW `AppError('NOT_FOUND' | 'SECURITY_DENIED')` and (via the gateway) `'CONFLICT'`; a `CONFLICT` is converted to `conflictOutcome`.
- `blockedOutcome.events` emits `{ type: 'mfa_required', actionId, action }` ONLY when `view.requiresMfa && mayPromptForDecision(view.status)`, so every terminal status (including `'locked'`) gets `events: []` — a terminal prompt intentionally requests no further code.
- NO module under `agent/` produces an `action_settled` event: the type is declared in `lib/contracts/agent.ts` and its only emitter repo-wide is the browser client (`components/chat/actions.ts`, for `confirmed` plus `TERMINAL_ACTION_STATUSES`, which includes `locked`).
- Both `liveness.ts` (`withLiveConfirmation`) and `gated-execution.ts` (`executeGatedToolOnce`) refuse `isManualCardCommand` tool names (`manual_add_card` / `manual_delete_card`, `@/lib/contracts/card-management`) with `SECURITY_DENIED` — card creation/deletion must go through the card management page, not the confirmation flow.
- `cancelAction` writes its audit row only after the persisted row is proven `cancelled`; `NOT_FOUND` / `SECURITY_DENIED` keep throwing.
- No path here unlocks, re-activates, resumes or auto-executes a locked or otherwise terminal operation.

## A locked MFA outcome is terminal and carries EMPTY events

When wrong MFA codes trip the session circuit breaker (`security/mfa.ts` `verify` → `security/security-gateway.ts` `authorizeWithMfa`), the gateway returns `status: 'locked'`, `requiresMfa: true`, `tier: 'RED'`, `code: 'CIRCUIT_OPEN'`, `mfaResult: 'failed'`, a typed `failure` and a lock message, AND durably persists the row via `persistLockedAction` — a race-safe CAS from `['pending', 'awaiting_mfa']` → `'locked'` (from an undecided state ONLY; a concurrent/terminal row is never clobbered and a lost CAS is benign).
`blockedOutcome` still emits `events: []` (a `locked` row is not an open decision), i.e. no `mfa_required` and no `action_settled`.
Because the row is now terminal, it is no longer surfaced as a pending decision and `nextPlanDecision`/`withPlanUpdate` do NOT re-emit `mfa_required` for it — the MFA popup does not reappear.
A re-attempt on the row returns the SAME idempotent `lockedOutcome` (no new challenge, no consumed attempt, no re-prompt), because `authorizeAction` short-circuits a `'locked'` row before the undecided guard.
`cancelAction` on such a row is refused by the HTTP edge as a terminal lock domain outcome; the facade never reports it as cancelled.
No `ToolExecutionResult` is ever built for a lock: `authorizeAndExecute` returns `blockedOutcome` and SKIPS `executeAuthorizedAction`, so there is no `result`, and `performAuthorizationResume` is not called.
The lock reaches the UI as `status: 'locked'`, the typed `code`/`failure`, and the funnel-rendered `message` on the HTTP `ActionResponse`.

### What a lock publishes: a typed code, a catalog sentence, never a tool event

- No `ToolEventView`, no `tool_end` and no public `summary`/`errorCode` is produced for a lock: `publishAuthorizedToolOutcome` (`agent/turns/buffer.ts`) is unreachable from confirm/verify.
- The two lock shapes are rendered from their typed facts: the attempt-limit lock (`failure.reason === 'mfa_attempts_exhausted'`) → `chat.error.actionLocked`, and the session-circuit lock (`code/reason` `CIRCUIT_OPEN` / `circuit_open`) → `chat.error.securityLocked`.
- A wrong but retryable code (`reason: 'mfa_code_invalid'`) → `chat.error.verificationRemaining` with the real `attemptsLeft`, status still `awaiting_mfa`, and `mfa_required` re-published.
- The only agent-emitted public event with `kind: 'locked'` is `agent/turns/events.ts` `security_event`, reached ONLY from a model-driven `beforeToolCall` deny, never from confirm/verify; because `parseBlockReason` returns `null` for a payload without `actionId`, that event's `message` is the RAW `__SECURITY_BLOCK__{"decisionKind":"deny"}` string as a system chat message (owned by `agent/turns/`).
- `gated-execution.ts` copies `auth.blockReason ?? auth.decision.message` into `GatedToolOutcome.error`, so a raw marker can still travel into a plan node through `plan-continuation.ts`; `publicPlanError` replaces such an internal diagnostic before it is persisted as the node error.
- `components/chat/cards/MfaCard.tsx` renders the reason line only for `terminal === 'failed'`; a `locked` card shows `cards.terminal.locked` and exposes the message in developer mode only.
- At the HTTP edge (`app/api/actions/[id]/verify/route.ts`) a locked verification reports `status: 'locked'`, `requiresMfa: true` and `mfaResult: 'failed'`.

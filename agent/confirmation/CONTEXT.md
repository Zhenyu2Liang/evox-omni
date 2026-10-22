# Confirmation / authorization-decision context

Human decisions (`confirm` / MFA `verify` / `cancel`) authorize the PERSISTED `PendingAction` arguments through the Security Gateway (`@/security`); the model never grants execution. This submodule is the agent-side facade plus the durable lease bookkeeping around that gateway.

## API Surface

- `../confirmation.ts` (parent) — public `confirmAction` / `verifyAction` / `cancelAction`; each is wrapped by `withLiveConfirmation`. `authorizeAndExecute(actionId, opts, mfaCode?)` resolves identity, short-circuits a cancelled owning plan, calls `gateway.authorizeAction`, and returns `blockedOutcome` when `!auth.ok`.
- `contracts.ts` — `ConfirmOptions`, `ConfirmationOutcome`, `GatedToolOutcome`, `TrustedIdentity`.
- `identity.ts` — `resolveTrustedIdentity`: persisted-owner assertion, never a grant.
- `liveness.ts` — `withLiveConfirmation`: takes the durable execution lease; a lease conflict → `conflictOutcome`.
- `outcomes.ts` — `blockedOutcome`, `cancelledPlanOutcome`, `conflictOutcome`, `effectiveTier`, `emitAll`.
- `authorized-execution.ts` — lands authorized command evidence before narration.
- `gated-execution.ts` — `executeGatedTool` (the workflow execution port; re-exported by `../confirmation.ts`).
- `plan-continuation.ts` — resumes downstream graph nodes without rewriting a committed business result.

## Contracts

`ConfirmationOutcome = { ok: boolean; actionId: string; status: PendingActionStatus; tier: RiskLevel; requiresMfa: boolean; message: string; code?: ErrorCode; failure?: SecurityFailure; result?: ToolExecutionResult; events: AgentStreamEvent[] }` (`contracts.ts:15-28`) — the typed refusal code and the structured failure ARE part of the outcome, so a caller never parses `message`.

`PendingActionStatus` (`@/lib/contracts/security`) = `'pending' | 'awaiting_mfa' | 'confirmed' | 'executed' | 'failed' | 'cancelled' | 'locked' | 'needs_reconciliation'`.

The gateway's `AuthorizationResult` (`@/security/security-gateway`) additionally carries optional `mfaResult: 'success' | 'failed' | 'not_required'`; `mfaResult` stays gateway-only, while `code` and `failure` are copied into `ConfirmationOutcome` (`outcomes.ts:73-74`).

## Constraints

- Ownership is fail-closed: `ConfirmationOutcome` is built from persisted state, never from request-supplied text. `verifyAction` can still THROW `AppError('NOT_FOUND' | 'SECURITY_DENIED')` and (via the gateway) `'CONFLICT'`; a `CONFLICT` is converted to `conflictOutcome`.
- `blockedOutcome.events` emits `{ type: 'mfa_required', actionId, action }` ONLY when `view.requiresMfa && (view.status === 'pending' || view.status === 'awaiting_mfa')`, so every terminal status (including `'locked'`) gets `events: []` — a terminal prompt intentionally requests no further code.
- NO module under `agent/` produces an `action_settled` event: the type is declared in `lib/contracts/agent.ts:99` and its only emitter repo-wide is the browser client (`components/chat/actions.ts:604-611`, for `confirmed` plus `TERMINAL_ACTION_STATUSES`, which includes `locked`).
- Both `liveness.ts` (`withLiveConfirmation`) and `gated-execution.ts` (`executeGatedToolOnce`) refuse `isManualCardCommand` tool names (`manual_add_card` / `manual_delete_card`, `@/lib/contracts/card-management`) with `SECURITY_DENIED` — card creation/deletion must go through the card management page, not the confirmation flow. These are the only card references in this directory; no card-consumption / spend / purchase / pay / debit capability exists here.

## A locked MFA outcome is terminal and carries EMPTY events

When wrong MFA codes trip the session circuit breaker (`security/mfa.ts` `verify` → `security/security-gateway.ts` `authorizeWithMfa`), the gateway returns `status: 'locked'`, `requiresMfa: true`, `tier: 'RED'`, `code: 'CIRCUIT_OPEN'`, `mfaResult: 'failed'` and a lock message, AND durably persists the row via `persistLockedAction` — a race-safe CAS from `['pending', 'awaiting_mfa']` → `'locked'` (from an undecided state ONLY; a concurrent/terminal row is never clobbered and a lost CAS is benign). `blockedOutcome` still emits `events: []` (status `'locked'` is neither `'pending'` nor `'awaiting_mfa'`), i.e. no `mfa_required` and no `action_settled`.
Because the row is now terminal, it is no longer surfaced as a pending decision and `nextPlanDecision`/`withPlanUpdate` do NOT re-emit `mfa_required` for it — the MFA popup does not reappear. A re-attempt on the row returns the SAME idempotent `lockedOutcome` (no new challenge, no consumed attempt, no re-prompt), because `authorizeAction` short-circuits a `'locked'` row before the undecided guard.
No `ToolExecutionResult` is ever built for a lock: `authorizeAndExecute` returns `blockedOutcome` at `../confirmation.ts:37` and SKIPS `executeAuthorizedAction`, so there is no `result`, no `summary`/`error`, and `performAuthorizationResume` is not called. The lock survives only as `status: 'locked'` plus `message` (the gateway's human lock string) and reaches the UI through the HTTP `ActionResponse.message`, which the client stamps onto the MFA card together with the status.

Two distinct lock messages exist in `@/security/security-gateway`: the session-circuit gate (`lockedOutcome`, 「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」) and the attempt-limit branch of `authorizeWithMfa` (「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」). Both reach this facade verbatim as `ConfirmationOutcome.message`.

### What a lock publishes: a message, never a tool event

- No `ToolEventView`, no `tool_end` and no public `summary`/`errorCode` is produced for a lock: `publishAuthorizedToolOutcome` (`agent/turns/buffer.ts:111-134`) is unreachable because no `ToolExecutionResult` exists. The gateway's `CIRCUIT_OPEN` still crosses the boundary as `ConfirmationOutcome.code` plus `failure` (`contracts.ts:22-25`, copied in `outcomes.ts:73-74`), and the lock is also readable from `status: 'locked'`.
- The only agent-emitted public event with `kind: 'locked'` is `agent/turns/events.ts:92-96` `security_event`, reached ONLY from a model-driven `beforeToolCall` deny (`security-gateway.ts:1241-1247` session breaker, `:1272-1279` cancelled plan), never from confirm/verify. `parseBlockReason` (`security-gateway.ts:762-782`) treats `actionId` as OPTIONAL, so the deny payload DOES parse and the event carries typed `code`/`reason` (plus `attemptsLeft`/`maxAttempts`) and no text field; the zero-field branch (`parsed === null` despite a matching prefix) also emits no raw text, and `components/chat/agent-stream-reducer.ts:490-504` renders the event from those typed fields only.
- `gated-execution.ts:64-67` copies `auth.blockReason ?? auth.decision.message` into `GatedToolOutcome.error`, so the raw marker can also travel into a plan node through `plan-continuation.ts:17-19`, which forwards only `{ ok, data, summary, error }` (no `errorCode`) to `resumeTaskForAction`.
- Public copy depends on an EXACT match: `lib/tool-feedback.ts:25` maps only the attempt-limit sentence 「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」 (and `:10` maps the `CIRCUIT_OPEN` code) to `chat.error.securityLocked`. The session-gate sentence 「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」 is in no catalog, and `localizeChatError` (`lib/i18n/display.ts:11-18`) is exact-match only, so it falls through to `chat.error.toolFailed` 「操作未完成。请核对原操作卡片和账户记录。」.
- `components/chat/cards/MfaCard.tsx:65-71` renders the reason line only for `terminal === 'failed'`; a `locked` card shows `cards.terminal.locked` 「已锁定」 and exposes the raw message in developer mode only.

At the HTTP edge (`app/api/actions/[id]/verify/route.ts`) a locked verification reports `status: 'locked'`, `requiresMfa: true` (because `tier === 'RED'`) and `mfaResult: 'failed'` — the ternary maps both `'awaiting_mfa'` and `'locked'` to `'failed'`, so a terminal lock is reported as a failed verification.

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

`ConfirmationOutcome = { ok: boolean; actionId: string; status: PendingActionStatus; tier: RiskLevel; requiresMfa: boolean; message: string; result?: ToolExecutionResult; events: AgentStreamEvent[] }`.

`PendingActionStatus` (`@/lib/contracts/security`) = `'pending' | 'awaiting_mfa' | 'confirmed' | 'executed' | 'failed' | 'cancelled' | 'locked' | 'needs_reconciliation'`.

The gateway's `AuthorizationResult` (`@/security/security-gateway`) additionally carries optional `mfaResult: 'success' | 'failed' | 'not_required'` and `code?: ErrorCode`; those are NOT part of `ConfirmationOutcome`.

## Constraints

- Ownership is fail-closed: `ConfirmationOutcome` is built from persisted state, never from request-supplied text. `verifyAction` can still THROW `AppError('NOT_FOUND' | 'SECURITY_DENIED')` and (via the gateway) `'CONFLICT'`; a `CONFLICT` is converted to `conflictOutcome`.
- `blockedOutcome.events` emits `{ type: 'mfa_required', actionId, action }` ONLY when `view.requiresMfa && (view.status === 'pending' || view.status === 'awaiting_mfa')`. It never emits `action_settled`; terminal prompts intentionally request no further code.
- NO module under `agent/` produces an `action_settled` event at all (the type is declared in `lib/contracts/agent.ts` and only READ here); the browser client synthesizes it after confirm/verify/cancel for `confirmed` plus the terminal statuses (`components/chat/actions.ts` `TERMINAL_ACTION_STATUSES`, which includes `locked`).
- Both `liveness.ts` (`withLiveConfirmation`) and `gated-execution.ts` (`executeGatedToolOnce`) refuse `isManualCardCommand` tool names (`manual_add_card` / `manual_delete_card`, `@/lib/contracts/card-management`) with `SECURITY_DENIED` — card creation/deletion must go through the card management page, not the confirmation flow. These are the only card references in this directory; no card-consumption / spend / purchase / pay / debit capability exists here.

## A locked MFA outcome is terminal and carries EMPTY events

When wrong MFA codes trip the session circuit breaker (`security/mfa.ts` `verify` → `security/security-gateway.ts` `authorizeWithMfa`), the gateway returns `status: 'locked'`, `requiresMfa: true`, `tier: 'RED'`, `code: 'CIRCUIT_OPEN'`, `mfaResult: 'failed'` and a lock message, AND durably persists the row via `persistLockedAction` — a race-safe CAS from `['pending', 'awaiting_mfa']` → `'locked'` (from an undecided state ONLY; a concurrent/terminal row is never clobbered and a lost CAS is benign). `blockedOutcome` still emits `events: []` (status `'locked'` is neither `'pending'` nor `'awaiting_mfa'`), i.e. no `mfa_required` and no `action_settled`.
Because the row is now terminal, it is no longer surfaced as a pending decision and `nextPlanDecision`/`withPlanUpdate` do NOT re-emit `mfa_required` for it — the MFA popup does not reappear. A re-attempt on the row returns the SAME idempotent `lockedOutcome` (no new challenge, no consumed attempt, no re-prompt), because `authorizeAction` short-circuits a `'locked'` row before the undecided guard.
No `ToolExecutionResult` is ever built for a lock: `authorizeAndExecute` returns `blockedOutcome` at `../confirmation.ts:37` and SKIPS `executeAuthorizedAction`, so there is no `result`, no `summary`/`error`/`errorCode`, and `performAuthorizationResume` is not called. `ConfirmationOutcome` (`contracts.ts`) has no `code`/`mfaResult` field either, so the gateway's `code: 'CIRCUIT_OPEN'` is DROPPED; the lock survives only as `status: 'locked'` plus `message` (the gateway's human lock string), and callers infer the lock from `status` alone.

Two distinct lock messages exist in `@/security/security-gateway`: the session-circuit gate (`lockedOutcome`, 「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」) and the attempt-limit branch of `authorizeWithMfa` (「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」). Both reach this facade verbatim as `ConfirmationOutcome.message`.

`action_settled` (`lib/contracts/agent.ts:99`) has NO server-side producer anywhere in the repo — not in this subtree, `agent/`, or `app/api/`. Its only emitter is the client `postAction` (`components/chat/actions.ts:604-611`), which synthesizes `{ type: 'action_settled', actionId, status, message }` for `confirmed` plus `TERMINAL_ACTION_STATUSES` (`executed`/`failed`/`cancelled`/`locked`/`needs_reconciliation`, `actions.ts:74-80`) using the response's `status` and `message`. A locked verification therefore reaches the UI as `status: 'locked'` with the lock message attached by the CLIENT, not by the server events list.

At the HTTP edge (`app/api/actions/[id]/verify/route.ts`) a locked verification reports `status: 'locked'`, `requiresMfa: true` (because `tier === 'RED'`) and `mfaResult: 'failed'` — the ternary maps both `'awaiting_mfa'` and `'locked'` to `'failed'`, so a terminal lock is reported as a failed verification.

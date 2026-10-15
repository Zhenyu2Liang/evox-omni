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

## Gotcha — a locked MFA outcome carries EMPTY events

When wrong MFA codes trip the session circuit breaker (`security/mfa.ts` `verify` → `security/security-gateway.ts` `authorizeWithMfa`), the gateway returns `status: 'locked'`, `requiresMfa: true`, `tier: 'RED'`, `code: 'CIRCUIT_OPEN'`, `mfaResult: 'failed'` and a lock message. `blockedOutcome` then emits `events: []` (status `'locked'` is neither `'pending'` nor `'awaiting_mfa'`), i.e. no `mfa_required` and no `action_settled`.
At the HTTP edge (`app/api/actions/[id]/verify/route.ts`) this becomes a `200` `ActionResponse` with `status: 'locked'`, `requiresMfa: true` (because `tier === 'RED'`) and `mfaResult: 'not_required'` — the ternary only yields `'success'` / `'failed'` (`awaiting_mfa`) / `'not_required'`, so `'locked'` is reported as `'not_required'` even though it is a failed verification.
The persisted `PendingAction` row is NOT moved to `'locked'` — only the `MfaChallenge` row is (`security/mfa.ts`), and the `PendingAction` stays `'awaiting_mfa'` (a live decision in `GET /api/actions`) so it can be retried after the owner unlocks (`renewLockedMfaChallenges`).

# Security Node — code-enforced permission & risk control

## Intent

The heart of the "AI Banking Agent" safety model. It answers ONE question, in TypeScript,
for every tool the model proposes: **is this allowed, and what must a human do first?**

Stated as a hard invariant, everywhere: **the agent may decide WHAT to do next; it may NEVER
decide WHETHER it is allowed.** Permission, confirmation and MFA are derived ONLY from a static
policy table + deterministic dynamic rules — never from model output, never from user text.
This node is the `beforeToolCall` chokepoint and the sole authority on 🟢/🟡/🔴.

## API Surface

Import the facade (`import { security } from '../security'`) or the sub-modules directly.
All public types are local interfaces (NOT in `lib/contracts`) except the frozen cross-module
types it consumes and returns (`SecurityEvaluation`, `SecurityDecision`, `PendingAction`,
`PendingActionSummary`, `PendingActionStatus`, `RiskLevel`, `ToolName`, `SecurityEvent`).

### `permission-engine.ts` — static policy table + evaluator (PURE, no I/O)
```ts
interface ToolPolicy { tier: RiskLevel; static: boolean; description: string }
interface EvaluateToolContext { userId: string; sessionId: string; dailyTransferTotal: number }
interface ToolEvaluation { tier: RiskLevel; requiresConfirmation: boolean; requiresMfa: boolean; reasons: string[] }

const TOOL_POLICY: Record<ToolName, ToolPolicy>            // the frozen GREEN/YELLOW/RED table
function getToolPolicy(toolName: ToolName): ToolPolicy
function evaluateTool(toolName: ToolName, args: Record<string, unknown>, ctx: EvaluateToolContext): ToolEvaluation
```
`evaluateTool` returns the EFFECTIVE tier including dynamic resolution: for `transfer_money` it
delegates to `risk-engine.evaluateTransferRisk({ amount, dailyTransferTotal: ctx.dailyTransferTotal })`.
`getToolPolicy` returns the static policy (`transfer_money` is `static:false`, tier is the YELLOW default).

### `risk-engine.ts` — dynamic risk (deterministic; `now` injectable)
```ts
interface TransferRiskInput { amount: number; dailyTransferTotal: number }
interface TransferRiskResult { tier: RiskLevel; requiresConfirmation: boolean; requiresMfa: boolean;
                               reasons: string[]; amount: number; dailyTotal: number; projectedDailyTotal: number }
function evaluateTransferRisk(input: TransferRiskInput): TransferRiskResult     // RED iff amount>1000 || total+amount>1000 (STRICT `>`; exactly ¥1000 stays YELLOW), else YELLOW; always requiresConfirmation
async function computeDailyTransferTotal(userId: string, now?: number): Promise<number>   // sum OUTGOING TRANSFER debits with occurredAt in [startOfDay(now), now] (INCLUSIVE both ends; future-dated rows excluded)
async function reEvaluateTransferRisk(userId: string, amount: number, now?: number): Promise<TransferRiskResult>   // EXECUTION-TIME re-risk: computeDailyTransferTotal FRESH (injected `now`, default demo clock) then evaluateTransferRisk
```
`reEvaluateTransferRisk` is the mechanism preventing the **stale-parked-transfer bypass**: several
YELLOW pending transfers each validated at PARK time against the same (then-current) day total can
collectively exceed ¥1000 once executed, so execution must re-derive the day total and escalate to
RED/MFA. It reuses `TransferRiskResult` (carries `tier` / `requiresMfa` / `dailyTotal` /
`projectedDailyTotal`) and is auto-exposed via `security.risk.reEvaluateTransferRisk`. The gateway's
`authorizeAction` calls it (only for `transfer_money`) at CONFIRM time, so a parked transfer whose
FRESH day total now crosses the ¥1000 limit is refused the confirmation-only path and requires MFA.

### `circuit-breaker.ts` — session-scoped consecutive-failure breaker (in-memory)
```ts
interface CircuitBreakerState { sessionId: string; failures: number; max: number; locked: boolean; lockedAt?: number }
interface ResetSessionOptions { actor?: string; reason?: string }
function getState(sessionId: string): CircuitBreakerState
function isLocked(sessionId: string): boolean
async function recordFailure(sessionId: string): Promise<CircuitBreakerState>   // trips at MFA_MAX_ATTEMPTS; emits CIRCUIT_BREAKER_TRIPPED exactly once per trip
function recordSuccess(sessionId: string): CircuitBreakerState                  // resets consecutive failures (does NOT unlock a tripped breaker)
function reset(sessionId: string): void                                         // clears all state for a session (sync, no I/O; used by tests)
async function resetSession(sessionId: string, opts?: ResetSessionOptions): Promise<CircuitBreakerState>   // the security-center UNLOCK: reset() + emits SECURITY_RESET (awaited recordSecurityEvent)
```
Event details are COMPLETE audit records:
- `CIRCUIT_BREAKER_TRIPPED` (severity `high`) → `detail: { failures, max, result: 'session_locked' }`; emitted exactly once per trip (a further failure while locked neither recounts nor re-emits).
- `SECURITY_RESET` (severity `medium`) → `detail: { actor, reason, wasLocked, previousFailures, priorLockedAt? }`; `actor` defaults to `'user'`, `reason` to a generic Chinese string; `priorLockedAt` is present only when the prior state had a `lockedAt`.

### `mfa.ts` — mock MFA (code = `MFA_CODE`, NEVER returned)
```ts
interface MfaChallengeView { actionId: string; attempts: number; maxAttempts: number; verified: boolean; createdAt: number; hint: string }
interface MfaVerifyResult { ok: boolean; attemptsLeft: number; locked: boolean }
async function issueChallenge(actionId: string): Promise<MfaChallengeView>
async function verify(actionId: string, code: string): Promise<Result<MfaVerifyResult>>   // correct→success; wrong→increment+emit MFA_FAILURE+feed breaker; a LOCKED session/challenge ALWAYS returns { ok:false, locked:true } regardless of the code (locked checked first)
async function getChallenge(actionId: string): Promise<MfaChallengeView | null>
```

`MFA_FAILURE` (severity `medium`) is a COMPLETE audit record → `detail: { actionId, decision: 'reject_code', result: 'attempt_counted' | 'session_locked', attempts, maxAttempts, attemptsLeft, locked }`; emitted only on a wrong code (a locked session/challenge emits none).

### `injection-guard.ts` — heuristic detection (defense-in-depth only)
```ts
interface InjectionScanResult { suspicious: boolean; matched: string[]; note: string }
const INJECTION_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; label: string }>
function scan(text: string): InjectionScanResult                                   // PURE, no side effects
async function reportInjection(sessionId: string, text: string, result: InjectionScanResult): Promise<void>   // emits INJECTION_ATTEMPT if suspicious
```

### `security-gateway.ts` — the chokepoint
```ts
const BLOCK_REASON_PREFIX = '__SECURITY_BLOCK__'
interface GatewayContext { sessionId: string; userId: string; toolName: ToolName; args: Record<string, unknown>; userRequest: string }
interface AuthorizationResult { ok: boolean; status: PendingActionStatus; actionId: string; tier: RiskLevel;
                                requiresMfa: boolean; mfaResult?: 'success'|'failed'|'not_required'; message: string; action?: PendingAction }
interface ToolCallAuthorization { evaluation: SecurityEvaluation; decision: SecurityDecision; action?: PendingAction; blockReason?: string }
interface SecurityGateway {
  evaluate(ctx): Promise<SecurityEvaluation>
  decide(ev, ctx): SecurityDecision
  createPendingAction(ctx, ev): Promise<PendingAction>
  serializeBlockReason(decision, action): string
  parseBlockReason(reason): { actionId: string; decisionKind: SecurityDecisionKind } | null
  authorizeAction(actionId, opts?: { mfaCode?: string; userId?: string; sessionId?: string }): Promise<AuthorizationResult>
  cancelAction(actionId, opts?: { userId?: string; sessionId?: string }): Promise<PendingAction>
  recordActionResult(actionId, status: 'executed'|'failed'): Promise<void>   // persist the TRUE terminal status AFTER the caller executes
  handleToolCall(ctx): Promise<ToolCallAuthorization>    // beforeToolCall entry: evaluate→decide→(persist+reason when gated)
}
const securityGateway: SecurityGateway
function buildPendingActionSummary(ctx, ev): PendingActionSummary   // pure formatting of Summary fields
const TOOL_INTENT: Record<ToolName, string>                         // code-driven per-tool Chinese intent label (never LLM-derived)
function deriveIntent(toolName: ToolName): string                   // TOOL_INTENT[toolName], else the raw tool name (never empty)
// `createPendingAction` persists ctx.userRequest + deriveIntent(ctx.toolName); `toContractPendingAction` surfaces both on the returned PendingAction.
```
`authorizeAction` gate order (fail-closed): (1) OWNERSHIP — a supplied `opts.userId` / `opts.sessionId`
that does not match the row throws `AppError('SECURITY_DENIED')` (the codebase `ErrorCode` union has no
`FORBIDDEN`); (2) CIRCUIT BREAKER — a locked session returns `{ ok:false, status:'locked' }`; (3) EXECUTION-TIME
RE-RISK for `transfer_money` — a fresh `reEvaluateTransferRisk` that is now RED refuses the confirmation-only
path and requires MFA (the row's `requiresMfa` column stays `false` for an escalated YELLOW transfer, so the
flow is routed on `effectiveRequiresMfa = row.requiresMfa || freshRed`); (4) YELLOW confirm when
`!effectiveRequiresMfa`; (5) RED/escalated verify. Both success paths transition via the atomic, ownership-scoped
`claimPendingAction({ actionId, from:[…], to:'confirmed' })` (from `['pending']` for YELLOW, from
`['awaiting_mfa','pending']` for RED/escalated); a claim transitioning 0 rows throws `AppError('CONFLICT')`, so a
repeat confirm can NOT re-authorize. `cancelAction` claims `['pending','awaiting_mfa'] → 'cancelled'` (same
ownership check) and rejects a settled action with `CONFLICT`. `recordActionResult(id, status)` persists the
terminal `'executed'`/`'failed'` status AFTER the caller has executed the operation.

### `index.ts` — facade
```ts
const security = { gateway, permission, risk, mfa, circuitBreaker, injection }
```

## Flow: evaluate → decide → pendingAction → authorize

```
                 (every model tool call)
   agent.beforeToolCall ──► securityGateway.handleToolCall(ctx)
                                   │
                ┌──────────────────┴───────────────────┐
                ▼                                       │
   1. risk.computeDailyTransferTotal(userId)            │
   2. circuitBreaker.isLocked(sessionId) ?              │  ← locked ⇒ deny (HIGH_RISK_BLOCKED)
   3. permission.evaluateTool(tool, args, ctx)          │
        └─ transfer_money ⇒ risk.evaluateTransferRisk   │
                ▼                                       │
        evaluate(ctx) ──► SecurityEvaluation {tier, requiresConfirmation, requiresMfa, blocked}   (SecurityEvaluation.blocked = tier!==GREEN || locked)
                ▼
        decide(ev, ctx) ──► SecurityDecision {kind: allow | require_confirmation | require_mfa | deny}
                │
      GREEN (allow) ──► no block ──► agent executes tool inline ──► result back to model
                │
      YELLOW/RED (blocked):
                ▼
        createPendingAction(ctx, ev) ──► PendingAction (status: pending | awaiting_mfa; persists userRequest + code-derived intent) + PendingActionSummary
                ▼
        serializeBlockReason(decision, action) ──► '__SECURITY_BLOCK__{...actionId...}'
                ▼
        returned as beforeToolCall block reason ──► model sees "awaiting confirmation/MFA", replies to user

   ── human decision (API route) ────────────────────────────────────────────────
   POST /api/actions/:id/confirm   ──► authorizeAction(id, { userId?, sessionId? })            (ownership → breaker → re-risk → claim ⇒ 'confirmed')
   POST /api/actions/:id/verify    ──► authorizeAction(id, { mfaCode, userId?, sessionId? })   (RED/escalated ⇒ mfa.verify ⇒ claim ⇒ 'confirmed')
   POST /api/actions/:id/cancel    ──► cancelAction(id, { userId?, sessionId? })               (claim ⇒ 'cancelled')
                ▼
        AuthorizationResult.ok ──► agent layer executes ORIGINAL validated args via Banking SDK
                                   (gateway only authorizes; it never executes)
                                   then recordActionResult(id, 'executed'|'failed')
                ▼
        real tool result injected into session ──► agent.continue() narrates the factual outcome
```

## Permission policy table (frozen — the single source of truth)

| Tier | Tools | Behavior |
|---|---|---|
| 🟢 **GREEN** | `get_balance`, `get_transactions`, `search_contact`, `analyze_spending`, `detect_anomaly`, `get_cards`, `list_subscriptions`, `list_investments`, `compare_investments`, `get_investment_holdings`, `get_dashboard_summary`, `list_scheduled_tasks`, `reserve_budget` | auto-execute, no confirmation |
| 🟡 **YELLOW** | `set_card_limit`, `cancel_subscription`, `freeze_card`, `apply_virtual_card`, `set_subscription_reminder`, `create_scheduled_task` | requires user confirmation |
| 🔴 **RED** | `subscribe_investment`, `redeem_investment`, `report_lost_card`, `unfreeze_card`, `change_password` | requires strong verification (MFA) |
| 🔵 **DYNAMIC** | `transfer_money` | RED if `amount > 1000` OR `dailyTransferTotal + amount > 1000` (strict `>`: exactly ¥1000 stays YELLOW), else YELLOW; **always** requires confirmation |
| ⚪ **META** | `submit_plan` | not risk-gated (allow) |

`requiresConfirmation = tier !== 'GREEN'`; `requiresMfa = tier === 'RED'`.
`TOOL_POLICY` and `TOOL_INTENT` are both exhaustive over the full `ToolName` union from
`lib/contracts/tools.ts` (26 members; every member has a `TOOL_POLICY` entry and a `TOOL_INTENT` label).

## Constraints

- **LLM-immutable**: tier / confirmation / MFA are computed only from `TOOL_POLICY`, the validated
  `amount`, and `ctx.dailyTransferTotal`. Model output and user text are NEVER inputs to the decision.
  The persisted `intent` is likewise a pure function of the tool name (`TOOL_INTENT`), never model text.
- **Pure/deterministic where possible**: `permission-engine`, `risk-engine.evaluateTransferRisk`,
  `injection-guard.scan`, `decide`, `serializeBlockReason`, `parseBlockReason`, `buildPendingActionSummary`,
  `deriveIntent` perform NO I/O. Inject `now` (default `demoNow()`, the demo clock) for time-dependent logic so tests are stable.
- **No I/O in the decision; I/O only where required**: DB access is confined to `risk.computeDailyTransferTotal` /
  `risk.reEvaluateTransferRisk` (transaction repo), `mfa` (pendingAction/mfaChallenge repos),
  `circuit-breaker.recordFailure` / `circuit-breaker.resetSession` and `injection.reportInjection` (audit).
  The gateway persists and mutates pending actions via the pendingAction repo (create / get / atomic
  `claimPendingAction` / `setPendingActionStatus`). This node NEVER imports prisma directly.
- **The gateway does NOT execute business operations** — it only authorizes. Execution is the agent layer's job.
- **Exactly-once authorization**: a confirm/cancel transitions the action via `claimPendingAction` (a single
  `updateMany` compare-and-set). Only the call that moves the row from an unsettled status to `confirmed` /
  `cancelled` returns `true`; every other caller gets `false` → `AppError('CONFLICT')`. This is what makes a
  repeat confirm / cancel-after-confirm / confirm-after-cancel fail closed instead of duplicating money movement.
- **Error strategy**: pure helpers throw `AppError` (`lib/errors`); fallible I/O paths return `Result<T>`
  (`mfa.verify`) or throw `AppError` at boundaries. NEVER swallow an error, never fire-and-forget an event write
  (`recordFailure`/`resetSession`/`reportInjection` are awaited). Never leak a raw exception or the MFA code to the model/UI.
  Ownership rejection uses `AppError('SECURITY_DENIED')` — `ErrorCode` has NO `FORBIDDEN`.
- **Circuit breaker is a hard gate the LLM cannot clear**: 3 consecutive MFA failures (`MFA_MAX_ATTEMPTS`)
  trip it for the session and emit `CIRCUIT_BREAKER_TRIPPED`.
- **A tripped breaker denies ALL tiers — including 🟢 GREEN reads** (intended hard gate).
  `gatewayEvaluate` sets `blocked = locked || tier !== 'GREEN'`, so when tripped even a low-risk read
  (e.g. `get_balance`) is denied with decision `deny` / reason `HIGH_RISK_BLOCKED`. This is deliberate:
  a session that just produced three consecutive failed strong-verifications is treated as compromised, so
  it fails closed for EVERY call (it must not even be able to probe balances) until a human deliberately unlocks it.
- **UNLOCK CONDITIONS (explicit)** — a locked session is cleared ONLY by the deliberate, audited security-center
  action `resetSession(sessionId, { actor, reason })`, which records a COMPLETE `SECURITY_RESET` event
  (`actor`, `reason`, `wasLocked`, `previousFailures`, `priorLockedAt?`):
  - the model/LLM can NEVER unlock the breaker (no tool touches the state);
  - `recordSuccess` does NOT unlock a tripped breaker (a correct MFA code on a NON-locked path only resets the counter);
  - a correct MFA code submitted WHILE locked is rejected and does NOT unlock (`mfa.verify` checks the lock first);
  - unlock clears ALL breaker state and restarts the failure counter from 0;
  - unlock does NOT re-authorize a previously blocked action — that `PendingAction` must be re-created (and re-confirmed/re-verified).
- **Injection guard never grants permission** — defense-in-depth only (see its file disclaimer).
- **Files ≲ ~1000 lines**; split by responsibility. No inter-module cycles.

## Known Issues

- **Circuit-breaker unlock is not wired to an app route.**
  `circuit-breaker.resetSession(sessionId, opts?)` exists (audited: clears the lock AND records a
  `SECURITY_RESET` `SecurityEvent`) and is exposed as `security.circuitBreaker.resetSession`, but no app
  route/API caller invokes it yet — the security-center unlock button is still not connected. Until an app
  node wires it, a tripped session stays locked for the process lifetime (`recordSuccess` clears the counter
  but explicitly does NOT unlock).
- **`recordActionResult` / ownership opts are not yet adopted by the agent/app layer.**
  The gateway supports `authorizeAction(id, { userId, sessionId })`, `cancelAction(id, { userId, sessionId })`
  and `recordActionResult(id, 'executed'|'failed')`, but `agent/confirmation.ts` still calls the old signatures
  (no ownership) and never records the true terminal status. Until it calls `recordActionResult` after the SDK
  execution, an executed action stays `confirmed` — protected only by the exactly-once claim (a repeat confirm
  still yields `CONFLICT`), but the persisted status never becomes `executed`/`failed`.
- **Injection guard does NOT add a system reminder to the model context.**
  The only caller (`agent/run-turn.ts` ~L353-357) emits a UI `security_event` (kind `injection`) after `reportInjection`; nothing is appended to the agent's system prompt/messages, despite the `injection-guard.ts` header saying so.
  Detection, the `INJECTION_ATTEMPT` event, and never-grants-permission all hold (defense-in-depth unaffected).
- **The all-tiers (incl. GREEN) block when tripped has no direct unit test.**
  `tests/scenarios/test-10-circuit-breaker.test.ts` only exercises a RED tool, so the GREEN-read denial path is unguarded by tests.
- **"Repeated blocked high-risk attempts" is NOT a breaker trigger.**
  `recordFailure` is called ONLY from `mfa.ts` on a wrong code; no code path counts blocked/denied attempts.
- **Security-event writes are best-effort.**
  `recordSecurityEvent` (sibling `audit/`) logs and swallows persistence failures, so an awaited event write can silently fail; the breaker's in-memory `locked` flag remains authoritative.
- **`HIGH_RISK_BLOCKED` / `LIMIT_EXCEEDED` / `ANOMALY_FLAGGED` event kinds are declared but never written**
  by this node (only `CIRCUIT_BREAKER_TRIPPED`, `MFA_FAILURE`, `INJECTION_ATTEMPT`, `SECURITY_RESET` are emitted).

## Dependencies (contracts this node consumes)

`security` depends on `lib/` and, for SecurityEvent persistence, on the sibling `audit/` node
(audit owns audit/security-event persistence; it depends only on `lib`, so there is no cycle).

Frozen imports (already exist, DO NOT redefine): `lib/contracts/{risk,tools,security,audit}`, `lib/errors`
(`AppError`, `Result`, `ok`, `err`), `lib/constants` (`DAILY_TRANSFER_LIMIT`, `MFA_CODE`, `MFA_MAX_ATTEMPTS`),
`lib/money` (`formatCNY`), `lib/clock` (`demoNow`), `lib/date` (`startOfDay`).

Repository functions this node consumes (confirmed signatures — do NOT fork):
- `../audit` → `recordSecurityEvent(event: SecurityEvent): Promise<void>` (sibling node; implemented, callers `await` it — but its writes are BEST-EFFORT and swallow persistence failures, see Known Issues)
- `lib/db/repositories/pendingAction` → `createPendingAction(input): Promise<PendingAction>` (input also accepts optional `userRequest` / `intent`, written through),
  `getPendingAction(id): Promise<(PendingAction & { mfa: MfaChallenge | null }) | null>`,
  `claimPendingAction({ actionId, from, to, userId?, sessionId? }): Promise<boolean>` (the atomic compare-and-set used by `authorizeAction`/`cancelAction`; `true` iff exactly one row transitioned),
  `setPendingActionStatus(id, status)` (unconditional setter, used by `recordActionResult`; aliased from `updatePendingActionStatus(id, status): Promise<PendingAction>`)
- `lib/db/repositories/pendingAction` (MFA challenge rows live in the SAME module) → `createMfaChallenge({ actionId, code, maxAttempts?, expiresAt? }): Promise<MfaChallenge>`,
  `getMfaChallenge(actionId): Promise<MfaChallenge | null>` (carries `code` — never expose it),
  `incrementMfaAttempts(actionId): Promise<MfaChallenge>`, `updateMfaChallengeStatus(actionId, status): Promise<MfaChallenge>`, `resetMfaAttempts(actionId): Promise<MfaChallenge>`
- `lib/db/repositories/transaction` → `listTransactions(query): Promise<Transaction[]>` (used by `risk.computeDailyTransferTotal` / `risk.reEvaluateTransferRisk`; its range is half-open `[from, to)`, so the inclusive upper bound is passed as `now + 1ms`)

## Test Strategy

Vitest. This node is designed to be unit-testable WITHOUT network or clock:
- Pure units (`permission-engine`, `risk.evaluateTransferRisk`, `injection.scan`, `decide`,
  `serialize`/`parseBlockReason`, `buildPendingActionSummary`, `deriveIntent`) — table-driven, no DB.
- Breaker/MFA/gateway I/O units — run against the test SQLite (`lib/db`) with unique `sessionId`s
  per test to isolate the in-memory breaker; assert `recordFailure` emits `CIRCUIT_BREAKER_TRIPPED`
  and `resetSession` emits `SECURITY_RESET`. The gateway audit-trail specs assert the persisted
  `userRequest` + `intent` round-trip through `createPendingAction`/`handleToolCall`.
- Authorization-hardening units (`security/_tests/authorize-hardening.test.ts` → intended home
  `tests/unit/security/`) prove the exactly-once claim (`repeated confirm ⇒ CONFLICT`, confirm-after-cancel
  and cancel-after-confirm ⇒ `CONFLICT`), the ownership rejection (`SECURITY_DENIED`), the execution-time
  transfer re-risk escalation (parked YELLOW transfer escalates to MFA then still completes with the code),
  `recordActionResult` persistence, and the locked-session refusal.
- End-to-end agent scenarios (Tests 1–12, incl. injection & confirmation) live under `../tests/`.

## Routing Table

This is a **leaf node** — it has no child directories; the modules above are its surface.
- `../tests/` → security/planner/sdk units + faux-LLM scenario integration tests (sibling — read-only, escalate writes to root)

## Notes for Agents

- Every money-moving tool MUST be gated through `securityGateway` — never add a tool that bypasses the policy table.
- When adding a tool, add its entry to `TOOL_POLICY` **and** `TOOL_INTENT` (both typed `Record<ToolName, …>` make a missing key a compile error).
- `PendingAction.args` are the ORIGINAL validated args — `authorizeAction` re-checks the breaker / re-risks a transfer but must not re-trust model text.
- Keep the MFA code inside `mfa.ts`; `MfaChallengeView.hint` and all `message` strings must never contain it (incl. `TRANSFER_ESCALATED_MESSAGE`).
- `authorizeAction`/`cancelAction` transition status ONLY through `claimPendingAction` (atomic compare-and-set) — never a status peek then unconditional write; ownership mismatches use `AppError('SECURITY_DENIED')` (no `FORBIDDEN` code exists).
- After the agent layer executes an authorized action (or it fails), call `securityGateway.recordActionResult(id, 'executed'|'failed')` so the persisted terminal status is truthful and a later confirm/cancel is a `CONFLICT` (see Known Issues — not yet wired).
- **Node-local validation specs (pending relocation to the root-owned `../tests/`)**: `security/_tests/*.test.ts` + `security/_vitest.local.config.ts` are validated unit specs runnable via `npx vitest run --config security/_vitest.local.config.ts` (the root `vitest.config.ts` discovers only `tests/**`). They use portable `@/` imports and cover the circuit-breaker trip/reset audit-event completeness, the locked-session all-tiers (incl. 🟢 GREEN) denial, `reEvaluateTransferRisk` execution-time re-risk, `MFA_FAILURE` detail completeness, and the confirmation-authorization hardening (exactly-once claim / ownership / escalation / `recordActionResult`). Relocate them under `tests/unit/security/` and delete the local config.

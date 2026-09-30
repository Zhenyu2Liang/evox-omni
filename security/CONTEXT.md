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
function evaluateTransferRisk(input: TransferRiskInput): TransferRiskResult     // RED iff amount>1000 || total+amount>1000, else YELLOW; always requiresConfirmation
async function computeDailyTransferTotal(userId: string, now?: number): Promise<number>   // sum OUTGOING TRANSFER debits with occurredAt in [startOfDay(now), now] (INCLUSIVE both ends; future-dated rows excluded)
```

### `circuit-breaker.ts` — session-scoped consecutive-failure breaker (in-memory)
```ts
interface CircuitBreakerState { sessionId: string; failures: number; max: number; locked: boolean; lockedAt?: number }
function getState(sessionId: string): CircuitBreakerState
function isLocked(sessionId: string): boolean
async function recordFailure(sessionId: string): Promise<CircuitBreakerState>   // trips at MFA_MAX_ATTEMPTS; emits CIRCUIT_BREAKER_TRIPPED
function recordSuccess(sessionId: string): CircuitBreakerState                  // resets consecutive failures (does NOT unlock a tripped breaker)
function reset(sessionId: string): void
```

### `mfa.ts` — mock MFA (code = `MFA_CODE`, NEVER returned)
```ts
interface MfaChallengeView { actionId: string; attempts: number; maxAttempts: number; verified: boolean; createdAt: number; hint: string }
interface MfaVerifyResult { ok: boolean; attemptsLeft: number; locked: boolean }
async function issueChallenge(actionId: string): Promise<MfaChallengeView>
async function verify(actionId: string, code: string): Promise<Result<MfaVerifyResult>>   // correct→success; wrong→increment+emit MFA_FAILURE+feed breaker; a LOCKED session/challenge ALWAYS returns { ok:false, locked:true } regardless of the code (locked checked first)
async function getChallenge(actionId: string): Promise<MfaChallengeView | null>
```

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
  parseBlockReason(reason): { actionId: string; decision: SecurityDecisionKind } | null
  authorizeAction(actionId, opts?: { mfaCode?: string }): Promise<AuthorizationResult>
  cancelAction(actionId): Promise<PendingAction>
  handleToolCall(ctx): Promise<ToolCallAuthorization>    // beforeToolCall entry: evaluate→decide→(persist+reason when gated)
}
const securityGateway: SecurityGateway
function buildPendingActionSummary(ctx, ev): PendingActionSummary   // pure formatting of Summary fields
```

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
        createPendingAction(ctx, ev) ──► PendingAction (status: pending | awaiting_mfa) + PendingActionSummary
                ▼
        serializeBlockReason(decision, action) ──► '__SECURITY_BLOCK__{...actionId...}'
                ▼
        returned as beforeToolCall block reason ──► model sees "awaiting confirmation/MFA", replies to user

   ── human decision (API route) ────────────────────────────────────────────────
   POST /api/actions/:id/confirm   ──► authorizeAction(id)                (YELLOW ⇒ status 'confirmed')
   POST /api/actions/:id/verify    ──► authorizeAction(id, { mfaCode })   (RED ⇒ mfa.verify ⇒ 'confirmed')
   POST /api/actions/:id/cancel    ──► cancelAction(id)                   (status 'cancelled')
                ▼
        AuthorizationResult.ok ──► agent layer executes ORIGINAL validated args via Banking SDK
                                   (gateway only authorizes; it never executes)
                ▼
        real tool result injected into session ──► agent.continue() narrates the factual outcome
```

## Permission policy table (frozen — the single source of truth)

| Tier | Tools | Behavior |
|---|---|---|
| 🟢 **GREEN** | `get_balance`, `get_transactions`, `search_contact`, `analyze_spending`, `detect_anomaly`, `get_cards`, `list_subscriptions`, `list_investments`, `compare_investments`, `get_investment_holdings`, `get_dashboard_summary`, `list_scheduled_tasks`, `reserve_budget` | auto-execute, no confirmation |
| 🟡 **YELLOW** | `set_card_limit`, `cancel_subscription`, `freeze_card`, `apply_virtual_card`, `set_subscription_reminder`, `create_scheduled_task` | requires user confirmation |
| 🔴 **RED** | `subscribe_investment`, `redeem_investment`, `report_lost_card`, `unfreeze_card`, `change_password` | requires strong verification (MFA) |
| 🔵 **DYNAMIC** | `transfer_money` | RED if `amount > 1000` OR `dailyTransferTotal + amount > 1000`, else YELLOW; **always** requires confirmation |
| ⚪ **META** | `submit_plan` | not risk-gated (allow) |

`requiresConfirmation = tier !== 'GREEN'`; `requiresMfa = tier === 'RED'`.

## Constraints

- **LLM-immutable**: tier / confirmation / MFA are computed only from `TOOL_POLICY`, the validated
  `amount`, and `ctx.dailyTransferTotal`. Model output and user text are NEVER inputs to the decision.
- **Pure/deterministic where possible**: `permission-engine`, `risk-engine.evaluateTransferRisk`,
  `injection-guard.scan`, `decide`, `serializeBlockReason`, `parseBlockReason`, `buildPendingActionSummary`
  perform NO I/O. Inject `now` (default `Date.now()`) for time-dependent logic so tests are stable.
- **No I/O in the decision; I/O only where required**: DB access is confined to `risk.computeDailyTransferTotal`
  (transaction repo), `mfa` (pendingAction/mfaChallenge repos), `circuit-breaker.recordFailure` and
  `injection.reportInjection` (audit). The gateway persists pending actions via the pendingAction repo.
- **The gateway does NOT execute business operations** — it only authorizes. Execution is the agent layer's job.
- **Error strategy**: pure helpers throw `AppError` (`lib/errors`); fallible I/O paths return `Result<T>`
  (`mfa.verify`) or throw `AppError` at boundaries. NEVER swallow an error, never fire-and-forget an event write
  (`recordFailure`/`reportInjection` are awaited). Never leak a raw exception or the MFA code to the model/UI.
- **Circuit breaker is a hard gate** the LLM cannot clear: 3 consecutive MFA failures (`MFA_MAX_ATTEMPTS`)
  trip it for the session and emit `CIRCUIT_BREAKER_TRIPPED`.
  When tripped it denies EVERY tool call, not only high-risk ones (`gatewayEvaluate`: `blocked = locked || tier !== 'GREEN'`; decision `deny`).
  Unlocking requires `reset(sessionId)`, which NO runtime caller invokes yet (see Known Issues).
- **Injection guard never grants permission** — defense-in-depth only (see its file disclaimer).
- **Files ≲ ~1000 lines**; split by responsibility. No inter-module cycles.

## Dependencies (contracts this node consumes)

`security` depends on `lib/` and, for SecurityEvent persistence, on the sibling `audit/` node
(audit owns audit/security-event persistence; it depends only on `lib`, so there is no cycle).

Frozen imports (already exist, DO NOT redefine): `lib/contracts/{risk,tools,security,audit}`, `lib/errors`
(`AppError`, `Result`, `ok`, `err`), `lib/constants` (`DAILY_TRANSFER_LIMIT`, `MFA_CODE`, `MFA_MAX_ATTEMPTS`),
`lib/money` (`formatCNY`).

Repository functions this node consumes (confirmed signatures — do NOT fork):
- `../audit` → `recordSecurityEvent(event: SecurityEvent): Promise<void>` (sibling node; the stub throws `'not implemented'` on CALL — callers `await` it, never fire-and-forget)
- `lib/db/repositories/pendingAction` → `createPendingAction(input): Promise<PendingAction>`,
  `getPendingAction(id): Promise<(PendingAction & { mfa: MfaChallenge | null }) | null>`, `updatePendingActionStatus(id, status): Promise<PendingAction>`
- `lib/db/repositories/pendingAction` (MFA challenge rows live in the SAME module) → `createMfaChallenge({ actionId, code, maxAttempts?, expiresAt? }): Promise<MfaChallenge>`,
  `getMfaChallenge(actionId): Promise<MfaChallenge | null>` (carries `code` — never expose it),
  `incrementMfaAttempts(actionId): Promise<MfaChallenge>`, `updateMfaChallengeStatus(actionId, status): Promise<MfaChallenge>`, `resetMfaAttempts(actionId): Promise<MfaChallenge>`
- `lib/db/repositories/transaction` → `listTransactions(query): Promise<Transaction[]>` (used by `risk.computeDailyTransferTotal`; its range is half-open `[from, to)`, so the inclusive upper bound is passed as `now + 1ms`)

## Test Strategy

Vitest. This node is designed to be unit-testable WITHOUT network or clock:
- Pure units (`permission-engine`, `risk.evaluateTransferRisk`, `injection.scan`, `decide`,
  `serialize`/`parseBlockReason`, `buildPendingActionSummary`) — table-driven, no DB.
- Breaker/MFA/gateway I/O units — run against the test SQLite (`lib/db`) with unique `sessionId`s
  per test to isolate the in-memory breaker; assert `recordFailure` emits `CIRCUIT_BREAKER_TRIPPED`.
- End-to-end agent scenarios (Tests 1–12, incl. injection & confirmation) live under `../tests/`.

## Routing Table

This is a **leaf node** — it has no child directories; the modules above are its surface.
- `../tests/` → security/planner/sdk units + faux-LLM scenario integration tests (sibling — read-only, escalate writes to root)

## Notes for Agents

- Every money-moving tool MUST be gated through `securityGateway` — never add a tool that bypasses the policy table.
- When adding a tool, add its entry to `TOOL_POLICY` (typed `Record<ToolName, ToolPolicy>` makes a missing key a compile error).
- `PendingAction.args` are the ORIGINAL validated args — `authorizeAction` re-checks the breaker but must not re-trust model text.
- Keep the MFA code inside `mfa.ts`; `MfaChallengeView.hint` and all `message` strings must never contain it.

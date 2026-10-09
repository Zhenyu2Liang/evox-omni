# Security Node — code-enforced permission & risk control

## Intent

The heart of the "AI Banking Agent" safety model. It answers ONE question, in TypeScript,
for every tool the model proposes: **is this allowed, and what must a human do first?**

Stated as a hard invariant, everywhere: **the agent may decide WHAT to do next; it may NEVER
decide WHETHER it is allowed.** Permission, confirmation and MFA are derived ONLY from a static
policy table + deterministic dynamic rules — never from model output, never from user text.
This node is the `beforeToolCall` chokepoint and the sole authority on 🟢/🟡/🔴.

## API Surface

- `execution-policy.ts` exports `assertSessionMayWrite(sessionId, client?)` through `security.writePolicy`.
  Ordinary confirm, MFA verify and replay recovery share this breaker check inside the SDK write
  transaction, after the action/plan conditional writes. Policy denial propagates as CIRCUIT_OPEN;
  committed receipt-only reconstruction remains available while locked.
- Authorization rejects confirmed/terminal actions before requesting or verifying MFA. Recovery
  re-reads the persisted risk decision after its transaction's writer claim; a stale ownership
  snapshot cannot downgrade a concurrent RED upgrade to YELLOW.

- `recovery-authorization.ts` exports `authorizeRecoveryAction(actionId, actor)` and
  `assertRecoverySessionUnlocked(sessionId)` through `security.recovery`. Only recovery that may
  create a NEW transfer debit re-enters this policy: trusted owner/session, confirmed CAS, plan
  cancellation, current effective daily total and verified MFA. A raced committed ledger is not
  counted twice. The agent also invokes the breaker check inside the SDK write fence. Receipt-only
  reconstruction does not authorize a new write and can proceed while locked.
- `recipient-resolution.ts` (a cohesive, DB-backed module imported AND re-exported by
  `security-gateway.ts`, so the `@/security/security-gateway` import surface — incl. `maskPhone` and
  `RecipientResolution` — is preserved) owns PARK-time `transfer_money` recipient resolution; see the
  "Park-time transfer-recipient resolution" section below.

Import the facade (`import { security } from '../security'`) or the sub-modules directly.
All public types are local interfaces (NOT in `lib/contracts`) except the frozen cross-module
types it consumes and returns (`SecurityEvaluation`, `SecurityDecision`, `PendingAction`,
`PendingActionSummary`, `PendingActionStatus`, `RiskLevel`, `ToolName`, `SecurityEvent`).

### `permission-engine.ts` — static policy table + evaluator (PURE, no I/O)
```ts
interface ToolPolicy { tier: RiskLevel; static: boolean; write: boolean; description: string }   // `write` = persists a side effect ⇒ AUDITED regardless of colour
interface EvaluateToolContext { userId: string; sessionId: string; dailyTransferTotal: number }
interface ToolEvaluation { tier: RiskLevel; requiresConfirmation: boolean; requiresMfa: boolean; reasons: string[] }

const TOOL_POLICY: Record<ToolName, ToolPolicy>            // the frozen GREEN/YELLOW/RED table
function getToolPolicy(toolName: ToolName): ToolPolicy
function isWriteTool(toolName: ToolName): boolean          // `TOOL_POLICY[tool].write`; audit-by-side-effect, grants nothing
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
type PrismaLike = Prisma.TransactionClient | typeof prisma   // the shared client OR a `$transaction` client
const IN_FLIGHT_TRANSFER_STATUSES = ['confirmed', 'executing'] as const
function evaluateTransferRisk(input: TransferRiskInput): TransferRiskResult     // RED iff amount>1000 || total+amount>1000 (STRICT `>`; exactly ¥1000 stays YELLOW), else YELLOW; always requiresConfirmation
async function computeDailyTransferTotal(userId: string, now?: number): Promise<number>   // EXECUTED only: sum OUTGOING TRANSFER debits with occurredAt in [startOfDay(now), now] (INCLUSIVE both ends; future-dated rows excluded)
async function computeInFlightTransferTotal(client: PrismaLike, userId: string, excludeActionId?: string): Promise<number>
// Sums integer cents of confirmed|executing transfers; invalid amounts fail closed. Excludes the
// current action and actions whose ledgerTxIdForAction already exists (counted by the executed half).
async function computeEffectiveTransferTotalWith(client: PrismaLike, userId: string, now?: number, excludeActionId?: string): Promise<number>   // EXECUTED-today transfer debits + in-flight PendingActions, through `client` (so it runs INSIDE a `$transaction`)
async function reEvaluateTransferRisk(userId: string, amount: number, now?: number): Promise<TransferRiskResult>   // EXECUTED-only re-risk: computeDailyTransferTotal FRESH then evaluateTransferRisk
```
`computeDailyTransferTotal` / `reEvaluateTransferRisk` remain the EXECUTED-only public API (and are
auto-exposed via `security.risk`). The gateway does NOT use them for the transfer confirm path: it calls
`computeEffectiveTransferTotalWith(tx, …)` INSIDE the atomic claim transaction so in-flight
(authorized-not-yet-ledgered) transfers also count. That aggregate is the mechanism that closes the
**stale-parked-transfer bypass**: several YELLOW transfers each validated at PARK time against the same
then-current day total can collectively exceed ¥1000 once executed, so execution must re-derive the
EFFECTIVE total (executed + in-flight) and escalate to RED/MFA. `risk-engine` imports the shared
`prisma` client (`lib/db/client`) and the `Prisma` type for its `PrismaLike` parameter — this is the
sanctioned direct-DB dependency of this node (the aggregate queries must run inside the caller's tx).

**Ledger dedup (counted exactly once)**: the effective total is `executed + in-flight`, but an action
can be `confirmed` (in-flight) while its ledger `Transaction` row ALREADY exists — the SDK writes that
row deterministically keyed by `ledgerTxIdForAction(userId, action)` (`lib/ledger`: the plan-node key `nodeExecutionKey(taskId, nodeId)` for a plan-linked action, else the action `id`) and
`recordActionResult` (the flip to a terminal status) has not run yet. Such an action is ALREADY counted
by the executed half, so `computeInFlightTransferTotal` EXCLUDES every in-flight action whose
deterministic ledger row exists (one `client.transaction.findMany({ where:{ id:{ in:[…] } }, select:{ id:true } })`
after the pendingAction fetch; an empty pending set short-circuits to `0` without querying the ledger).
Without it a ledgered-but-not-yet-terminal action would be counted TWICE and spuriously escalate a
legitimately-YELLOW transfer to RED/MFA (repo acceptance case 7). The **concurrency defence is
untouched**: parked actions with NO ledger row yet still sum, so two ¥600 actions both still `confirmed`
with no ledger row compute `600 + 600 = 1200 > 1000` → RED/MFA.

### `circuit-breaker.ts` — OWNER-scoped consecutive-failure breaker (DB-backed, durable)
```ts
interface CircuitBreakerState { sessionId: string; failures: number; max: number; locked: boolean; lockedAt?: number }   // `sessionId` is the caller-supplied actor, NOT the internal owner key
interface BreakerOwner { key: string; userId?: string }   // `key` = `user:<userId>` | `session:<actor>`
interface ResetSessionOptions { actor?: string; reason?: string; verificationCode?: string; now?: number | Date }
async function resolveBreakerOwner(actor: string, client?: DbClient): Promise<BreakerOwner>   // session.userId → `user:<userId>`; else user id → `user:<id>`; else `session:<actor>`
async function getState(actor: string, client?: DbClient): Promise<CircuitBreakerState>
async function isLocked(actor: string, client?: DbClient): Promise<boolean>
async function recordFailure(actor: string): Promise<CircuitBreakerState>   // trips at MFA_MAX_ATTEMPTS; emits CIRCUIT_BREAKER_TRIPPED exactly once per trip
async function recordSuccess(actor: string): Promise<CircuitBreakerState>                  // resets consecutive failures (does NOT unlock a tripped breaker)
async function reset(actor: string): Promise<void>                                         // ungated, unaudited, route-less test-only clear
async function resetSession(actor: string, opts?: ResetSessionOptions): Promise<CircuitBreakerState>   // GATED, audited security-center UNLOCK: clears state + emits SECURITY_RESET
```
State is DURABLE: it lives in the DB (Prisma model `CircuitBreakerState`, via `lib/db/repositories/circuitBreaker.ts`) keyed by the OWNER, not by the raw session id and not in process memory.
The owner key is derived by `resolveBreakerOwner(actor)`: the persisted session's `userId` (`user:<userId>`), else the user actor (`user:<id>`), else a synthesized `session:<actor>` for unpersisted actors.
Because a real user's key is shared by ALL of that user's sessions, a lock survives a NEW SESSION and a PROCESS RESTART — rotating the session id cannot bypass it.
Every mutation is async and accepts an optional `client?: DbClient` to bind its reads/writes to an OPEN interactive transaction (the SDK write-boundary recheck passes the transaction client to avoid deadlocking on a single-connection DB).
Event details are COMPLETE audit records:
- `CIRCUIT_BREAKER_TRIPPED` (severity `high`, top-level `userId` when resolved) → `detail: { failures, max, result: 'session_locked' }`; emitted exactly once per trip (a further failure while locked neither recounts nor re-emits).
- `SECURITY_RESET` (severity `medium`, top-level `userId` when resolved) → `detail: { actor, reason, wasLocked, previousFailures, priorLockedAt? }`; `actor` defaults to `'user'`, `reason` to a generic Chinese string; `priorLockedAt` is present only when the prior state had a `lockedAt`.

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
interface GatewayContext { sessionId: string; userId: string; toolName: ToolName; args: Record<string, unknown>; userRequest: string;
                           taskId?: string; nodeId?: string }   // owning DAG plan node (AgentTask.id / AgentTaskNode.nodeId); absent for a top-level call
interface ActionOwnership { userId: string; sessionId: string }      // REQUIRED caller identity
type AuthorizeOptions = ActionOwnership & { mfaCode?: string; confirmed?: boolean }   // `confirmed` is an accepted-but-ignored caller HINT threaded from the caller; it never changes a permission outcome (a YELLOW action is authorized by the atomic `pending → confirmed` CAS claim, a RED action by `mfaCode`)
type CancelOptions = ActionOwnership
interface AuthorizationResult { ok: boolean; status: PendingActionStatus; actionId: string;
                                tier: RiskLevel;              // ALWAYS the EFFECTIVE tier (an escalated transfer ⇒ 'RED')
                                requiresMfa: boolean;         // ALWAYS the EFFECTIVE requirement
                                mfaResult?: 'success'|'failed'|'not_required';
                                code?: ErrorCode;             // typed failure code (present iff ok===false for a domain refusal)
                                message: string; action?: PendingAction }
interface ToolCallAuthorization { evaluation: SecurityEvaluation; decision: SecurityDecision; action?: PendingAction; blockReason?: string }
interface SecurityGateway {
  evaluate(ctx): Promise<SecurityEvaluation>
  decide(ev, ctx): SecurityDecision
  createPendingAction(ctx, ev): Promise<PendingAction>
  serializeBlockReason(decision, action): string
  parseBlockReason(reason): { actionId: string; decisionKind: SecurityDecisionKind } | null
  authorizeAction(actionId: string, opts: AuthorizeOptions): Promise<AuthorizationResult>   // opts REQUIRED (ownership enforced)
  cancelAction(actionId: string, opts: CancelOptions): Promise<PendingAction>               // opts REQUIRED (ownership enforced)
  recordActionResult(actionId, status: 'executed'|'failed'): Promise<void>   // persist the TRUE terminal status AFTER the caller executes
  handleToolCall(ctx): Promise<ToolCallAuthorization>    // beforeToolCall entry: assertCallerIdentity→evaluate→decide→(persist+reason when gated)
}
const securityGateway: SecurityGateway
function buildPendingActionSummary(ctx, ev): PendingActionSummary   // pure formatting of Summary fields
const TOOL_INTENT: Record<ToolName, string>                         // code-driven per-tool Chinese intent label (never LLM-derived)
function deriveIntent(toolName: ToolName): string                   // TOOL_INTENT[toolName], else the raw tool name (never empty)
// `createPendingAction` persists ctx.userRequest + deriveIntent(ctx.toolName) + the plan link
// (ctx.taskId / ctx.nodeId, `null` when absent); `toContractPendingAction` surfaces userRequest and
// intent on the returned PendingAction (the plan link is read back via `getPendingActionPlanLink`).
// A plan-scoped call (`ctx.taskId`) whose owning `AgentTask` is already `'cancelled'` is REFUSED: the
// internal path returns `{ kind: 'plan_cancelled' }` (⇒ `handleToolCall` yields a clean `deny`) or
// `{ kind: 'clarify' }` for an unresolvable/ambiguous transfer recipient (⇒ a PLAIN deny block reason,
// nothing persisted); the exported
// `createPendingAction` maps that to a thrown `CONFLICT` so its public return type stays non-null.
function sameArgs(a: unknown, b: unknown): boolean   // PURE, key-order-insensitive deep equality of tool args
```
`createPendingAction` first runs a **plan-node dedupe** (defense-in-depth — a cheap second layer): when BOTH
`ctx.taskId` and `ctx.nodeId` are non-empty it lists the plan's non-settled actions
(`listPendingActionsByTask(taskId, { statuses: ['pending','awaiting_mfa'] })`) and REUSES an existing one iff
it is the same operation — same `nodeId`, same `toolName`, deep-equal args (`sameArgs` over
`safeParse(row.argsJson, {})`), and the same effective tier / `requiresMfa` as the fresh evaluation
(`row.riskLevel === ev.tier && row.requiresMfa === ev.requiresMfa`, so a drifted day total that now needs MFA
cannot be under-gated away). Reuse returns the existing contract action WITHOUT minting a second row and
WITHOUT re-issuing an MFA challenge (the existing action already has one). No match — or a `(taskId,nodeId)`
row whose operation differs — falls through and creates a new action as usual. A node-execution claim
elsewhere remains the PRIMARY guard.

Persisting `taskId`/`nodeId` AT CREATION is what lets a plan-level cancel revoke the operation later: the plan
link lives on the `PendingAction` row, so it survives even when the node output JSON was never written.

`authorizeAction` gate order (fail-closed): (1) OWNERSHIP — `opts` is REQUIRED; `assertOwnership(row, opts)`
throws `AppError('SECURITY_DENIED')` when the caller `userId`/`sessionId` is missing/empty, does not match
the row, or (when the owning session row exists) disagrees with `getSession(row.sessionId).userId`
(the codebase `ErrorCode` union has no `FORBIDDEN`); (2) CIRCUIT BREAKER — a locked session returns
`{ ok:false, status:'locked', code:'CIRCUIT_OPEN' }`; (3) `transfer_money` (DYNAMIC) → `authorizeTransfer`;
(4) static RED (or `row.requiresMfa`) → the shared strong-verification path; (5) static YELLOW → an atomic
exactly-once `claimPendingAction(['pending'] → 'confirmed')`.

`authorizeTransfer` (a YELLOW/confirmation-only `transfer_money`) runs ONE `prisma.$transaction` whose
FIRST statement is the CAS claim `tx.pendingAction.updateMany({ where:{ id, status:{ in:['pending'] }, userId,
sessionId }, data:{ status:'confirmed' } })`. That WRITE acquires SQLite's write lock, so concurrent confirms
of DIFFERENT action ids SERIALIZE (cross-session, cross-process) instead of each reading the same
pre-transfer day total. AFTER the claim it reads the EFFECTIVE day total via
`risk.computeEffectiveTransferTotalWith(tx, userId, undefined, actionId)` — today's EXECUTED transfer debits
PLUS every in-flight (`confirmed`/`executing`) parked `transfer_money` action except this one — and re-runs
`evaluateTransferRisk`. If the fresh risk is now RED the claim is reverted INSIDE the tx to
`{ status:'awaiting_mfa', riskLevel:'RED', requiresMfa:true }` (the transfer is NOT authorized for execution),
the MFA challenge is issued AFTER the commit, a `LIMIT_EXCEEDED` `SecurityEvent` is recorded (there is no
`mfa_required` kind — see Known Issues), and it is refused the confirmation-only path with
`{ ok:false, status:'awaiting_mfa', tier:'RED', requiresMfa:true, code:'LIMIT_EXCEEDED' }`. Otherwise
`{ ok:true, status:'confirmed', tier:'YELLOW', requiresMfa:false }`. A claim that transitions 0 rows ⇒
`AppError('CONFLICT')`.

The strong-verification path (`authorizeWithMfa`, used by static RED and an already-RED/escalated transfer)
ensures the challenge exists, prompts (`MFA_CODE_PROMPT`, code-free) when no `mfaCode` was supplied, runs
`mfa.verify`, and on success claims `['awaiting_mfa','pending'] → 'confirmed'` (0 rows ⇒ `AppError('CONFLICT')`).
A wrong code returns `code:'MFA_FAILED'`; a locked session/challenge returns `code:'CIRCUIT_OPEN'`.
`tier`/`requiresMfa` are ALWAYS the EFFECTIVE values on EVERY branch (success and failure). `cancelAction`
REQUIRES ownership too and claims `['pending','awaiting_mfa'] → 'cancelled'` (a settled action ⇒ `CONFLICT`).
`handleToolCall` first calls `assertCallerIdentity(ctx)` (presence/non-emptiness only — there is no persisted
action yet). There is NO demo-user fallback anywhere: an `actionId` alone is no longer a capability.

**Plan-cancel guards (fail-closed; the gateway READS the owning plan's status).** To close the
plan-cancel → authorize race even when the plan's bulk revoke is lost or neutralized, the gateway
reads `AgentTask.status` at two points: (1) CREATE/PARK — `gatewayCreatePendingAction` reads the
owning `AgentTask` INSIDE the SAME `$transaction` that inserts the row and returns `{ kind:'plan_cancelled' }` when the
plan is `'cancelled'` (⇒ `handleToolCall` returns a clean `deny` with a `blockReason` and NO live
`action`); (2) AUTHORIZE — BOTH `authorizeTransfer` (YELLOW CAS tx) and `authorizeWithMfa`
(strong-verification claim tx) re-read the plan via the action's persisted `row.taskId` INSIDE the
same `$transaction` that claims the action and, on `'cancelled'`, REVERSE the claim to `'cancelled'`,
return a distinct `{kind:'plan_cancelled'}` from the tx and translate it AFTER the commit into a
RETURNED (never thrown) `{ok:false, status:'cancelled', code:'SECURITY_DENIED'}` — the side effect
MUST NOT run and NO ledger row is written. An action with NO plan link (`row.taskId` null/empty) is
COMPLETELY unaffected by both guards, and a committed ledger debit is NEVER rolled back.

### `index.ts` — facade
```ts
const security = { gateway, permission, risk, mfa, circuitBreaker, injection, recovery, writePolicy }
```

### `recipient-resolution.ts` — Park-time transfer-recipient resolution (confirmation card ⇄ execution agreement)

`transfer_money` is resolved SERVER-SIDE at PARK time (after the amount normalization, BEFORE the dedupe
and the insert) by the cohesive `./recipient-resolution.ts` module (imported AND re-exported by
`security-gateway.ts`, so the established `@/security/security-gateway` import surface — incl. `maskPhone`
and `RecipientResolution` — is preserved). Its helpers mirror `banking-sdk/transfer.ts#resolveRecipient`
(the same contact data), so the confirmation card names the SAME contact the SDK resolves at execution.

```ts
type RecipientResolution =
  | { status:'resolved'; contact:{ id:string; name:string; phone:string } }
  | { status:'not_found'; kind:'contactId'|'phone'|'name'; supplied:string }
  | { status:'ambiguous'; kind:'contactId'|'phone'|'name'; supplied:string; candidates:Array<{name:string;phone:string}> }
  | { status:'invalid'; detail:string }
async function resolveTransferRecipient(userId: string, args: Record<string,unknown>): Promise<RecipientResolution>   // NEVER throws; tolerant of the value/slot the model supplies
// `maskAwarePhoneMatch` / `maskPhone` are NOT defined here — the single implementation lives in the shared
// `lib/phone` module and is RE-EXPORTED by this module, so this module's import surface is unchanged:
function maskAwarePhoneMatch(value: string, stored: string): boolean   // RE-EXPORTED from `../lib/phone`; PURE mask-aware phone match (rules below)
function maskPhone(phone: string): string                     // RE-EXPORTED from `../lib/phone`; PURE 脱敏: first 3 + '****' + last 4; short input safe ('139'→'****', '1391234'→'139****'); never a raw phone
function canonicalizeTransferArgs(args, contactId: string): Record<string,unknown>   // PURE: sets contactId and DELETES phone/name (the SDK requires EXACTLY ONE recipient field); amount/remark/sourceAccountId preserved
async function resolveAccountLabel(userId: string, sourceAccountId: string|undefined): Promise<string|undefined>  // the caller's OWN account name, else undefined
function buildRecipientClarifyMessage(res: Exclude<RecipientResolution,{status:'resolved'}>): string   // PURE, Chinese, phone-masked, code-free
type CreatePendingActionResult = { kind:'created'; action: PendingAction } | { kind:'plan_cancelled' } | { kind:'clarify'; message:string }   // gatewayCreatePendingAction's return type
```

Resolution is **TOLERANT of the value/slot the model supplies** — a live model echoing whatever
`search_contact` returned may put a NAME into `contactId`, a MASKED phone into `contactId` (e.g.
`139****0002`), or a DE-MASKED phone into `phone`; all of those still resolve. The rules, in order:

- **Selectors (one or more)**: every PRESENT selector value across `contactId` | `phone` | `name` is considered
  (`isPresent` = `typeof === 'string' && !== ''`); ONE OR MORE are accepted — EXACTLY ONE is NOT required. ZERO
  present selectors → `{ status:'invalid', detail }` (which `buildRecipientClarifyMessage` renders as the
  `请提供且仅提供一个收款人标识…` message). `kind`/`supplied` on `not_found`/`ambiguous` describe the FIRST
  supplied selector, so the existing clarify messages stay stable.
- **Owner isolation (free)**: the caller's contacts are loaded ONCE via `listContacts(userId)` and matched IN
  MEMORY, so only the caller's OWN contacts are ever considered — a foreign/unknown id can never resolve or leak.
- **Per-value match**: a supplied VALUE matches a contact iff ANY identity facet matches — exact `contact.id`,
  exact `contact.name`, OR `maskAwarePhoneMatch(value, contact.phone)`.
- **Mask-aware phone match** `maskAwarePhoneMatch(value, stored)` is TRUE iff ANY of:
  `value === stored` (covers `contactId:"139****0002"` vs stored `139****0002`);
  `storedDigits.includes(valueDigits)` (the existing partial behaviour, e.g. `phone:"0002"` vs `139****0002` →
  `1390002` contains `0002`); `valueDigits.includes(storedDigits)` (reverse partial, defensive) — both with
  every `*` stripped and guarded against empty digits; OR a WILDCARD RegExp built from `stored.split('*')`'s
  non-empty (RegExp-escaped) fragments joined by `\d*` and anchored `^…$`, tested against the value with its
  `*` stripped (so `phone:"13900000002"` matches `139****0002` via `^139\d*0002$`). No non-empty fragment →
  `false`; built only from escaped literals, so it never throws.
- **Union → outcome**: the candidates gathered from EVERY supplied value are UNIQUED by contact id. EXACTLY ONE
  distinct → `{ status:'resolved', contact }`; ZERO → `not_found`; MORE THAN ONE → `ambiguous` (carrying the
  `candidates` array of `{name, phone}`). This makes a 重名 AND a set of CONTRADICTORY selectors (e.g. `contactId`
  resolves 张伟 while `name` says 王芳) both `ambiguous`.
- A non-`resolved` recipient makes `gatewayCreatePendingAction` return `{ kind:'clarify' }`: **NOTHING is
  persisted** (no `PendingAction`, no MFA challenge) and nothing can execute. `handleToolCall` turns it into a
  BLOCK (`evaluation.blocked` stays true, `decision.kind='deny'`, NO `action`) whose `blockReason` is the PLAIN
  model-readable `buildRecipientClarifyMessage(res)` — deliberately NOT a `BLOCK_REASON_PREFIX` JSON payload
  (the model must read it and ask the user to clarify). `SecurityGateway.createPendingAction` maps it to
  `AppError('VALIDATION', message)`, and `{ kind:'plan_cancelled' }` to `AppError('CONFLICT', …)`.
- A `resolved` recipient canonicalizes `ctx.args` to the resolved `contactId` BEFORE `findReusableAction`, so a
  re-park compares canonical args and the args persisted on the action are exactly the ones the SDK executes.
- `buildPendingActionSummary(ctx, ev, recipient?, accountLabel?)` stays SYNC/exported/PURE. For `transfer_money`
  the 收款人 field is `recipient.name` (fallback: the `toName`/`name`/… pickString heuristic,
  `'（未指定）'`), a `recipient` present ADDITIONALLY pushes `收款手机号 = maskPhone(recipient.phone)` (masked,
  never raw), and 账户 is `accountLabel` (from `resolveAccountLabel(userId, sourceAccountId)`) else the
  pickString heuristic (`sourceAccountId`/`fromAccount`/…) else `'默认活期账户'`. Field order:
  收款人 → [收款手机号] → 金额 → 账户 → 风险等级.

## Flow: evaluate → decide → pendingAction → authorize

```
                 (every model tool call)
   agent.beforeToolCall ──► securityGateway.handleToolCall(ctx)      [assertCallerIdentity(ctx) first]
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
        createPendingAction(ctx, ev) ──► (transfer_money: the recipient is resolved SERVER-SIDE; a non-`resolved` recipient returns 'clarify' and NOTHING is persisted) ELSE an existing action for the same (taskId,nodeId) + tool + canonical args + tier/requiresMfa, ELSE a new PendingAction (status: pending | awaiting_mfa; persists userRequest + code-derived intent + the taskId/nodeId plan link) + PendingActionSummary
                ▼
        serializeBlockReason(decision, action) ──► '__SECURITY_BLOCK__{...actionId...}'
                ▼
        returned as beforeToolCall block reason ──► model sees "awaiting confirmation/MFA", replies to user

   ── human decision (API route) ────────────────────────────────────────────────
   POST /api/actions/:id/confirm   ──► authorizeAction(id, { userId, sessionId })            (ownership → breaker → transfer_money: ONE tx { CAS claim ⇒ effective-total(+in-flight) read ⇒ re-risk; now-RED ⇒ revert to awaiting_mfa/RED } | static YELLOW: claim ⇒ 'confirmed')
   POST /api/actions/:id/verify    ──► authorizeAction(id, { mfaCode, userId, sessionId })   (RED/escalated ⇒ mfa.verify ⇒ claim ⇒ 'confirmed')
   POST /api/actions/:id/cancel    ──► cancelAction(id, { userId, sessionId })               (claim ⇒ 'cancelled')
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

- Transfer authorization rejects fractional cents and invalid amounts before creating a pending action;
  all day/in-flight totals and threshold comparisons sum canonical integer cents. Invalid persisted
  in-flight amounts fail closed instead of being omitted. New-debit recovery uses the same validator.

- **LLM-immutable**: tier / confirmation / MFA are computed only from `TOOL_POLICY`, the validated
  `amount`, and `ctx.dailyTransferTotal`. Model output and user text are NEVER inputs to the decision.
  The persisted `intent` is likewise a pure function of the tool name (`TOOL_INTENT`), never model text.
- **Pure/deterministic where possible**: `permission-engine`, `risk-engine.evaluateTransferRisk`,
  `injection-guard.scan`, `decide`, `serializeBlockReason`, `parseBlockReason`, `buildPendingActionSummary`,
  `deriveIntent` perform NO I/O. Inject `now` (default `demoNow()`, the demo clock) for time-dependent logic so tests are stable.
- **No I/O in the decision; I/O only where required**: DB access is confined to
  `risk.computeDailyTransferTotal` / `risk.reEvaluateTransferRisk` / `risk.computeInFlightTransferTotal` /
  `risk.computeEffectiveTransferTotalWith` (transaction + pendingAction tables, via the shared `prisma`
  client OR an injected `$transaction` client), `mfa` (pendingAction/mfaChallenge repos),
  `circuit-breaker.recordFailure` / `circuit-breaker.resetSession` and `injection.reportInjection` (audit).
  The gateway persists/mutates pending actions via the pendingAction repo (create / get / atomic
  `claimPendingAction` / `setPendingActionStatus`) and runs the transfer confirm path's atomic claim +
  effective-total read in ONE direct `prisma.$transaction`; it reads `session.getSession` for the ownership
  cross-check. Direct `prisma` use is limited to those sanctioned call sites.
- **Required ownership (fail-closed)**: `authorizeAction`/`cancelAction` require `{ userId, sessionId }`
  and `handleToolCall` requires a non-empty caller identity; a missing/mismatching identity (or a
  session-row/user mismatch) throws `AppError('SECURITY_DENIED')`. There is NO demo-user fallback — an
  `actionId` alone does not authorize.
- **Atomic claim-first transfer re-risk**: a YELLOW `transfer_money` confirm performs the exactly-once
  CAS claim and the effective-total read in ONE `$transaction` (the write-first claim serializes concurrent
  confirms), and the effective total includes in-flight parked transfers, so neither the concurrent-confirm
  race nor the stale-parked-transfer bypass can push the aggregate ¥1000 day limit past the confirmation-only path.
- **The gateway does NOT execute business operations** — it only authorizes. Execution is the agent layer's job.
- **Exactly-once authorization**: a confirm/cancel transitions the action via `claimPendingAction` (a single
  `updateMany` compare-and-set; the transfer path uses the same CAS inline in its `$transaction`). Only the call
  that moves the row from an unsettled status to `confirmed` / `cancelled` returns `true`; every other caller gets
  `false` → `AppError('CONFLICT')`. This is what makes a repeat confirm / cancel-after-confirm / confirm-after-cancel
  fail closed instead of duplicating money movement.
- **Error strategy**: pure helpers throw `AppError` (`lib/errors`); fallible I/O paths return `Result<T>`
  (`mfa.verify`) or throw `AppError` at boundaries. NEVER swallow an error, never fire-and-forget an event write
  (`recordFailure`/`resetSession`/`reportInjection` are awaited). Never leak a raw exception or the MFA code to the model/UI.
  Ownership rejection uses `AppError('SECURITY_DENIED')` — `ErrorCode` has NO `FORBIDDEN`.
- **Circuit breaker is a hard gate the LLM cannot clear**: 3 consecutive MFA failures (`MFA_MAX_ATTEMPTS`)
  trip it for the OWNER/account and emit `CIRCUIT_BREAKER_TRIPPED` (severity `high`, top-level `userId`, EXACTLY ONCE per trip).
- **A tripped breaker denies ALL tiers — including 🟢 GREEN reads** (intended hard gate).
  `gatewayEvaluate` sets `blocked = locked || tier !== 'GREEN'`, so when tripped even a low-risk read
  (e.g. `get_balance`) is denied with decision `deny` / reason `HIGH_RISK_BLOCKED`. This is deliberate:
  an OWNER/account that just produced three consecutive failed strong-verifications is treated as compromised, so
  it fails closed for EVERY call (it must not even be able to probe balances) until a human deliberately unlocks it.
  It also blocks SDK writes: `security/execution-policy.ts#assertSessionMayWrite(sessionId, client?)` throws `AppError('CIRCUIT_OPEN')` (HTTP 423).
- **UNLOCK CONDITIONS (explicit)** — a locked OWNER/account is cleared ONLY by the deliberate, audited security-center
  action `resetSession(actor, { actor, reason, verificationCode?, now? })`, which records a COMPLETE `SECURITY_RESET` event
  (`actor`, `reason`, `wasLocked`, `previousFailures`, `priorLockedAt?`):
  - the model/LLM can NEVER unlock the breaker (no tool exposed to the model touches this state);
  - unlocking a TRIPPED breaker requires EXTRA verification: a correct `verificationCode` (`MFA_CODE`) OR an elapsed cooldown (`now >= lockedAt + RESET_COOLDOWN_MS`, `RESET_COOLDOWN_MS = 60_000`); otherwise `resetSession` throws `AppError('CIRCUIT_OPEN')` and leaves the lock INTACT — a bare session cookie is REFUSED;
  - it is reachable ONLY via the audited `POST /api/security/reset` (cookie-gated) → UI `app/security/ResetBreakerButton.tsx`; `reset(actor)` is the ungated, unaudited, route-less test-only clear;
  - `recordSuccess` does NOT unlock a tripped breaker (a correct MFA code on a NON-locked path only resets the counter);
  - a correct MFA code submitted WHILE locked is rejected and does NOT unlock (`mfa.verify` checks the lock first);
  - unlock clears ALL breaker state and restarts the failure counter from 0;
  - unlock does NOT itself re-authorize an action. Undecided actions need a fresh confirm/MFA;
    a result-less confirmed transfer must pass recovery authorization again; terminal/manual
    outcomes are not made executable by unlocking.
- **Injection guard never grants permission** — defense-in-depth only (see its file disclaimer).
- **Files ≲ ~1000 lines**; split by responsibility. No inter-module cycles.

## Known Issues

- **Ownership is REQUIRED; the caller identity is cookie-derived AND independently re-derived from persisted state.**
  `authorizeAction`/`cancelAction`/`handleToolCall` refuse a missing/mismatching identity with
  `SECURITY_DENIED` and never fall back to a demo user. The API layer derives identity from the HttpOnly
  `banking_session` cookie (`app/api/_lib/session.ts` `requireIdentity` → 403 on missing/unknown; any
  `?sessionId=`/`?userId=` query param is IGNORED), and `agent/confirmation.ts` independently re-derives the
  trusted owner from persisted state (`getPendingActionOwnership` + `getSession`), treating request-supplied
  ids as a fail-closed ASSERTION. Residual gap: the cookie carries no signed/HMAC token, so the check
  defends against mis-routing rather than a caller who already knows the `actionId` in the same session.
- **The circuit-breaker unlock IS wired to an app route.**
  `app/api/security/reset/route.ts` (`POST /api/security/reset`, cookie identity via `requireIdentity`)
  invokes `security.circuitBreaker.resetSession(sessionId, { actor, reason })` — the audited unlock that
  clears the lock AND records a `SECURITY_RESET` `SecurityEvent`. A tripped session is therefore no longer
  locked for the process lifetime once a human calls this route.
- **`mfa_required` is MISSING from `lib/contracts/audit.ts`.**
  `SecurityEventKind` has no `mfa_required` member, so the transfer escalation (YELLOW→RED at execution time)
  emits an EXISTING kind (`LIMIT_EXCEEDED`, severity `high`) with a COMPLETE `detail`
  (`decision:'escalate_to_mfa'`, `reason:'execution_time_transfer_re_risk'`, `actionId`, `amount`,
  `effectiveDailyTotal`, `projectedDailyTotal`, `persistedTier`, `persistedRequiresMfa`). A dedicated
  `mfa_required` kind should be added by the contract owner. NOTE: `mfa_required` IS a valid
  `AgentStreamEvent` type (surfaced by the API/agent layer), but NOT a `SecurityEventKind`.
- **`PendingActionStatus` has no `'executing'` member.**
  An in-flight (authorized-but-not-yet-ledgered) transfer is therefore identified by status `'confirmed'`;
  `IN_FLIGHT_TRANSFER_STATUSES` in `risk-engine.ts` includes `'executing'` defensively so an explicit
  in-flight marker added to the contract later is covered automatically.
- **Injection guard does NOT add a system reminder to the model context.**
  The only caller (`agent/run-turn.ts` ~L450-454) scans, awaits `reportInjection`, then emits a UI `security_event` (kind `injection`); nothing is appended to the agent's system prompt/messages, despite the `injection-guard.ts` header mentioning a system reminder.
  Detection, the `INJECTION_ATTEMPT` event, and never-grants-permission all hold (defense-in-depth unaffected).
- **"Repeated blocked high-risk attempts" is NOT a breaker trigger.**
  `recordFailure` is called ONLY from `mfa.ts` on a wrong code; no code path counts blocked/denied attempts.
- **Security-event writes are best-effort.**
  `recordSecurityEvent` (sibling `audit/`) logs and swallows persistence failures, so an awaited event write can silently fail; the breaker's in-memory `locked` flag remains authoritative.
- **`HIGH_RISK_BLOCKED` / `ANOMALY_FLAGGED` event kinds are declared but never written**
  by this node (it emits `CIRCUIT_BREAKER_TRIPPED`, `MFA_FAILURE`, `INJECTION_ATTEMPT`, `SECURITY_RESET`
  and — for the transfer escalation — `LIMIT_EXCEEDED`).
- **A transfer's terminal ledger write IS idempotent, so the ledgered-transfer dedup is ACTIVE.**
  The gateway serializes the AGGREGATE-limit re-risk (claim-first `$transaction`), and `lib/ledger`
  (`ledgerKeyForAction` → `idempotentTransferTxId`) + `banking-sdk/transfer.ts` (accepts an `idempotencyKey`, sets `Transaction.id`
  to that deterministic id) and the agent layer DOES pass the key — `ledgerKeyForAction(action)` = `nodeExecutionKey(taskId,nodeId)` for a plan-linked action, else the action `id` — so the created
  `Transaction.id` exactly equals `ledgerTxIdForAction(userId, action)` and the
  `computeInFlightTransferTotal` ledger-exclusion is LIVE (an in-flight `confirmed` action whose ledger
  row already exists is counted exactly once, via the executed half). Residual: the terminal-status flip
  (`recordActionResult`) is still a separate step from the SDK write — a crash between `authorizeAction`
  and `recordActionResult` leaves a `confirmed` action, but a retry now replays the same ledger row (at-most-once).

## Dependencies (contracts this node consumes)

`security` depends on `lib/` and, for SecurityEvent persistence, on the sibling `audit/` node
(audit owns audit/security-event persistence; it depends only on `lib`, so there is no cycle).

Frozen imports (already exist, DO NOT redefine): `lib/contracts/{risk,tools,security,audit}`, `lib/errors`
(`AppError`, `Result`, `ok`, `err`, `ErrorCode`), `lib/constants` (`DAILY_TRANSFER_LIMIT`, `MFA_CODE`,
`MFA_MAX_ATTEMPTS`, `RISK_LABEL`), `lib/money` (`formatCNY`, `parseAmount`), `lib/json` (`safeParse`),
`lib/clock` (`demoNow`), `lib/date` (`startOfDay`), `lib/db/client` (`prisma`, the singleton), `@prisma/client`
(the `Prisma` namespace / `TransactionClient` type; `recipient-resolution.ts` also imports `type Contact`).

Repository functions this node consumes (confirmed signatures — do NOT fork):
- `../audit` → `recordSecurityEvent(event: SecurityEvent): Promise<void>` (sibling node; implemented, callers `await` it — but its writes are BEST-EFFORT and swallow persistence failures, see Known Issues)
- `lib/db/repositories/pendingAction` → `createPendingAction(input): Promise<PendingAction>` (input also accepts optional `userRequest` / `intent` / `taskId` / `nodeId`, written through),
  `getPendingAction(id): Promise<(PendingAction & { mfa: MfaChallenge | null }) | null>`,
  `listPendingActionsByTask(taskId, { statuses? }): Promise<PendingAction[]>` (plan-scoped, oldest-first; used ONLY by the park-path dedupe, which reads the plan link off the rows),
  `claimPendingAction({ actionId, from, to, userId?, sessionId? }): Promise<boolean>` (the atomic compare-and-set used by `authorizeAction`/`cancelAction`; `true` iff exactly one row transitioned),
  `setPendingActionStatus(id, status)` (unconditional setter, used by `recordActionResult`; aliased from `updatePendingActionStatus(id, status): Promise<PendingAction>`)
- `lib/db/repositories/session` → `getSession(id): Promise<AgentSession | null>` (used by the gateway's ownership cross-check; `AgentSession` carries `userId`)
- `lib/db/repositories/pendingAction` (MFA challenge rows live in the SAME module) → `createMfaChallenge({ actionId, code, maxAttempts?, expiresAt? }): Promise<MfaChallenge>`,
  `getMfaChallenge(actionId): Promise<MfaChallenge | null>` (carries `code` — never expose it),
  `incrementMfaAttempts(actionId): Promise<MfaChallenge>`, `updateMfaChallengeStatus(actionId, status): Promise<MfaChallenge>`, `resetMfaAttempts(actionId): Promise<MfaChallenge>`
- `lib/db/repositories/transaction` → `listTransactions(query): Promise<Transaction[]>` (used by `risk.computeDailyTransferTotal`; its range is half-open `[from, to)`, so the inclusive upper bound is passed as `now + 1ms`). `risk.computeEffectiveTransferTotalWith` queries `client.transaction.findMany` directly (same window/filters) so it can run inside a `$transaction`.
- `lib/db/repositories/contact` → `listContacts(userId): Promise<Contact[]>` (used by `recipient-resolution.resolveTransferRecipient` to load the caller's OWN contacts once and match them in memory; the park path no longer uses `getContact`/`searchContacts`)
- `lib/db/repositories/account` → `getAccount(id): Promise<Account | null>` (used by `recipient-resolution.resolveAccountLabel` to name the caller's OWN funding account)

## Test Strategy

Vitest. This node is designed to be unit-testable WITHOUT network or clock:
- Pure units (`permission-engine`, `risk.evaluateTransferRisk`, `injection.scan`, `decide`,
  `serialize`/`parseBlockReason`, `buildPendingActionSummary`, `deriveIntent`) — table-driven, no DB.
- Breaker/MFA/gateway I/O units — run against the test SQLite (`lib/db`) with a unique USER/session identity
  per test, since the breaker state PERSISTS per owner (a lock survives a new session and a process restart); assert `recordFailure` emits `CIRCUIT_BREAKER_TRIPPED`
  and `resetSession` emits `SECURITY_RESET`. The gateway audit-trail specs assert the persisted
  `userRequest` + `intent` round-trip through `createPendingAction`/`handleToolCall`.
- Authorization-hardening units
  (`tests/unit/security/`) prove the exactly-once claim (`repeated confirm ⇒ CONFLICT`, confirm-after-cancel
  and cancel-after-confirm ⇒ `CONFLICT`), the ownership rejection (`SECURITY_DENIED`), the execution-time
  transfer re-risk escalation (parked YELLOW transfer escalates to MFA then still completes with the code),
  `recordActionResult` persistence, and the locked-session refusal.
- **These specs must supply `{ userId, sessionId }` to `authorizeAction`/`cancelAction`** (the options are
  required) and a non-empty identity to `handleToolCall`; a call without ids fails closed with `SECURITY_DENIED`.
- End-to-end agent scenarios (Tests 1–12, incl. injection & confirmation) live under `../tests/`.
- **All specs live under the root-owned `../tests/`** (the root `vitest.config.ts` discovers only `tests/**`). The `computeInFlightTransferTotal` ledger-dedup spec is `tests/unit/security/risk-engine-dedup.test.ts` (a hand-written Prisma stub implementing only `pendingAction.findMany` + `transaction.findMany`, cast to `PrismaLike`; no DB, no clock, no network), run with the other security units via `npx vitest run tests/unit/security`.

## Routing Table

This is a **leaf node** — it has no child directories; the modules above are its surface.
- `../tests/` → security/planner/sdk units + faux-LLM scenario integration tests (sibling — read-only, escalate writes to root)

## Notes for Agents

- Every money-moving tool MUST be gated through `securityGateway` — never add a tool that bypasses the policy table.
- When adding a tool, add its entry to `TOOL_POLICY` **and** `TOOL_INTENT` (both typed `Record<ToolName, …>` make a missing key a compile error).
- `PendingAction.args` are the ORIGINAL validated args — `authorizeAction` re-checks the breaker / re-risks a transfer but must not re-trust model text.
- Keep the MFA code inside `mfa.ts`; `MfaChallengeView.hint` and all `message` strings must never contain it (incl. `TRANSFER_ESCALATED_MESSAGE`, `MFA_CODE_PROMPT`).
- `authorizeAction`/`cancelAction` transition status ONLY through `claimPendingAction` (atomic compare-and-set; the transfer path uses the same CAS inline) — never a status peek then unconditional write; ownership mismatches use `AppError('SECURITY_DENIED')` (no `FORBIDDEN` code exists).
- After the agent layer executes an authorized action (or it fails), call `securityGateway.recordActionResult(id, 'executed'|'failed')` so the persisted terminal status is truthful and a later confirm/cancel is a `CONFLICT`.
- `authorizeAction`/`cancelAction`/`handleToolCall` REQUIRE a caller identity — never add a demo-user fallback; callers must pass `{ userId, sessionId }`.
- **All tests live under the root-owned `../tests/`** (the root `vitest.config.ts` discovers only `tests/**`): this node's security unit specs — including the DB-free dedup spec `tests/unit/security/risk-engine-dedup.test.ts` — run via `npx vitest run tests/unit/security`.
- **GREEN auto-executed reads are NOT audited.** The only `recordAudit` callers are the gated paths in `agent/confirmation.ts` (confirm/verify + cancel); a GREEN tool that executes inline writes no `AuditLog` row (by design, per `lib/contracts/audit`).
- **This node READS the owning plan's status at its two plan-cancel guard points, but is otherwise plan-UNAWARE.** `security-gateway.ts` never inspects the plan's node graph or its status transitions, and `cancelAction` only cancels ONE pending action (atomic `['pending','awaiting_mfa'] → 'cancelled'` claim). It DOES read `AgentTask.status` as a fail-closed cancel guard at create/park time (`gatewayCreatePendingAction`, same-tx as the insert), authorize time (both `authorizeTransfer` and `authorizeWithMfa`, same-tx as the CAS claim — the claim is reversed to `cancelled` and a clean `ok:false` is RETURNED, never thrown) — see the plan-cancel-guards paragraph above. This is what closes the cancel→authorize race when the plan-level bulk revoke (`agent/task-control.ts` `revokeParkedActions`/`sweepCancelledPlan`) is lost or neutralized; the sibling `agent/` node ALSO refuses at `agent/confirmation.ts` `cancelledPlanOutcome` BEFORE authorizing. The gateway loads the plan ONLY for its `status` (never its nodes) — no plan graph is traversed here.

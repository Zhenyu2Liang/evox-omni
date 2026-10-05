# agent — Pi Agent Runtime (runtime glue)

## Intent

`./agent` is the ONLY node in the codebase that talks to `@mariozechner/pi-agent-core` /
`@mariozechner/pi-ai`. It is the runtime glue that turns the frozen contracts into a running
banking agent. It owns, in one place:

1. constructing the Pi `Agent` (`banking-agent.ts`),
2. registering exactly the banking tools (`tools/`),
3. installing the security chokepoint `beforeToolCall` — delegating to `security.gateway.securityGateway.handleToolCall`,
4. running ONE chat turn and mapping `AgentEvent`s → `AgentStreamEvent`s (`run-turn.ts`),
5. the two-phase confirmation continuation, incl. the gateway-authorized execution path (`confirmation.ts`),
6. mapping a tool's raw result → `ChatCard`s (`card-emitter.ts`),
7. the banking system prompt (`system-prompt.ts`),
8. the per-session `AgentState` + transcript store (`session.ts`),
9. LLM provider selection — live model vs faux/mock (`providers/`),
10. durable DAG persistence + control/resume glue backing `submit_plan` (`task-control.ts`).

**Invariant (root-owned, restated here): the agent may decide WHAT to do next; it may NEVER decide
WHETHER it is allowed.** Every tool the model proposes passes through `beforeToolCall →
security.gateway.securityGateway.handleToolCall`; a gated tool is blocked, its args are persisted as a
`PendingAction`, and money only moves after a **human** confirmation. The model's text can never
trigger an execution. See root `../CONTEXT.md`.

## API Surface

The public surface is the facade `./agent/index.ts`, consumed by `app/api` route handlers and
`tests/`. All cross-module types are IMPORTED from `../lib/contracts/*` — never redeclared here.
Pi SDK types (`Agent`, `AgentTool`, `AgentState`, `AgentEvent`, `Model`, `Type`/`Static`) are
imported from `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` and DO NOT leak past the
facade boundary except where explicitly noted.

```ts
// --- agent/banking-agent.ts -------------------------------------------------
interface BankingAgentOptions {
  sessionId: string;
  userId: string;
  snapshot?: SessionSnapshot;   // restored AgentState + transcript; omitted ⇒ fresh session
}
interface BankingAgentRuntime {
  agent: Agent;                 // the live Pi Agent instance
  sessionId: string;
  userId: string;
  registry: ToolRegistry;       // per-user tool registry bound to `userId`
  serialize(): SessionSnapshot; // current pi AgentState + UI transcript
  dispose(): void;              // unsubscribe listeners
}
function createBankingAgent(options: BankingAgentOptions): BankingAgentRuntime;
type BeforeToolCallHook;        // installs security.gateway.securityGateway.handleToolCall (see Constraints)
type AfterToolCallHook;

// --- agent/system-prompt.ts -------------------------------------------------
interface SystemPromptContext {
  userId: string;
  displayName?: string;
  toolNames: ToolName[];        // the exact registered tools (so the prompt lists only real tools)
}
function buildSystemPrompt(ctx: SystemPromptContext): string;
const HALLUCINATION_RULE: string;   // exported fragment, reused by tests asserting the rule is present

// --- agent/session.ts -------------------------------------------------------
interface SessionSnapshot {
  sessionId: string;
  userId: string;
  agentState: AgentState;       // JSON-serializable pi state (systemPrompt/model/tools/messages)
  transcript: ChatMessage[];    // UI transcript (roles, cards, toolEvents)
  createdAt: number;
  updatedAt: number;
}
function newSession(userId: string): SessionSnapshot;                    // sessionId = newId('sess')
function loadSession(sessionId: string): Promise<SessionSnapshot | null>; // via lib/db/repositories/session
function saveSession(snapshot: SessionSnapshot): Promise<void>;          // upsert stateJson
function getOrCreateSession(userId: string, sessionId?: string): Promise<SessionSnapshot>;

// --- agent/run-turn.ts ------------------------------------------------------
interface RunTurnDeps {
  config?: AppConfig;           // defaults to lib/config getConfig()
  now?: () => number;           // injectable clock for deterministic tests
}
interface ResumeTurnInput {
  sessionId: string;
  toolResult: ToolExecutionResult;   // the REAL result of the gated tool (not model text)
  toolCallId?: string;
}
function runTurn(req: ChatTurnRequest, deps?: RunTurnDeps): Promise<ChatTurnResponse>;
function resumeTurn(input: ResumeTurnInput, deps?: RunTurnDeps): Promise<ChatTurnResponse>;

// --- agent/confirmation.ts --------------------------------------------------
interface ConfirmationOutcome {
  ok: boolean;
  actionId: string;
  status: PendingActionStatus;   // confirmed | executed | failed | cancelled | locked | awaiting_mfa
  tier: RiskLevel;               // EFFECTIVE tier: RED whenever `requiresMfa`, else the action's tier
  requiresMfa: boolean;          // EFFECTIVE MFA requirement (never the stale parked-row flag)
  message: string;
  result?: ToolExecutionResult;  // present when the original args were executed
  events: AgentStreamEvent[];    // continuation narration + any escalation events (`mfa_required`)
}
function confirmAction(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
function verifyAction(actionId: string, code: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
function cancelAction(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
// the single gateway-authorized execution path used by confirmation AND the planner's runTool:
function executeGatedTool(ctx: GatewayContext): Promise<GatedToolOutcome>;
// confirm/verify/cancel FAIL CLOSED when the action's owning plan is CANCELLED, BEFORE authorizing:
async function cancelledPlanOutcome(actionId: string, sessionId: string): Promise<ConfirmationOutcome | undefined>;  // findTaskByPendingAction + tasks.getTask; status 'cancelled' ⇒ refuse with the row's persisted status

// --- agent/card-emitter.ts --------------------------------------------------
function toCards(toolName: ToolName, result: ToolExecutionResult): ChatCard[];  // PURE, total
function errorCard(message: string): ChatCard;
function confirmationCard(action: PendingActionSummary): ChatCard;
function mfaCard(actionId: string, hint?: string): ChatCard;

// --- agent/providers/index.ts ----------------------------------------------
function resolveModel(cfg?: AppConfig): Model;   // mock ⇒ registerFauxProvider; live ⇒ pi-ai model
function providerId(cfg?: AppConfig): string;

// --- agent/tools/index.ts (see ./tools/CONTEXT.md) --------------------------
interface ToolExecutionResult { ok: boolean; data?: unknown; summary?: string; error?: string; tier?: RiskLevel }
interface ToolRegistry {
  tools: Record<ToolName, AgentTool<any>>;
  list(): AgentTool<any>[];
  get(name: ToolName): AgentTool<any>;
  executeDirect(name: ToolName, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}
interface CreateToolRegistryOptions { submitPlan?: SubmitPlanDeps }   // additive; wires `submit_plan`
function createToolRegistry(userId: string, opts?: CreateToolRegistryOptions): ToolRegistry;   // userId closed over — the model NEVER supplies it

// --- agent/task-control.ts (durable DAG persistence + control/resume glue) ----
interface TaskNodeOutput { pendingActionId?: string }   // the parked-node payload stored in AgentTaskNode.output
function readPendingActionId(output: unknown): string | undefined;   // the ONLY reader of that shape
type TaskRunTool = (toolName: string, args: Record<string, unknown>) => Promise<PlanToolOutcome>;   // gateway-routed runner, INJECTED by the caller
interface TaskControlOptions { now?: () => number }    // injectable clock; defaults to the demo clock
interface TaskControlDeps extends TaskControlOptions { runTool: TaskRunTool }
interface TaskPersistence {
  persistPlan(plan: TaskPlan): Promise<void>;
  persistNode(planId: string, node: TaskNodeResult): Promise<void>;
  loadPlan(planId: string): Promise<TaskPlan | undefined>;
}
function createTaskPersistence(planId: string): TaskPersistence;   // planner PlanDeps partials bound to planId (= AgentTask.id)
function toTaskPlan(row: AgentTaskWithNodes): TaskPlan;           // persisted task row (+ ordered nodes) → frozen TaskPlan
function defaultPollControls(planId: string): PlanControlPort;   // durable row status → planner controls ('paused'⇒pause, 'cancelled'⇒cancel)
function getTaskPlan(sessionId: string, taskId: string): Promise<TaskPlan>;                            // ownership-checked read
function pauseTask(sessionId: string, taskId: string, opts?: TaskControlOptions): Promise<TaskPlan>;   // persists durable status 'paused'
function resumeTask(sessionId: string, taskId: string, deps: TaskControlDeps): Promise<TaskPlan>;      // CAS-flips a resumable row to 'running', then runs with `explicitResume:true`; terminal (success) nodes skipped
function cancelTask(sessionId: string, taskId: string, opts?: TaskControlOptions): Promise<TaskPlan>;   // revokes the plan's parked PendingActions, then cancels
function retryTask(sessionId: string, taskId: string, deps: TaskControlDeps): Promise<TaskPlan>;       // retry failed nodes (+ descendants); CAS from-set EXCLUDES 'running' (resume KEEPS it)
function sweepCancelledPlan(sessionId: string, taskId: string): Promise<RevokeSummary>;                // post-run CANCEL SWEEP: if the persisted AgentTask is 'cancelled', revoke every still-parked PendingAction (run after submit_plan / resume / retry; an unexpected revoke failure THROWS)
function findTaskByPendingAction(sessionId: string, actionId: string): Promise<{ taskId: string; nodeId: string } | undefined>;
function resumeTaskForAction(sessionId: string, actionId: string, outcome: PlanToolOutcome, deps: TaskControlDeps): Promise<{ taskId: string; nodeId: string; plan: TaskPlan } | undefined>;
```

Everything above is also re-exported by the facade `./agent/index.ts`, which additionally exposes the
session-scoped control wrappers `pauseTask(sessionId, taskId)` / `resumeTask(sessionId, taskId)` /
`cancelTask(sessionId, taskId)` / `retryTask(sessionId, taskId)` / `getTaskPlan(sessionId, taskId)` —
each closes over the gateway-routed `TaskRunTool` and resolves the owner from the SESSION row.

### AgentEvent → AgentStreamEvent mapping (owned by `run-turn.ts`)

| Pi `AgentEvent` | emitted `AgentStreamEvent` |
|---|---|
| (session resolved) | `session` |
| `agent_start` | — |
| `turn_start` | — |
| `message_start` (assistant) | `message_start` |
| `message_update` (text delta) | `text_delta` (delta only; NO chain-of-thought) |
| `tool_execution_start` | `tool_start` (`ToolEventView.status:'started'`, tier from the security evaluation) |
| `tool_execution_update` | `tool_end` (`status:'updated'`) |
| `tool_execution_end` (ok) | `tool_end` (`status:'success'`) + `card`(s) from `toCards` |
| `tool_execution_end` (error) | `tool_end` (`status:'error'`) + `card`(error) |
| `tool_execution_end` (blocked) | `tool_end` (`status:'blocked'`) + `confirmation_required`/`mfa_required` |
| `message_end` | `message_end` + any `card`(s) resolved from the assistant message |
| `agent_end` | (persist session) |
| run error | `error` |
| (run settled) | `done` |

## The two-phase confirmation model (what `confirmation.ts` implements)

Turn (in `beforeToolCall`): a GREEN tool executes inline inside its `AgentTool.execute`. A YELLOW/RED
tool is **blocked** — `security.gateway.securityGateway.handleToolCall` persists a `PendingAction` and returns an
opaque block reason (`security.gateway.securityGateway.parseBlockReason` decodes it); the model sees
"awaiting confirmation/verification" and replies to the user.

Human decision (API route → `confirmation.ts`):
1. `confirmAction(id)` → `security.gateway.securityGateway.authorizeAction(id)` (YELLOW: authorize directly).
2. `verifyAction(id, code)` → `security.gateway.securityGateway.authorizeAction(id, { mfaCode: code })` (RED + MFA).
3. `cancelAction(id)` → `security.gateway.securityGateway.cancelAction(id)`.
4. On `AuthorizationResult.ok`, execute the **ORIGINAL validated args** through the Banking SDK via
   `executeGatedTool`/`registry.executeDirect` — **NOT** the LLM — write the audit entry, then call
   `resumeTurn(...)`, which injects the REAL tool result and calls `agent.continue()` so the model
   only *narrates the factual outcome*.
5. If the continuation itself fails (`agent.continue()` rejects — a model/narration error), the gated
   action has ALREADY executed and ALREADY been audited: `resumeTurn` catches the rejection, emits an
   `error` stream event and still returns the turn; `confirmation` keeps its outcome `result`-driven
   (never a fabricated success) and appends `（结果播报失败：…）` to the message it reports.

Consequence: money-moving calls are always triggered by a human decision, never by model text.

Idempotency (code-enforced, `confirmation.ts`): `executeAuthorizedAction` records the TRUE terminal
status with `gateway.recordActionResult(actionId, ok ? 'executed' : 'failed')` BEFORE auditing, and
resolves the owner from `getSession(action.sessionId)?.userId` (NO demo-user fallback — an unknown owner
is recorded `failed` and a `SECURITY_DENIED` is thrown). A repeat confirm or a confirm-after-cancel
raises a gateway `CONFLICT` that `confirmAction`/`verifyAction` catch into a real `ok:false`
(`conflictOutcome`, carrying the action's CURRENT status) — money moves AT MOST ONCE. After a confirmed
execution it resumes the owning DAG node (`resumeOwningPlan` → `resumeTaskForAction`) and then narrates
via `resumeTurn`.

### `submit_plan` durable DAG (plan-id ↔ AgentTask-id)

`runSubmitPlan` (`tools/planning.ts`, META / not risk-gated) VALIDATES the DAG, then mints the durable
rows FIRST: `createTask({sessionId, userId, goal})` returns the `AgentTask` whose id IS the canonical
plan id; then `plan = { ...dag.buildPlan({sessionId, goal, nodes, now}), id: task.id }` and one
`createTaskNode(...)` per node in declaration order (`order` = index, `status:'pending'`). It then runs
`executor.runPlan(plan, { runTool, onNodeUpdate, ...createTaskPersistence(plan.id) }, {signal, now})`,
so every node status/output is persisted incrementally (`persistNode`) and the plan survives a refresh.
`plan.id === AgentTask.id === taskId` on EVERY control path (`loadPlan` is `getTask` → `toTaskPlan`).
A parked (gated) node stores the human decision it waits on inside `AgentTaskNode.output` as
`{ pendingActionId: string }` (the `TaskNodeOutput` shape declared in `task-control.ts`, read via
`readPendingActionId`) — there is NO `pendingActionId` column and no `TaskNodeResult.pendingActionId`
field, and a
gated node is NOT a failure (only a hard `failed` plan status is `ok:false`).

#### Live plan streaming (turn time + resume time)

A `submit_plan` turn is observable in the UI, not just returned as a plan card:

- `run-turn.ts` passes an optional `onPlanUpdate(plan: TaskPlan)` sink into `createBankingAgent`
  (`BankingAgentOptions.onPlanUpdate`), which forwards it into `createToolRegistry(userId, { submitPlan })`
  → `SubmitPlanDeps.onPlanUpdate` → `runSubmitPlan`. `runSubmitPlan` wraps the executor's
  `onNodeUpdate` (which carries only the changed node), accumulates node results and composes the FULL
  `TaskPlan` snapshot (`composePlanSnapshot`, status derived like the executor's own snapshot), then
  forwards it after EVERY node change. `run-turn` relays each snapshot as
  `{ type:'plan_update', plan }` (the UI folds this into its DAG timeline).
- When a DAG node PARKS on a gated tool (`waiting_confirmation`/`waiting_verification`, its
  `PendingAction` id readable from `AgentTaskNode.output` via `readPendingActionId`), the relay
  remembers the node and — after the run settles, so the row is committed — emits the human-decision
  event decided by the PERSISTED `PendingAction` row (`tier`/`requiresMfa`, read via `loadPendingSummary`):
  YELLOW ⇒ `{ type:'confirmation_required', action: PendingActionSummary, actionId }` + a confirmation
  card; RED (or `requiresMfa`) ⇒ `{ type:'mfa_required', actionId, hint }` + an MFA card.
- `confirmation.ts#resumeOwningPlan` returns the plan snapshot produced by
  `resumeTaskForAction` (whose planner resume path has already written the executed node's REAL
  outcome — `success` + data/summary, or `failed` + error — and re-run the downstream nodes) and
  `executeAuthorizedAction` streams it as a `plan_update`, prepending it to the returned `events`.
  No extra `plan` CARD is emitted (the plan card stays the single one produced by `card-emitter`).
- The relay never invents progress: a failed node is reported `failed`, and a plan hiccup is surfaced
  as an `error` event rather than aborting the plan or the turn.
(this is what demo Test 4 — prompt injection — proves).

## Constraints (hard, encode in every file)

- **NEVER register a bash/shell/write/edit/file/SQL/system/http tool.** The model's ONLY capabilities
  are the registered banking tools + `submit_plan`. An injection asking for a shell/SQL tool has **no
  tool to call**. The tool registry is the complete and exhaustive capability set.
- **`beforeToolCall` is the ONLY security chokepoint.** It MUST call `security.gateway.securityGateway.handleToolCall`
  and return `{ block: true, reason }` whenever the gateway says the call is gated. The agent NEVER
  computes a tier, confirmation, or MFA requirement itself (that is `security/`'s sole authority).
- **`userId` is server-injected** (from the session / `lib/config.demoUserId`), never taken from the
  model or user text. Tools are built per-user via `createToolRegistry(userId)`.
- **Money moves ONLY via human confirmation** (two-phase model) — never from model text.
- **Hallucination guard**: assistant replies derive ONLY from real tool results. A tool returning
  `ok:false` MUST be reported as a failure; the agent MUST NOT invent balances/results and MUST NOT
  claim a gated tool already executed.
- **A continuation failure is not a business failure**: after a confirmed execution, a failing
  `agent.continue()` is surfaced as an `error` event / a flagged message — NEVER swallowed and NEVER
  turned into a success (the caller always receives the REAL `ToolExecutionResult`).
- **No chain-of-thought in UI events** — emit task steps, tool status and results only.
- **Determinism**: with `LLM_MODE=mock` (faux provider) the whole pipeline — agent + tools + security
  — runs offline. `run-turn`/`confirmation` accept an injectable `now` and `config` for tests.
- **Error strategy**: tool `execute` throws `AppError` on failure (the runtime converts it to an error
  tool-result); `executeDirect`/`executeGatedTool` catch and return `ToolExecutionResult{ok:false}`.
  All modules return `Result<T>` or throw `AppError` at boundaries; NEVER swallow, NEVER let a raw
  exception reach the model.
- **Provider selection is isolated** in `providers/`; the rest of the node never imports pi-ai model
  constructors directly (it receives a `Model` from `resolveModel`).
- **Dependency direction**: `agent` DEPENDS ON `lib`, `banking-sdk`, `security`, `planner`, `audit` —
  never the reverse. No inter-module cycles. `components`/`app` depend on `agent`, never vice versa.
- **Files ≲ ~1000 lines**; split by responsibility. No pi-Agent logic outside this node.

## Dependencies

Frozen imports (exist, DO NOT redefine): `../lib/contracts/*` (`agent`, `security`, `tools`, `task`,
`risk`, `audit`), `../lib/errors`, `../lib/config` (`AppConfig`, `getConfig`), `../lib/constants`,
`../lib/ids` (`newId`), `../lib/json` (`toJson`/`safeParse`), `../lib/money`.

Sibling nodes this node consumes (read-only; escalate changes to the owner):
- `../security` → `security.gateway.securityGateway.handleToolCall(ctx): ToolCallAuthorization`, `.parseBlockReason`,
  `.authorizeAction(id, {mfaCode?})`, `.cancelAction(id)`, `.serializeBlockReason`; `GatewayContext`,
  `AuthorizationResult`, `ToolCallAuthorization`. `security.injection.scan` / `.reportInjection`.
  Access path: the `gateway` namespace's ONLY runtime member is the exported object `securityGateway`
  (module-level `handleToolCall`/`authorizeAction`/`cancelAction`/`parseBlockReason` are private), so the
  runtime call is `security.gateway.securityGateway.<method>(...)`; `GatewayContext`/`AuthorizationResult`/
  `ToolCallAuthorization` are imported directly from `@/security/security-gateway`.
- `../banking-sdk` → `banking.<domain>.*` execute-only functions (module `./types` DTOs).
- `../planner` → `dag.validatePlan`, `buildPlan`; `executor.runPlan`, `executor.persistPlanSnapshot`, `PlanDeps`, `PlanControls`; `lifecycle.pausePlan`/`cancelPlan`/`retryPlan`/`resumePlan`.
- `../audit` → `recordAudit(entry)`, `recordSecurityEvent(event)`.
- `../lib/db/repositories` → `sessions.*`, `pendingActions.*`, `tasks.*` (`createTask`, `createTaskNode`, `getTask`, `listTasksBySession`, `updateTaskNode`, `updateTaskStatus`, `AgentTaskWithNodes`).

REQUIRED from siblings (must align at integration; assumed signatures):
- `security.gateway.securityGateway.handleToolCall(ctx)` returns `{ evaluation, decision, action?, blockReason? }` with
  `blockReason` present iff `evaluation.blocked`; `action` present iff gated.
- `security.gateway.securityGateway.authorizeAction(id, opts)` returns `AuthorizationResult` — it authorizes but does NOT execute. `confirmation.ts` reads every field through the `viewAuth` normalizer, so it stays green across the CURRENT shape (`{ ok, status, actionId,
  tier, requiresMfa, mfaResult?, message, action? }`) AND the FROZEN shape (`{ ok; tier; requiresMfa; actionId? } | { ok:false; code; message; tier; requiresMfa }`). The effective tier is RED whenever `requiresMfa`.
- `planner.executor.runPlan(plan, deps, opts)` with `deps.runTool(toolName, args): PlanToolOutcome`
  (`{ ok, data?, summary?, error?, requiresConfirmation?, pendingActionId? }`); the agent supplies
  `runTool = executeGatedTool`, so a gated node parks in `waiting_confirmation`/`waiting_verification`.
- `banking-sdk` functions take `userId` as the first argument and throw typed `AppError`.
- `sessions.getSession`, `sessions.createSession({userId, stateJson})`, `sessions.updateSessionState(id, stateJson)`.

## Pi SDK Reconciliation (verified against installed 0.73.1)

Stub signatures and `./tools/CONTEXT.md` diverge from the REAL SDK — implement against
`node_modules/@mariozechner/*`:
- `AgentTool<TParameters extends TSchema = TSchema, TDetails = any>` — the generic is a **TypeBox
  TSchema**, NOT `Static<>`. A tool is `AgentTool<typeof <Name>Params>`; a heterogeneous registry uses
  `AgentTool<any>` (matches `AgentState.tools: AgentTool<any>[]`); `AgentTool<unknown>` does NOT compile.
- `execute(toolCallId, params: Static<TParameters>, signal?, onUpdate?): Promise<AgentToolResult<TDetails>>`
  with `AgentToolResult<T> = { content: (TextContent|ImageContent)[]; details: T; terminate? }`.
- `Model<TApi extends Api>` **requires a type argument**; this node standardises on `Model<any>`.
  `registerFauxProvider()` → registration whose `getModel(): Model<string>` is the mock model.
- `AgentOptions.beforeToolCall?: (ctx: BeforeToolCallContext, signal?) => Promise<BeforeToolCallResult|undefined>`
  with `ctx.toolCall` (`.name`/`.arguments`) and `ctx.args: unknown`; return `{ block: true, reason }`.

## Known Issues

- **Cross-action transfer serialization depends on SQLite's DB-level single-writer lock, and the gateway's confirm-time re-risk transaction does not include the SDK execution.** `security/security-gateway.ts#authorizeTransfer` re-risks in ONE `prisma.$transaction` that CAS-claims the action FIRST and only THEN reads the in-flight-inclusive effective total (`computeEffectiveTransferTotalWith`) and re-runs `evaluateTransferRisk` (escalating to MFA when the day's total would exceed the limit), so concurrent confirms of DISTINCT parked transfers serialize only through SQLite's single-writer lock - with no explicit isolation level or `SELECT ... FOR UPDATE`; and a crash between that commit and `agent/confirmation.ts#executeAuthorizedAction` (which runs the transfer, then `recordActionResult`) leaves a `confirmed`-but-unledgered action counted as in-flight (over-conservative, never under-counting).

## Notes for Agents

- Pi SDK type/function names (`Agent`, `AgentTool`, `AgentState`, `AgentEvent`, `registerFauxProvider`,
  `Type`, `Static`) are relied on per the verified 0.73.1 facts in root `../CONTEXT.md`; confirm exact
  exported identifiers against the installed packages (see the Pi SDK Reconciliation section above).
- `system-prompt.ts` may list ONLY the tools actually present in `ToolRegistry` — no phantom capabilities.
- `ConfirmationOutcome.requiresMfa` is the EFFECTIVE MFA requirement and `tier` is the EFFECTIVE tier (RED whenever `requiresMfa`). `app/api/actions/[id]/confirm|verify/route.ts` should surface `outcome.requiresMfa`; the current `outcome.tier === 'RED'` derivation still agrees because the tier is effective. Owner of `./app` — escalate route edits to the parent.
- The human-decision stream events are emitted from two distinct sites (same names, different payloads): `confirmation_required` ONLY from `run-turn.ts` (turn-time, via `handleToolExecutionEnd` for a directly-blocked gated tool, or `emitParkedDecision` for a parked DAG node) and NEVER from `confirmation.ts`; `mfa_required` from `run-turn.ts` (with `hint: MFA_HINT` + an MFA card) AND from `confirmation.ts#blockedOutcome` (with ONLY `{ actionId }` — no `hint`, no card) when a confirm/verify authorization still requires verification (wrong code ⇒ `awaiting_mfa`, or `locked`).
- Every card emitted to the UI must originate from a real tool result (or a real security decision) —
  never from model prose. `card-emitter.toCards` is PURE and total (unknown shape ⇒ `error` card).
- `submit_plan` is meta (not risk-gated): it validates the DAG, then runs it via `planner.runPlan` with
  `runTool = executeGatedTool`; individual money-moving nodes still gate through the gateway.

## Test Strategy

Vitest (`tests/`, sibling). This node is designed to be testable WITHOUT network:
- `card-emitter.toCards` — pure table-driven unit tests (one case per tool family + unknown ⇒ error).
- `system-prompt.buildSystemPrompt` — asserts the hallucination/`success:false` rules and that only
  registered tool names appear.
- `session` / `banking-agent` — against the test SQLite via `lib/db/repositories/session`; assert
  `AgentState` round-trips through `serialize`/`load`.
- Full-pipeline scenarios (the 12 demo Tests) run `runTurn` + `confirmAction`/`verifyAction` with
  `LLM_MODE=mock` (faux scripts) — proving gating, MFA, injection refusal, and the hallucination guard.
- No live LLM and no live Prisma are required for unit tests; scenario tests use the test DB.
- The **offline mock model** (`providers/`) is the default `LLM_MODE=mock` runtime: `providers/provider-mock.test.ts` (16 unit tests) covers the responder; `integration-mock.test.ts` proves the REAL pipeline (runTurn → `createBankingAgent` → mock → tools → gateway → SDK → DB) end-to-end offline; `run-turn-failure.test.ts` covers the failure / continuation-failure guards.
- **HTTP-level reachability through the real mock model** (drives `POST /api/chat` E2E): the mock responder turns a real message into a GREEN read (`余额`/`还剩`/`多少钱` ⇒ `get_balance`), a parked YELLOW transfer (`给张伟转200元`), a parked RED transfer (`给张伟转5000元`), or a `submit_plan` DAG (`如果…就…` / `帮我计划…` ⇒ `plan_update` events). Honest failure narration is reached via a RED transfer above the balance (`给张伟转30000元` ⇒ verify ⇒ `INSUFFICIENT_FUNDS`). A conditional plan that ALSO asks to adjust a card spend limit (`如果这个月娱乐消费超过2000元，就把娱乐消费限额调整为1500元`) emits a `submit_plan` DAG whose `set_card_limit` node is YELLOW and PARKS, so the plan-level `confirmation_required` frame IS reachable through the mock model (see `./providers/CONTEXT.md`).
- The agent unit specs live at `tests/unit/agent/confirmation-idempotency.test.ts`, `tests/unit/agent/confirmation.test.ts`, `tests/unit/agent/run-turn-failure.test.ts`, `tests/unit/agent/task-control.test.ts` and `tests/unit/agent/providers/provider-mock.test.ts`; they are auto-discovered by the ROOT `vitest.config.ts` (`test.include: ['tests/**/*.{test,spec}.ts']`) and run via `npm run test`. `tests/` is a read-only SIBLING of this node.

## Routing Table

- `./agent/banking-agent.ts` → constructs the Pi `Agent`, wires tools + `beforeToolCall`/`afterToolCall`, provider, restored `AgentState`
- `./agent/system-prompt.ts` → banking system prompt builder + hallucination/permission rules
- `./agent/session.ts` → per-session `AgentState` + transcript load/create/persist
- `./agent/run-turn.ts` → one chat turn: prompt, event→stream mapping, persistence; `resumeTurn`
- `./agent/confirmation.ts` → two-phase continuation: confirm/verify/cancel + gateway-authorized execution path
- `./agent/card-emitter.ts` → pure `toCards(toolName, result): ChatCard[]` mapping + card helpers
- `./agent/task-control.ts` → node-output JSON shape + DAG plan persistence/load mapping + pause/resume/cancel/retry/getTaskPlan glue (ownership-checked)
- `./agent/index.ts` → node facade (runtime surface: create/run/resume/confirm/verify/cancel/toCards + DAG control glue `pauseTask`/`resumeTask`/`cancelTask`/`retryTask`/`getTaskPlan`)
- `./agent/tools` → registered banking tools: one module per family + `createToolRegistry` (child node)
- `./agent/providers` → LLM provider selection: live + faux/mock + selector (child node)
- `../tests` → agent unit + faux-LLM scenario integration tests (sibling — read-only, escalate writes to root)
- `../lib/contracts` → frozen cross-module types this node imports (sibling — read-only)
- `../security` `../planner` `../banking-sdk` `../audit` → sibling nodes this node orchestrates (read-only)

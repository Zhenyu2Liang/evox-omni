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
  tier: RiskLevel;
  message: string;
  result?: ToolExecutionResult;  // present when the original args were executed
  events: AgentStreamEvent[];    // continuation narration (agent.continue()) events
}
function confirmAction(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
function verifyAction(actionId: string, code: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
function cancelAction(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
// the single gateway-authorized execution path used by confirmation AND the planner's runTool:
function executeGatedTool(ctx: GatewayContext): Promise<GatedToolOutcome>;

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
function getTaskPlan(sessionId: string, taskId: string): Promise<TaskPlan>;                            // ownership-checked read
function pauseTask(sessionId: string, taskId: string, opts?: TaskControlOptions): Promise<TaskPlan>;
function resumeTask(sessionId: string, taskId: string, deps: TaskControlDeps): Promise<TaskPlan>;      // re-run; terminal nodes skipped
function cancelTask(sessionId: string, taskId: string, opts?: TaskControlOptions): Promise<TaskPlan>;
function retryTask(sessionId: string, taskId: string, deps: TaskControlDeps): Promise<TaskPlan>;       // retry failed nodes (+ descendants)
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
- `security.gateway.securityGateway.authorizeAction(id, opts)` returns `AuthorizationResult { ok, status, actionId,
  tier, requiresMfa, mfaResult?, message, action? }` — it authorizes but does NOT execute.
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

## Notes for Agents

- Pi SDK type/function names (`Agent`, `AgentTool`, `AgentState`, `AgentEvent`, `registerFauxProvider`,
  `Type`, `Static`) are relied on per the verified 0.73.1 facts in root `../CONTEXT.md`; confirm exact
  exported identifiers against the installed packages (see the Pi SDK Reconciliation section above).
- `system-prompt.ts` may list ONLY the tools actually present in `ToolRegistry` — no phantom capabilities.
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
- Node-local agent tests live in `agent/__tests__/` and run via `npx vitest run --config agent/vitest.config.ts`: `confirmation-idempotency.test.ts` (4 tests — repeated/cross-session confirm idempotency + foreign-owner rejection) and `task-control.test.ts` (5 tests — `runSubmitPlan` persistence with `plan.id === AgentTask.id`, ownership rejection, pause/resume/cancel). `tests/` is a read-only sibling, so these stay node-local pending relocation.

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

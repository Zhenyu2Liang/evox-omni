# agent — Pi Agent Runtime (runtime glue)

## Intent

Confirm/verify/replay recovery share `buildConfirmFence` + `guardExecutionFence`: the persisted
action session is checked by security at the SDK mutation boundary. A CIRCUIT_OPEN denial is not
normalised into a failed business result; no new side effect is landed and the action stays
confirmed. A transfer can re-enter recovery authorization after an audited unlock; other tools
still require proven committed evidence or manual reconciliation. Standalone recovery builds its audit from the current
persisted authorization inside the status/result/audit transaction, including receipt fallbacks.

`./agent` is the ONLY node in the codebase that talks to `@earendil-works/pi-agent-core` /
`@earendil-works/pi-ai`. It is the runtime glue that turns the frozen contracts into a running
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
imported from `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` and DO NOT leak past the
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
  provider?: ModelRuntime;      // TEST SEAM (additive): scripted {model,streamFn}; absent ⇒ resolveProvider(config)
}
interface ResumeTurnInput {
  sessionId: string;
  toolResult: ToolExecutionResult;   // the REAL result of the gated tool (not model text)
  toolCallId?: string;
  toolName?: ToolName;          // server-owned action name, or submit_plan for a DAG node
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

// --- agent/execution-convergence.ts (SINGLE terminal-state decider) ---------
const PLAN_LINKED_UNRECONCILED_ERROR = '该节点此前已执行但未留存结果，需人工核对（不会重新执行）。';  // frozen string contract
interface ConvergenceActionRow {                       // the persisted PendingAction identity + evidence columns
  id: string; userId: string; sessionId: string; taskId: string | null; nodeId: string | null;
  status: string; resultJson: string | null; toolName: string; riskLevel: string; requiresMfa: boolean;
  userRequest: string | null; intent: string | null;
  executionLeaseOwner: string | null; executionLeaseExpiresAt: Date | null;
}
type ConvergenceEvidence = 'receipt' | 'stored' | 'live' | 'none';
interface ConvergenceDecision { status: PendingActionStatus; result?: ToolExecutionResult; evidence: ConvergenceEvidence; write: boolean }
function decideConvergence(action: ConvergenceActionRow, opts?: { nowMs?: number }): Promise<ConvergenceDecision>;
function buildRecoveryAudit(action: ConvergenceActionRow, decision: ConvergenceDecision): AuditEntry;

// --- agent/execution-fence.ts (SDK-write execution fence) -------------------
function buildPlanNodeFence(taskId: string | null | undefined, nodeId: string | null | undefined): Promise<ExecutionFenceCheck | undefined>;
function buildConfirmFence(taskId: string | null | undefined, nodeId: string | null | undefined): Promise<ExecutionFenceCheck | undefined>;

// --- agent/card-emitter.ts --------------------------------------------------
function toCards(toolName: ToolName, result: ToolExecutionResult): ChatCard[];  // PURE, total
function errorCard(message: string): ChatCard;
function confirmationCard(action: PendingActionSummary): ChatCard;
function mfaCard(actionId: string, hint?: string): ChatCard;

// --- agent/providers/index.ts ----------------------------------------------
function resolveProvider(cfg?: AppConfig): ModelRuntime; // { model, streamFn }; pass both to Agent
function resolveModel(cfg?: AppConfig): Model<any>; // inspection facade; not enough to construct Agent
function providerId(cfg?: AppConfig): string;

// --- agent/tools/index.ts (see ./tools/CONTEXT.md) --------------------------
interface ToolExecutionResult { ok: boolean; data?: unknown; summary?: string; error?: string; tier?: RiskLevel }
interface ToolRunOptions { idempotencyKey?: string; fence?: ExecutionFenceCheck }   // ADDITIVE optional; threaded to the SDK by executeDirect (idempotencyKey consumed by transfer_money, apply_virtual_card, reserve_budget, create_scheduled_task, investment tools; `fence` is the SERVER-GENERATED execution fence — see `agent/execution-fence.ts` — attached to the SDK write input and awaited INSIDE the SDK write tx by reserve_budget / transfer_money)
interface ToolRegistry {
  tools: Record<ToolName, AgentTool<any>>;
  list(): AgentTool<any>[];
  get(name: ToolName): AgentTool<any>;
  executeDirect(name: ToolName, args: Record<string, unknown>, opts?: ToolRunOptions): Promise<ToolExecutionResult>;
}
interface CreateToolRegistryOptions { submitPlan?: SubmitPlanDeps }   // additive; wires `submit_plan`
function createToolRegistry(userId: string, opts?: CreateToolRegistryOptions): ToolRegistry;   // userId closed over — the model NEVER supplies it

// --- agent/task-control.ts (durable DAG persistence + control/resume glue) ----
interface TaskNodeOutput { pendingActionId?: string }   // the parked-node payload stored in AgentTaskNode.output
function readPendingActionId(output: unknown): string | undefined;   // the ONLY reader of that shape
type TaskRunTool = (toolName: string, args: Record<string, unknown>, ctx: NodeExecutionContext) => Promise<PlanToolOutcome>;   // gateway-routed runner, INJECTED by the caller; 3rd param REQUIRED (node identity)
interface TaskControlOptions { now?: () => number }    // injectable clock; defaults to the demo clock
interface TaskControlDeps extends TaskControlOptions { runTool: TaskRunTool }
interface TaskPersistence {
  persistPlan(plan: TaskPlan): Promise<void>;
  persistNode(planId: string, node: TaskNodeResult): Promise<void>;
  loadPlan(planId: string): Promise<TaskPlan | undefined>;
}
interface TaskPersistenceOptions {                    // fences this run's writes on its execution claim (see `buildPlanDeps`)
  planToken?: string;                                  // current PLAN claim (`AgentTask.executionToken`) — fences `persistPlan`
  nodeToken?: (nodeId: string) => string | undefined;  // resolver for the CURRENT NODE claim — fences `persistNode`
}
function createTaskPersistence(planId: string, opts?: TaskPersistenceOptions): TaskPersistence;   // planner PlanDeps partials bound to planId (= AgentTask.id); `opts.mode` (default 'executor') selects the write path — EXECUTOR: FENCE every write on the node token (else the plan token), SKIP a token-fenced write whose claim was lost (no unfenced fallback); CONTROL (`pauseTask`/`cancelTask`): write UNFENCED (holds NO claim to fence on), never an executor write.
function toTaskPlan(row: AgentTaskWithNodes): TaskPlan;           // persisted task row (+ ordered nodes) → frozen TaskPlan
function defaultPollControls(planId: string): PlanControlPort;   // durable row status → planner controls ('paused'⇒pause, 'cancelled'⇒cancel)
export function planExecutionClaimHeld(planId: string, token: string): Promise<boolean>;   // cheap read of `AgentTask.executionToken` — gates the `plan_update`/`onNodeUpdate` publication (see `agent/tools/planning.ts`); NEVER a security check (node ownership is the atomic CAS below)
export function clearStaleNodeClaims(planId: string, planToken: string): Promise<void>;  // CLEARS every NON-TERMINAL node execution claim of the plan, FENCED on the caller's just-won PLAN token; called immediately after EVERY successful `claimTaskExecution` (`runSubmitPlan` / `resumeTask` / `retryTask` / `resumeTaskForAction`'s WON path) so a takeover can RECLAIM the previous owner's non-terminal nodes instead of wedging at `running`. A loser's `updateMany` matches 0 rows (preserving "exactly one takeover winner"), and a fresh plan / clean release is a no-op
export function buildNodeClaimPorts(planId: string, planToken: string | undefined): { claimNode: NonNullable<PlanDeps['claimNode']>; releaseNode: NonNullable<PlanDeps['releaseNode']>; nodeTokens: Map<string, string> };   // atomic PLAN-OWNERSHIP-aware node claim/release ports + the per-node token map shared with `createTaskPersistence`'s `nodeToken` resolver; used by EVERY executor pass — `resumeTask`/`retryTask`/`resumeTaskForAction` (via `buildPlanDeps`) AND the initial `submit_plan` run (`tools/planning.ts`)
function getTaskPlan(sessionId: string, taskId: string): Promise<TaskPlan>;                            // ownership-checked read
function pauseTask(sessionId: string, taskId: string, opts?: TaskControlOptions): Promise<TaskPlan>;   // persists durable status 'paused'
function resumeTask(sessionId: string, taskId: string, deps: TaskControlDeps): Promise<TaskPlan>;      // CAS-flips a resumable row to 'running' (from-set KEEPS 'running'), then acquires the PLAN-level DB execution claim (`claimTaskExecution` with the TTL stale horizon `staleBefore`; lost => persisted plan, NO second executor; released in a finally), then runs with `explicitResume:true`; terminal (success) nodes skipped
function cancelTask(sessionId: string, taskId: string, opts?: TaskControlOptions): Promise<TaskPlan>;   // revokes the plan's parked PendingActions via the atomic bulk `revokePendingActionsByTask` (PRIMARY; node-output scan is FALLBACK), then cancels
function retryTask(sessionId: string, taskId: string, deps: TaskControlDeps): Promise<TaskPlan>;       // retry failed nodes (+ descendants); CAS from-set EXCLUDES 'running' (resume KEEPS it); acquires the PLAN-level DB execution claim (TTL stale horizon `staleBefore`) before running (lost => persisted plan, NO second executor; released in a finally)
function sweepCancelledPlan(sessionId: string, taskId: string): Promise<RevokeSummary>;                // post-run CANCEL SWEEP: if the persisted AgentTask is 'cancelled', revoke every still-parked PendingAction (run after submit_plan / resume / retry; an unexpected revoke failure is recorded as a SecurityEvent via recordRevokeFailure, and the summary is still returned)
function findTaskByPendingAction(sessionId: string, actionId: string): Promise<{ taskId: string; nodeId: string } | undefined>;   // prefers the action's PERSISTED plan link (PendingAction.taskId/nodeId, ownership-checked via getTask); node-output scan is FALLBACK
function resumeTaskForAction(sessionId: string, actionId: string, outcome: PlanToolOutcome, deps: TaskControlDeps): Promise<{ taskId: string; nodeId: string; plan: TaskPlan } | undefined>;   // mints a FRESH PLAN token via `claimTaskExecution(..., { staleBefore })` (released in a finally) and, when WON, ADVANCES the plan via `lifecycle.resumePlan` in EXECUTOR mode (+ `PAUSE_NOW_CONTROLS` when the row is 'paused', then `sweepCancelledPlan`); when LOST it does NOT advance the plan (a LIVE owner is walking it and two overlapping walks could LAUNCH a node twice) but STILL records the ONE decided node through `recordDecidedNodeFenced` — a single atomic FENCED write that follows the node token, else the LIVE plan token, else (NO owner left) an atomic NO-OWNER CAS (`task: { executionToken: null }`) which then settles the plan status from the persisted node rows via `settlePlanFromNodes`; a 'cancelled' plan is a no-op
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
   Production confirmation supplies the expected tool name (submit_plan for a linked DAG node).
   Missing original calls are narration errors; another tool's result is never overwritten as a
   fallback. Reused call ids target the latest matching id/name pair.
5. If the continuation itself fails (`agent.continue()` rejects — a model/narration error), the gated
   action has ALREADY executed and ALREADY been audited: `resumeTurn` catches the rejection, emits an
   `error` stream event and still returns the turn; `confirmation` keeps its outcome `result`-driven
   (never a fabricated success) and appends `（结果播报失败：…）` to the message it reports.

Consequence: money-moving calls are always triggered by a human decision, never by model text — the injection-resistance guarantee demo Test 4 (prompt injection) proves.

Idempotency (code-enforced, `confirmation.ts`): `executeAuthorizedAction` derives the SDK idempotency key
with the shared-kernel helper `ledgerKeyForAction({ id, taskId, nodeId })` (`@/lib/ledger`) from the
action's PERSISTED plan link (`getPendingActionPlanLink`) — `nodeExecutionKey(taskId, nodeId)`
(= `nxe:<taskId>:<nodeId>`) when the action parked a plan node, else `action.id` (the standalone action's
own id) — and passes it to
`registry.executeDirect(action.toolName, action.args, { idempotencyKey })` for EVERY tool. Using the SAME
`ledgerKeyForAction` generation that `security/`'s risk engine looks up (`ledgerTxIdForAction`) keeps an
already-ledgered in-flight transfer excluded from the cumulative daily total. The INLINE
GREEN node path (`executeGatedToolOnce`) passes the same `nodeExecutionKey`, so a re-run of a GREEN node
re-issues the same SDK request, which the SDK idempotency key dedups (no duplicate side effect) — a GATED plan node, by contrast, NEVER re-runs its tool on a resume: it parks or BACKFILLS (see the recovery guarantee below).
`transfer_money`, `reserve_budget`, `create_scheduled_task`, `apply_virtual_card` AND the investment
tools (`subscribe_investment`/`redeem_investment`; `agent/tools/investment.ts` accepts `opts?: ToolRunOptions`
and forwards `idempotencyKey`) all thread the key into their banking-sdk call; `transfer_money` derives the
created ledger row id from the key via `idempotentTransferTxId(userId, key)` (the DB PK dedups the write,
so no lock is needed); `apply_virtual_card` (`agent/tools/card.ts` accepts `opts?: ToolRunOptions` and forwards the key) makes the SDK derive a deterministic card id via `idempotentCardId(userId, key)` — the SAME key reuses ITS card (so a replayed plan node yields one card), while distinct plans with different keys get independent cards.
`executeAuthorizedAction` settles the ORIGINAL `ToolExecutionResult` AND the TRUE terminal status AND the audit row in ONE atomic `prisma.$transaction` (`agent/confirmation-recovery.ts#settlePendingAction`: optionally a `claimPendingAction` CAS, the result write, then `recordAudit(entry, { client: tx, dedupeKey, strict: true })`) for BOTH outcomes, so a later recovery of the
node BACKFILLS it WITHOUT re-running the tool (see the guarantees section) and the row can never dangle
`confirmed` with its result already stored. Because the audit is `strict` and in the SAME tx, an audit insert failure rolls the WHOLE settle back — the action stays `confirmed`, and a later recovery re-settles it FROM the committed receipt (see the recovery guarantees) and BACKFILLS the audit; the `exec:<actionId>` `dedupeKey` (unique `AuditLog.dedupeKey`) makes a repeat a no-op — never double-recorded, never re-debited, never `executed`→`failed`. It THEN calls the gateway's audited
`recordActionResult(actionId, ok ? 'executed' : 'failed')` inside a best-effort `try` — NON-FATAL,
because the row is already settled atomically above, so a failure there must never turn a
successfully-executed action into an error response. It
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
`createTaskNode(...)` per node in declaration order (`order` = index, `status:'pending'`). It then CLAIMS
the plan's executor slot (`claimTaskExecutionWithGeneration(plan.id, newId('taskclaim'))`; a lost claim returns
`ok:false` and runs NOTHING), clears the plan's non-terminal node claims under the won token
(`clearStaleNodeClaims` — a no-op on a fresh plan) and runs
`executor.runPlan(plan, { runTool, onNodeUpdate, controls, claimNode, releaseNode, ...createTaskPersistence(plan.id, { planToken: claimToken, nodeToken: (nodeId) => nodeTokens.get(nodeId) }) }, {signal, now})`
with `{ claimNode, releaseNode, nodeTokens } = buildNodeClaimPorts(plan.id, claimToken)` — the SAME
ATOMIC plan-ownership-aware node claim every other executor pass uses, so ownership is verified in the
SAME statement as the claim and there is NO TOCTOU window between the read and the tool launch — so
every node status/output is persisted incrementally (`persistNode`, FENCED on the plan claim via the
per-node token, else the PLAN-token fence) and the plan survives a refresh;
the claim is released in a `finally`.
`plan.id === AgentTask.id === taskId` on EVERY control path (`loadPlan` is `getTask` → `toTaskPlan`).
A parked (gated) node stores the human decision it waits on inside `AgentTaskNode.output` as
`{ pendingActionId: string }` (the `TaskNodeOutput` shape declared in `task-control.ts`, read via
`readPendingActionId`) — there is NO `pendingActionId` column and no `TaskNodeResult.pendingActionId`
field, and a
gated node is NOT a failure (only a hard `failed` plan status is `ok:false`).

#### Live plan streaming (turn time + resume time)

A `submit_plan` turn is observable in the UI, not just returned as a plan card:

- `run-turn.ts` passes an optional `onPlanUpdate(plan: TaskPlan)` sink into `createBankingAgent` → `createToolRegistry(userId, { submitPlan })` → `SubmitPlanDeps.onPlanUpdate` → `runSubmitPlan`, which wraps the executor's `onNodeUpdate`, accumulates node results, composes the FULL `TaskPlan` snapshot (`composePlanSnapshot`) and forwards it after EVERY node change; `run-turn` relays each as `{ type:'plan_update', plan }` (folded into the UI DAG timeline).
- `runSubmitPlan`'s `onNodeUpdate` GATES publication on `planExecutionClaimHeld(plan.id, claimToken)` (a cheap read of the parent `AgentTask.executionToken`), so a run whose PLAN claim was taken over emits NO stale snapshot (the node write is fenced separately by `createTaskPersistence`; the gate only suppresses the publication). The wrapper ALSO re-checks AFTER its (arbitrarily long-blocking) node sink returns and BEFORE publishing — a takeover landing mid-dispatch publishes nothing. `runSubmitPlan` additionally wires `isRunOwner: () => planExecutionClaimHeld(...)` into the executor, so a taken-over run refuses its next node claim and launches no successor tool.
- When a DAG node PARKS on a gated tool (`waiting_confirmation`/`waiting_verification`, its `PendingAction` id readable from `AgentTaskNode.output` via `readPendingActionId`), the relay remembers the node and — after the run settles, so the row is committed — emits the human-decision event decided by the PERSISTED `PendingAction` row (`tier`/`requiresMfa` via `loadPendingSummary`): YELLOW ⇒ `{ type:'confirmation_required', action, actionId }` + a confirmation card; RED (or `requiresMfa`) ⇒ `{ type:'mfa_required', actionId, hint }` + an MFA card.
- `confirmation.ts#resumeOwningPlan` returns the plan snapshot produced by `resumeTaskForAction` (which has already written the executed node's REAL outcome and re-run downstream nodes) and `executeAuthorizedAction` streams it as a `plan_update`, prepended to the returned `events` (no extra `plan` CARD — the plan card stays the single one from `card-emitter`). The relay never invents progress: a failed node is reported `failed`, and a plan hiccup is an `error` event, never an aborted plan/turn.

### Plan-lifecycle & confirmation guarantees (code-grounded)

- **Cancel settles revoke + plan status ATOMICALLY.** `task-control.ts#cancelTask` first runs the
  root-client bulk `revokePendingActionsByTask(taskId, ['pending','awaiting_mfa'])` (the PRIMARY
  guarantee that no executable action survives; also the statement the review spec's spy gates), then in
  ONE `prisma.$transaction` re-runs `revokePendingActionsByTask(taskId, ['pending','awaiting_mfa'], tx)`
  (covering anything parked during phase 1) AND writes the row status inline
  `tx.agentTask.update({ where:{id:taskId}, data:{status:'cancelled'} })`. `updateTaskStatus`/`claimTaskStatus`
  in `lib/db/repositories/task.ts` accept no transaction client, so the status write goes through `tx`
  directly. Because the re-revoke and the `cancelled` status commit together, a newly parked action cannot
  be authorized against a still-non-cancelled plan. The node-`output`-scan `revokeParkedActions` (one
  `gateway.cancelAction` per parked node — the FALLBACK for a pre-link action) and `sweepCancelledPlan`
  are kept ONLY as POST-HOC fallbacks (not the primary guarantee). `revokeParkedActions` reports
  `alreadySettled` for an action that already executed/errored and never pretends to roll it back
  (executed work is irreversible; the planner performs NO automatic compensation). Anything that could
  not be settled — including the bulk-revoke count — is durably recorded via `recordRevokeFailure`.
- **A resume never re-mints an action for a still-gated plan node, and RECOVERS an already-executed one.**
  Every `PendingAction` persists its owning plan+node at creation (`PendingAction.taskId`/`nodeId`). Before
  `confirmation.ts#executeGatedToolOnce` mints a gated action for a plan node,
  `findInFlightPlanAction(taskId, nodeId)` looks for an existing action on that `(taskId, nodeId)` in
  status `pending | awaiting_mfa | confirmed | executed` (`listPendingActionsByTask(taskId, {statuses})` filtered by
  nodeId, oldest-first) and BRANCHES on its status:
  - `pending`/`awaiting_mfa`/`confirmed` — genuinely in-flight (awaiting the human, or the confirm path is
    executing it right now). The node is treated as STILL PARKED: no `gateway.handleToolCall` and no new
    `PendingAction` — the SAME parked outcome
    (`{ ok:false, requiresConfirmation:true, pendingActionId:<existing id> }`) is returned, so the executor
    keeps it in `waiting_confirmation`/`waiting_verification`.
  - `executed` — the gated side effect ALREADY ran and was ledgered, but the owning `AgentTaskNode`'s real
    outcome was never persisted (the confirm path records `executed` BEFORE `resumeOwningPlan` writes the
    node result, and that persist can fail). The node is RECOVERED, not parked, by
    `recoverExecutedPlanAction`. It BACKFILLS the node result from the DURABLE execution
    result persisted on the action (`PendingAction.resultJson`, decoded by `readStoredResult`) — GENERIC
    over the `{ ok, data, summary, error }` payload for EVERY recoverable write tool (`set_card_limit`,
    `cancel_subscription`, `freeze_card`, `apply_virtual_card`, `set_subscription_reminder`,
    `create_scheduled_task`, `transfer_money`, `subscribe_investment`, `redeem_investment`,
    `report_lost_card`, `unfreeze_card`, `change_password`, …) — and does NOT re-invoke the tool, so a
    non-idempotent side effect (e.g. `set_card_limit`) is never re-applied after the user independently
    changed that value. When NO `resultJson` was stored (a legacy row executed before the agent layer
    persisted results) the tool is STILL never re-invoked: the node is settled TERMINALLY as `failed` for
    MANUAL review, so a wedged plan settles instead of looping and a non-idempotent side effect can never
    be re-applied. A `confirmed` row whose terminal status write never landed is finalized by
    `decideConvergence`: verified receipt/ledger ⇒ `executed`; stored result ⇒ its actual outcome;
    missing/conflicting plan evidence ⇒ action `needs_reconciliation`, node stopped for manual review.
    Receipt-only recovery never re-executes. Standalone recovery that may create a NEW debit calls
    `security.recovery.authorizeRecoveryAction` (same action, no new action), then checks the breaker
    again inside the SDK fence. Current cumulative risk can require MFA. Persistence failures propagate
    so recovery can be retried. Manual review returns `ok:false`, not successful execution.
  This closes the window where a node's side effect has run but its result is not yet persisted (the gateway's own
  `findReusableAction` only matches `pending`/`awaiting_mfa`, so it would otherwise MISS the `confirmed`/`executed`
  row) so a resume there cannot double-apply. The in-process single-flight (`inFlightExecutions` /
  `nodeExecutionKey`) remains an OPTIMIZATION only, never the correctness guarantee; the persisted DB row
  is the authority.
- **A committed side effect whose result+status transaction ROLLED BACK (a "wedge") CONVERGES FROM PERSISTED EVIDENCE via `decideConvergence` — never re-run, never a fabricated `failed`/rollback.**
  When the SDK side effect COMMITS but the result+status `$transaction` in `agent/confirmation.ts#executeAuthorizedAction`
  ROLLS BACK (or the process dies before writing it), the action is left `confirmed` with `resultJson=null`. On any
  later recovery/confirm/verify/`recoverAction`, `agent/execution-convergence.ts#decideConvergence` decides the terminal
  state from EVIDENCE, in priority order: (1) `pending`/`awaiting_mfa` ⇒ keep, evidence `live`; (2) a committed
  `ExecutionReceipt` (`getExecutionReceipt(userId, ledgerKeyForAction(...))`) ⇒ `executed`, REUSING the stored result
  (the owning plan node converges to `success` with NO plan restart and NO successor nodes); (3) `isActionLive(id)` (or a
  standalone action with an active LEASE) ⇒ keep `confirmed`, evidence `live`; (4) a stored `resultJson` with a boolean
  `ok` ⇒ `ok?'executed':'failed'`; (5) NO evidence + PLAN-LINKED ⇒ `failed` with `PLAN_LINKED_UNRECONCILED_ERROR`
  (`人工核对`), so the plan settles instead of wedging at `waiting_confirmation`; (6) NO evidence + STANDALONE ⇒ defer to
  `recoverStandaloneWedge` (→ `needs_reconciliation`). It NEVER infers failure from a missing `resultJson`, a lost
  marker, or a caught exception; the tool is NEVER re-invoked and NO rollback is fabricated: executed work is
  irreversible. The in-process REFERENCE-COUNTED `liveConfirmations` registry (`agent/confirmation-recovery.ts`;
  `retainAction`/`releaseAction`/`isActionLive`/`liveCount`) IS the `live` evidence — `confirmAction`/`verifyAction`
  register the id BEFORE authorizing via `withLiveConfirmation` and release it in a `finally`; it COUNTS (not a `Set`),
  so a rejected DUPLICATE confirm cannot clear a still-running original's marker. A `live` row keeps `confirmed` with NO
  write, so an in-flight continuation's outcome is never evicted. For a plan-linked action with a committed receipt the
  owning node converges to `success` (plan consistently); when the plan is already `cancelled` the posted action's real
  status MAY be corrected but the plan is NOT resumed.
- **A STANDALONE (non-plan) wedge settles on a REPEAT confirm/verify — replayed only when PROVEN idempotent.**
  `agent/confirmation.ts#conflictOutcome` calls `recoverStandaloneWedge(actionId, { selfHoldsLiveMarker: true })`
  as its FIRST statement: a standalone gated action left `confirmed` with NO persisted result (its side effect
  committed but the result+status transaction rolled back, or the process died) settles on a REPEAT
  confirm/verify. `transfer_money` — the ONLY standalone write tool with a PROVEN-idempotent SDK write (the ledger
  PK dedups the same key) — is IDEMPOTENTLY REPLAYED, persisting its TRUE result and terminal status atomically;
  any OTHER standalone write tool transitions to the explicit, queryable terminal `needs_reconciliation` state
  (never a fabricated failure, rollback or blind re-run), surfaced by `GET /api/actions` + a UI
  manual-reconciliation card. `recoverStandaloneWedge` returns `undefined` (defer) when the row is not a
  `confirmed` wedge, when its result IS stored, when ANOTHER live continuation in this process owns it (the
  caller's own live marker is subtracted via `selfHoldsLiveMarker`), or when the row is PLAN-LINKED (left to the
  executor's `executeGatedToolOnce` path).
- **No pre-park plan-status check exists** — neither `securityGateway.handleToolCall` nor `executor.runPlan`'s `runToolNode` consults the plan status before parking. Prevention of a post-cancel executable action relies on the post-run CANCEL SWEEP: `sweepCancelledPlan(sessionId, taskId)` (run after every run path — `runSubmitPlan`, `resumeTask`, `retryTask`, `resumeTaskForAction`) re-reads the row and, when `cancelled`, revokes every still-parked action; an UNEXPECTED revoke failure is recorded durably as a `SecurityEvent` (`recordRevokeFailure`, kind `HIGH_RISK_BLOCKED`) and the summary is still returned, so a control API response never becomes a 5xx that hides the already-persisted `cancelled` state. A live run is interrupted mid-flight only via `defaultPollControls` (`'cancelled'` ⇒ `{kind:'cancel'}`) polled at each node checkpoint.
- **Confirm-vs-cancel is at-most-once via the gateway CAS, NOT "cancel always wins".**
  `confirmation.ts#confirmAction`/`verifyAction`/`cancelAction` first call `cancelledPlanOutcome` (reads
  the owning `AgentTask` via `findTaskByPendingAction` + `getTask`; if `'cancelled'` ⇒ `ok:false` BEFORE
  authorizing — the belt), then `gateway.authorizeAction`, whose `claimPendingAction` from
  `['pending']`/`['awaiting_mfa']` claims 0 rows on an already-revoked/executed action and throws
  `CONFLICT` — surfaced as a real `ok:false` (`conflictOutcome`). Confirm and cancel race through the
  SAME CAS (`pendingAction.ts#claimPendingAction`), so exactly one wins; a confirm that wins the race
  executes, and the concurrent cancel's revoke then reports it settled.
- **Concurrent resume/retry is exactly-once per effect.** `claimTaskStatus`
  (`lib/db/repositories/task.ts`) is a single `updateMany` CAS (`status IN fromStatuses` → `toStatus`;
  `count===1`). `resumeTask`'s from-set KEEPS `'running'`, whereas `retryTask`'s EXCLUDES `'running'`
  (the loser claims 0 rows ⇒ returns the persisted plan WITHOUT running). The EXACTLY-ONCE guarantee is
  NOT the status CAS but the PLAN-level DB execution claim (`claimTaskExecution` on
  `AgentTask.executionToken`): `resumeTask`/`retryTask` acquire a `newId('taskclaim')` token BEFORE
  `executor.runPlan` and release it in a `finally`, so a second concurrent caller that loses the claim
  returns the persisted plan WITHOUT starting a second executor. Each NODE additionally claims its own
  slot (`buildNodeClaimPorts` → `claimNodeOwnedByPlan`/`claimNodeExecution` / `releaseNodeExecution`),
  wired for EVERY executor pass — `buildPlanDeps` (resume/retry/confirm-continuation) AND the initial
  `runSubmitPlan` — claimed BEFORE the node's write and released even for a parked node. The IN-PROCESS single-flight
  (`confirmation.ts#executeGatedTool`) is keyed by the NODE identity (`nodeExecutionKey(taskId, nodeId)`
  when both are present) — NEVER by `sessionId`+tool+args alone, so two INDEPENDENT plans with identical
  tool+args run independently; a STANDALONE call (no plan node) is executed directly. The DB
  (`PendingAction` status CAS + `nodeExecutionKey` SDK idempotency) is the at-most-once authority.
- **A crashed executor's orphaned execution claim is reclaimable via a TTL stale horizon.**
  `claimTaskExecution`/`claimNodeExecution` stamp `executionClaimedAt` from the REAL wall clock and their owner releases the token in a `finally`; a CRASH before that `finally` would wedge the plan `'running'`. So EVERY `task-control.ts` claim passes `{ staleBefore: staleExecutionClaimBefore() }` (= `Date.now() - EXECUTION_CLAIM_TTL_MS`, TTL 10 min) — the CAS may also match a row older than that horizon (owner plausibly died). Two racing takeovers still yield ONE winner (the winner re-stamps `executionClaimedAt`, so the loser matches 0 rows); a running executor renews its lease at node boundaries and is not preempted WHILE it renews, but this is a TTL HEURISTIC, not a liveness proof — a LONG-BLOCKED owner can still be taken over, and the WRITE FENCES (not the TTL) make it lose; an old owner's `release*` is a token-guarded no-op. The horizon uses the REAL clock (`Date.now()`), NEVER the demo clock (`demoNow()` = 2026-09-25). A WON takeover calls `clearStaleNodeClaims(taskId, wonToken)` to CLEAR the previous owner's NON-TERMINAL node claims (they carry a fresh, non-stale token that would otherwise refuse every claim and wedge the plan at `running`); `runSubmitPlan` calls it too (no-op on a fresh plan), so EVERY `claimTaskExecution` winner runs the identical reclaim step, and the fence on the won token keeps "exactly one takeover winner".
- **A run's plan/node writes are FENCED on its execution claim, renewed ONLY at node boundaries.** Every run path threads its PLAN claim token into `buildPlanDeps` → `createTaskPersistence(planId, { planToken, nodeToken })`, and `buildPlanDeps#claimNode` records each WON node token (read by `persistNode`). A claim-holding write goes through the token-fenced repository primitives — a SINGLE atomic statement carrying the token in its `where`, never a read-then-write (`updateTaskNode(..., { fenceToken })` → `null`; `claimTaskStatus(..., { fenceToken })` → `false` when lost) — so a ZOMBIE executor whose claim was taken over SKIPS the write (and its narration) instead of clobbering the takeover's result, marking a completed dependent `skipped`, or advancing downstream (a claimless control `pause`/`cancel` writes UNFENCED). The claim stays fresh via `renewTaskExecutionClaim(taskId, token)` (a token-conditioned `updateMany` re-stamping `executionClaimedAt`) at NODE BOUNDARIES ONLY — never a background timer, never while blocked inside a tool call — so a long run keeps its slot while a run STUCK inside a tool call ages out and becomes takeover-able (the takeover those fences guard). EVERY executor node outcome flows through this port (`running`/`success`/`failed`/`parked`/`cancelled`, dependency-`skipped`, `condition`/`note`); a node write with no node token falls back to the PLAN-token fence.
- **SDK business writes share the trusted transaction fence.** `createToolRegistry.executeDirect` scopes server callbacks with `withBankingExecution`; every actual SDK mutation enters `runInTransaction`. `buildPlanNodeFence` uses plan/node token + generation CASes as first writes. `buildConfirmFence` checks the confirmed action and owning plan not cancelled using conditional writes. This covers transfers, cards, subscriptions, investments, budgets and scheduled tasks, including runners that do not forward options. Normal confirm/MFA and recovery share verified receipt/legacy-ledger evidence; unknown outcomes are explicit reconciliation states.
- **PLAN-ownership is verified in the SAME statement as a node CLAIM and as an executor node WRITE, and a node claim REFUSES a TERMINAL node.** `buildNodeClaimPorts` builds the planner `claimNode`/`releaseNode` ports plus the per-node token map shared with `createTaskPersistence`'s `nodeToken` resolver; under a PLAN claim, `claimNode` takes the ATOMIC `claimNodeOwnedByPlan` CAS (INSTEAD of node-token-only `claimNodeExecution`) — ONE `prisma.agentTaskNode.updateMany` whose `where` requires `task:{executionToken:planToken}` AND `status:{notIn:TERMINAL_NODE_STATUSES}` (`['success','failed','skipped','cancelled']`), so a superseded ("zombie") executor can never (re)claim a node, run a successor tool, or re-claim a completed node (the node-token staleness horizon is preserved). These ports are wired for EVERY executor pass — `buildPlanDeps` (resumeTask/retryTask/resumeTaskForAction) AND `runSubmitPlan`'s initial run — so an initial executor that LOSES its plan claim fails its next node claim and launches no successor tool (no TOCTOU window). `createTaskPersistence.persistNode` executor writes also carry `task:{executionToken:planToken}` and refuse a TERMINAL-clobber (applied ONLY when the NEW status is terminal, so the current owner's legitimate reopen — `retryPlan` writing `pending` — still passes). So a plan-claim-loser cannot re-claim/overwrite a completed node, run a successor tool, publish stale progress (the sink is gated on `planExecutionClaimHeld`), or return a misleading result.
- **A `resumeTaskForAction` that LOSES the plan claim still records the human decision — through an atomic ownership CAS, never an unfenced write.** It mints a FRESH PLAN token via `claimTaskExecution(located.taskId, newId('taskclaim'), { staleBefore: staleExecutionClaimBefore() })`. WON ⇒ it drives the plan as an executor with `buildPlanDeps(..., { mode:'executor', planToken })` (fenced), releasing the claim in a `finally`. LOST ⇒ a LIVE executor owns the plan, so this continuation must NOT advance it (an overlapping walk could launch a node twice) and must NOT clobber the owner's rows: it records its ONE decided node via the atomic ownership CAS `recordDecidedNodeFenced` (node-claim token ⇒ LIVE plan-claim token ⇒ no-owner CAS `task:{executionToken:null}`; a lost race matches 0 rows ⇒ SKIP), then runs `sweepCancelledPlan` and reloads the persisted plan (nothing claimed ⇒ nothing released). Pause retention (`PAUSE_NOW_CONTROLS`, also passed on the WON path when the row is `'paused'`; belt (a) is `lifecycle.resumePlan`'s `stillPaused` early return), the cancelled-plan no-op and the post-run cancel sweep are preserved.
- **Pause retains.** When `resumeTaskForAction` sees the owning plan `'paused'`, it records the decided
  node and does NOT advance. TWO belts hold it: (a) `lifecycle.resumePlan` returns early with
  `status:'paused'` whenever `explicitResume !== true` (`stillPaused`) — and `resumeTaskForAction`
  passes NO `explicitResume` — and (b) `resumeTaskForAction` passes `PAUSE_NOW_CONTROLS` (always
  `{kind:'pause'}`) into `runPlan`. The plan stays `'paused'` until an explicit `resumeTask`.
- **Terminal states are never resurrected.** Every control CAS from-set excludes `'cancelled'`
  (`PAUSABLE_PLAN_STATUSES`/`RESUMABLE_PLAN_STATUSES`/`RETRYABLE_PLAN_STATUSES` in `task-control.ts`); a
  lost claim returns `reloadPlan(...)` — the PERSISTED row — so the API response always matches the DB.
  `createTaskPersistence.persistPlan` writes `'cancelled'` unconditionally but every other checkpoint via
  `claimTaskStatus(NON_CANCELLED_PLAN_STATUSES)`, so a concurrent cancel wins. `resumeTaskForAction`
  no-ops on a `'cancelled'` plan (returns the persisted plan); `cancelTask` is idempotent on an
  already-`'cancelled'` row.

## Constraints (hard, encode in every file)

- Automatic writes compose `buildAutomaticWriteFence(sessionId, taskId?, nodeId?)` with the plan/node
  claim where present. Standalone Pi `AgentTool.execute` is also scoped by trusted SDK context; checking
  only `beforeToolCall` cannot stop a breaker tripped during an in-flight call.

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
- **Provider transcript validity (DeepSeek / OpenAI-compatible)**: every persisted `role:'toolResult'`
  message MUST answer the assistant `toolCall` of the run it belongs to (matching `toolCallId`) — no
  orphan, no duplicate, no fabricated id. `resumeTurn` REPLACES the turn-time (blocked) placeholder
  IN PLACE via `withRealToolResult` (never appends a second result after the model's narration), and
  `banking-agent` normalizes `AgentState.messages` on restore via `normalizeToolResultMessages`, so the
  invariant holds across the first turn, multi-turn persistence, confirm/MFA continuation and a
  refresh/resume. This keeps DeepSeek's rule "a `tool` message must respond to a preceding `tool_calls`".
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
  constructors directly (it receives `{ model, streamFn }` from `resolveProvider`).
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
- `../lib/db/repositories` → `sessions.*`, `pendingActions.*` (`getPendingAction`, `getPendingActionOwnership`, `claimPendingAction` — the exactly-once CAS; `getPendingActionPlanLink`, `revokePendingActionsByTask`, `listPendingActionsByTask` — the latter selects EVERY column, so a loaded row carries `PendingAction.resultJson`), `tasks.*` (`createTask`, `createTaskNode`, `getTask`, `listTasksBySession`, `updateTaskStatus`, and the token-fenced `claimTaskStatus` / `updateTaskNode`, each accepting an optional `{ fenceToken }` — a write whose claim was lost returns `false`/`null` and is SKIPPED; `claimTaskExecution`/`releaseTaskExecution`/`claimNodeExecution`/`releaseNodeExecution` — the plan/node DB execution claims; `AgentTaskWithNodes`).

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

## Pi SDK Reconciliation (verified against installed 1.1.0)

Implement against `node_modules/@earendil-works/*` (stubs / `./tools/CONTEXT.md` diverge):
- `AgentTool<TParameters extends TSchema, TDetails = any>` — generic is a **TypeBox TSchema**, NOT `Static<>`; a heterogeneous registry uses `AgentTool<any>` (`AgentTool<unknown>` does NOT compile). `execute(toolCallId, params: Static<TParameters>, signal?, onUpdate?): Promise<AgentToolResult<TDetails>>` with `AgentToolResult<T> = { content: (TextContent|ImageContent)[]; details: T; terminate? }`.
- `Model<TApi extends Api>` requires a type argument (this node uses `Model<any>`); mock uses `fauxProvider()` plus `createModels().setProvider(handle.provider)`.
- `AgentOptions.streamFn` is required. Production receives `Models.streamSimple.bind(models)` with `builtinModels()` for live and a per-runtime collection for mock. `normalizeContext()` is required when calling a stream function directly outside Agent.
- Tool-call arguments and tool-result details must be JSON values; boundary adapters serialize DTOs before passing them to Pi.
- `AgentOptions.beforeToolCall?: (ctx: BeforeToolCallContext, signal?) => Promise<BeforeToolCallResult|undefined>` with `ctx.toolCall` (`.name`/`.arguments`) and `ctx.args: unknown`; return `{ block: true, reason }`.

## Known Issues

- **Cross-action transfer serialization depends on SQLite's DB-level single-writer lock, and the gateway's confirm-time re-risk transaction does not include the SDK execution.** `security/security-gateway.ts#authorizeTransfer` re-risks in ONE `prisma.$transaction` that CAS-claims the action FIRST and only THEN reads the in-flight-inclusive effective total (`computeEffectiveTransferTotalWith`) and re-runs `evaluateTransferRisk` (escalating to MFA when the day's total would exceed the limit), so concurrent confirms of DISTINCT parked transfers serialize only through SQLite's single-writer lock - with no explicit isolation level or `SELECT ... FOR UPDATE`; and a crash between that commit and `agent/confirmation.ts#executeAuthorizedAction` (which runs the transfer, then persists `resultJson` and `recordActionResult`) leaves a `confirmed`-but-unledgered action counted as in-flight (over-conservative, never under-counting).
- **`liveConfirmations` is PER-PROCESS.** A `confirmed` + `resultJson=null` row whose live continuation runs in a DIFFERENT process/instance is not distinguished from a genuine wedge (the registry is a per-process, ref-counted liveness hint, not a durable marker); multi-instance deploy is not covered.
- **Execution takeover is a TTL HEURISTIC.** `EXECUTION_CLAIM_TTL_MS = 600_000ms` is computed from the REAL clock: a single tool call legitimately blocked beyond the TTL can be overtaken (its writes are fenced, so it can never clobber the takeover, but it is preempted), so preemption is a heuristic, never a liveness proof.
- **File-size budget exceeded.** `agent/task-control.ts` (1212 lines) and `agent/confirmation.ts` (1105 lines) exceed the ~1000-line soft guideline and remain extraction candidates (two extractions already landed: `agent/execution-convergence.ts`, `agent/execution-fence.ts`).

## Notes for Agents

- Pi SDK type/function names (`Agent`, `AgentTool`, `AgentState`, `AgentEvent`, `fauxProvider`,
  `Type`, `Static`) are relied on per the verified 1.1.0 facts in root `../CONTEXT.md`; confirm exact
  exported identifiers against the installed packages (see the Pi SDK Reconciliation section above).
- `system-prompt.ts` may list ONLY the tools actually present in `ToolRegistry` — no phantom capabilities.
- `ConfirmationOutcome.requiresMfa` is the EFFECTIVE MFA requirement and `tier` is the EFFECTIVE tier (RED whenever `requiresMfa`). `app/api/actions/[id]/confirm|verify/route.ts` should surface `outcome.requiresMfa`; the current `outcome.tier === 'RED'` derivation still agrees because the tier is effective. Owner of `./app` — escalate route edits to the parent.
- The human-decision stream events are emitted from two distinct sites (same names, different payloads): `confirmation_required` ONLY from `run-turn.ts` (turn-time, via `handleToolExecutionEnd` for a directly-blocked gated tool, or `emitParkedDecision` for a parked DAG node) and NEVER from `confirmation.ts`; `mfa_required` from `run-turn.ts` (with `hint: MFA_HINT` + an MFA card) AND from `confirmation.ts#blockedOutcome` (with ONLY `{ actionId }` — no `hint`, no card) when a confirm/verify authorization still requires verification (wrong code ⇒ `awaiting_mfa`, or `locked`).
- Every card emitted to the UI must originate from a real tool result (or a real security decision) —
  never from model prose. `card-emitter.toCards` is PURE and total (unknown shape ⇒ `error` card).
- `submit_plan` is meta (not risk-gated): it validates the DAG, then runs it via `planner.runPlan` with
  `runTool = executeGatedTool`; individual money-moving nodes still gate through the gateway.
- **Plan-node actions are BORN plan-linked.** Every REAL `runTool` adapter forwards the executor's
  `ctx {taskId,nodeId}` (the gated path in `planner/executor.ts` invokes `runTool(tool, args, {taskId, nodeId})`)
  into `executeGatedTool` → `gateway.handleToolCall` → `gatewayCreatePendingAction`, which persists
  `PendingAction.taskId`/`nodeId` IN THE SAME INSERT as the row — BEFORE the `runTool` promise resolves.
  So `cancelTask`'s PRIMARY bulk `revokePendingActionsByTask(taskId,[...])` revokes a parked node action
  EVEN BEFORE the node's `output.pendingActionId` is written. Production callers that must forward `ctx`:
  `banking-agent.ts` (submit_plan deps), `index.ts#taskRunToolFor` (resume/retry),
  `confirmation.ts#resumeOwningPlan`. A `runTool` injection that DROPS `ctx` mints an UNLINKED orphan
  that the bulk revoke AND `findTaskByPendingAction` both miss — the action stays confirmable after a
  plan cancel.

## Test Strategy

Vitest (`tests/`, read-only sibling); designed to run WITHOUT network:
- Pure units: `card-emitter.toCards` (one case per tool family + unknown ⇒ error) and `system-prompt.buildSystemPrompt` (asserts the hallucination/`success:false` rules + only registered tool names).
- `session`/`banking-agent` against the test SQLite — `AgentState` round-trips through `serialize`/`load`.
- Full-pipeline scenarios (the 12 demo Tests) run `runTurn` + `confirmAction`/`verifyAction` with `LLM_MODE=mock` (faux scripts) — proving gating, MFA, injection refusal and the hallucination guard.
- The offline mock model (`providers/`) is the default `LLM_MODE=mock` runtime and drives the REAL pipeline (runTurn → `createBankingAgent` → mock → tools → gateway → SDK → DB) end-to-end offline, incl. `POST /api/chat` E2E: a GREEN read, a parked YELLOW/RED transfer, a `submit_plan` DAG, and honest `INSUFFICIENT_FUNDS` failure narration. A conditional plan that also asks to adjust a card spend limit parks its YELLOW `set_card_limit` node, so the plan-level `confirmation_required` frame is reachable through the mock model (see `./providers/CONTEXT.md`).
- Agent unit specs live under `tests/unit/agent/` (`confirmation*.test.ts`, `task-control.test.ts`, `task-cancel-revokes.test.ts`, `run-turn-failure.test.ts`, `providers/*.test.ts`); auto-discovered by the ROOT `vitest.config.ts`, run via `npm run test`.

## Routing Table

- `./agent/banking-agent.ts` → constructs the Pi `Agent`, wires tools + `beforeToolCall`/`afterToolCall`, provider, restored `AgentState`
- `./agent/system-prompt.ts` → banking system prompt builder + hallucination/permission rules
- `./agent/session.ts` → per-session `AgentState` + transcript load/create/persist
- `./agent/message-normalize.ts` → provider transcript validity: `normalizeToolResultMessages` (keep only a `toolResult` that answers the assistant `toolCall` run it follows — heals orphans/duplicates on restore) + `withRealToolResult` (replace the turn-time blocked placeholder IN PLACE, drop the trailing narration)
- `./agent/run-turn.ts` → one chat turn: prompt, event→stream mapping, persistence; `resumeTurn` places the REAL result IN PLACE of the turn-time blocked placeholder for its original `toolCallId` (see `message-normalize`) and drops the trailing narration, so the transcript stays valid for OpenAI-compatible providers
- `./agent/confirmation.ts` → two-phase continuation: confirm/verify/cancel + gateway-authorized execution path (result + terminal status + recovery audit settled in ONE `$transaction`) + executed-node recovery + committed-side-effect wedge finalization (ref-counted `liveConfirmations` in `confirmation-recovery.ts`); the exported `recoverAction(actionId, opts?)` (`agent/index.ts` → `POST /api/actions/[id]/recover`) drives the same settlement path explicitly; `cancelAction` maps a gateway `CONFLICT` (a terminal / already-executed / in-flight row) to a stable `ok:false` carrying the CURRENT persisted status (HTTP 200, via `conflictOutcome`), exactly like confirm/verify — no rollback, no terminal mutation
- `./agent/confirmation-recovery.ts` → ref-counted per-process live-confirmation registry (`retainAction`/`releaseAction`/`isActionLive`/`liveCount`) + unified settlement classifier `classifyConfirmedAction(row, nowMs)` → `settled|processing|recoverable|needs_reconciliation` + `settlePendingAction`/`settleFromCommittedReceipt` + persisted execution LEASE (`EXECUTION_LEASE_TTL_MS = 120000`; `setPendingActionLease`/`clearPendingActionLease`/`hasActiveLease`/`leaseNowMs`; taken ONLY for `pending`/`awaiting_mfa`) + standalone (non-plan) wedge recovery (`recoverStandaloneWedge`: receipt-first idempotent replay for every `RECOVERABLE_STANDALONE_TOOLS` member — currently `transfer_money` only — else the terminal queryable `needs_reconciliation` state)
- `./agent/execution-convergence.ts` → shared normal-confirmation and recovery decision: verified committed evidence, completion/transaction observation, liveness, stored result, then manual reconciliation. Unknown action outcome is `needs_reconciliation`, not an inferred failure.
- `./agent/execution-fence.ts` → conditional first writes on the SDK transaction client: plan/node identity or confirmed action + owning plan not cancelled; no permission policy is decided by SDK.
- `./agent/card-emitter.ts` → pure `toCards(toolName, result): ChatCard[]` mapping + card helpers
- `./agent/task-control.ts` → node-output JSON shape + token-fenced DAG plan persistence/load mapping + PLAN-ownership-aware node claim/write/reclaim (`claimNodeOwnedByPlan`, `planExecutionClaimHeld`, `buildNodeClaimPorts`, `clearStaleNodeClaims`) + pause/resume/cancel/retry/getTaskPlan glue (ownership-checked; EXECUTOR vs CONTROL write mode — see `task-fencing.ts`)
- `./agent/task-fencing.ts` → FENCED plan/node write primitives: `toNodeUpdate`/`jsonNodeOutput`/`isMissingNodeError`, `settlePlanFromNodes`, `recordDecidedNodeFenced` (single-statement ownership CASes used by a lost-claim confirm-continuation)
- `./agent/index.ts` → node facade (runtime surface: create/run/resume/confirm/verify/cancel/toCards + DAG control glue `pauseTask`/`resumeTask`/`cancelTask`/`retryTask`/`getTaskPlan`)
- `./agent/tools` → registered banking tools: one module per family + `createToolRegistry` (child node)
- `./agent/providers` → LLM provider selection: live + faux/mock + selector (child node)
- `../tests` → agent unit + faux-LLM scenario integration tests (sibling — read-only, escalate writes to root)
- `../lib/contracts` → frozen cross-module types this node imports (sibling — read-only)
- `../security` `../planner` `../banking-sdk` `../audit` → sibling nodes this node orchestrates (read-only)

- `./agent/execution-evidence.ts` → request/receipt/ledger evidence reader shared by normal confirmation and recovery
- `./agent/execution-audit.ts` → trusted transfer commit callback; required audit joins the debit transaction

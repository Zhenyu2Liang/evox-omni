# planner — DAG Task Planner

## Intent

The deterministic DAG engine backing the agent's `submit_plan` meta-tool. The LLM proposes a
plan (a DAG of `TaskNodeSpec` nodes); the planner **validates** it, computes execution order,
**executes** nodes in topological order, **evaluates** conditional branches, and emits per-node
status updates — the 规划 (plan) + 执行 (execute) stages of the agent loop. On top of that walk,
`lifecycle.ts` provides the **durable** control surface — pause / resume / retry / cancel — so an
out-of-process (HTTP) request can steer and resume a plan across requests.

The planner is **pure DAG logic**: it owns no banking, security, or DB behavior. Every side
effect — tool execution, persistence, the clock, cross-request controls — is injected through
`PlanDeps` / `RunPlanOptions`.

## API Surface

`dag.ts` — pure graph operations (no I/O):
- `validatePlan(nodes: TaskNodeSpec[], knownTools: Set<string>): Result<void>` — rejects duplicate
  ids, unknown tools, malformed nodes, missing deps and cycles (`AppError('VALIDATION')`).
- `topologicalOrder(nodes: TaskNodeSpec[]): TaskNodeSpec[]` — deterministic order (stable by
  declaration order); throws on cycles.
- `getReadyNodes(nodes: TaskNodeSpec[], results: TaskNodeResult[]): TaskNodeSpec[]` — nodes not yet
  resolved (`pending`/absent) whose every dependency is `success` or `skipped`; a `failed`/`cancelled`
  — or still-in-flight — dependency leaves it unready. Pure helper, no I/O.
- `transitiveDependents(nodes: TaskNodeSpec[], id: string): string[]` — BFS over the dependency graph;
  every node reachable through a dependent edge, in declaration order. Shared by the executor
  (skip propagation / cooperative retry) and the lifecycle helpers.
- `evaluateCondition(condition: TaskCondition, scope: Record<string, unknown>): boolean` — dot-path
  lookup in `scope` + `op` comparison; missing path → `false`; pure and total.
- `buildPlan(input: BuildPlanInput): TaskPlan` — assembles the initial snapshot
  (`status:'pending'`, empty `results`); `now`/`id` injectable for determinism.
- `BuildPlanInput` — `{ sessionId; goal; nodes; now?; id? }`.

`executor.ts` — execution engine:
- `PlanToolOutcome` — `{ ok; data?; summary?; error?; requiresConfirmation?; pendingActionId? }`.
- `PlanDeps` — ports (see below); `PlanControls` — `{ pause(); resume(); cancel(); retry(nodeId) }`.
- `RunPlanOptions` — `{ signal?; now?; onControls? }`.
- `isTerminalStatus(status: TaskNodeStatus | undefined): boolean` — terminal set is
  `success | failed | skipped | cancelled`.
- `persistPlanSnapshot(deps, plan)` — writes a snapshot through `persistPlan ?? persist`.
- `runPlan(plan: TaskPlan, deps: PlanDeps, opts?: RunPlanOptions): Promise<TaskPlan>` — walks the
  plan in topological order and returns the settled snapshot.

`lifecycle.ts` — durable entry points (all return a fresh `TaskPlan` snapshot):
- `pausePlan(plan, opts?: PausePlanOptions): TaskPlan` — synchronous; returns a resumable snapshot with
  `status:'paused'` (a NON-terminal, resumable status): already-run nodes keep their recorded
  result, un-run nodes surface as `pending`.
- `cancelPlan(plan, deps?, opts?: CancelPlanOptions): Promise<TaskPlan>` — halts the plan: terminal
  nodes keep their status, every remaining non-terminal node becomes `cancelled` with
  `output: PlanCancellation = { cancelled: true, reason, executedNodes }`, plan settles `cancelled`.
- `compensationReport(plan, cancelledAt?): CompensationReport` — pure; classifies every node into
  `executed` (`success`) / `skipped` / `cancelledNodes`, plus `{ planId, cancelledAt }`.
- `retryPlan(plan, deps, opts?: RetryPlanOptions): Promise<TaskPlan>` — resets the targets
  (`opts.nodeIds` or every `failed` node) **and their not-yet-satisfied transitive dependents**
  (`pending`/`failed`/`skipped`/absent) to `pending`, then re-runs through `runPlan`. Returns the
  plan UNCHANGED when there is nothing resettable.
- `resumePlan(plan, resume: ResumeInput, deps, opts?: RunPlanOptions): Promise<TaskPlan>` — applies a
  human decision to a gated node and continues via `runPlan`. Throws `AppError('NOT_FOUND')` for an
  unknown `nodeId`.
- Types: `PlanCancellation`, `PausePlanOptions`, `CancelPlanOptions`, `RetryPlanOptions`,
  `ResumeInput = { nodeId; outcome: PlanToolOutcome }`, `CompensationReport`.

`index.ts` — barrel facade re-exporting the `dag`, `executor` and `lifecycle` namespaces plus the
public functions/types (`buildPlan`, `transitiveDependents`, `isTerminalStatus`,
`persistPlanSnapshot`, `pausePlan`, `cancelPlan`, `retryPlan`, `resumePlan`, `compensationReport`).

## PlanDeps contract (agent ↔ planner boundary)

- `runTool(toolName, args)` — supplied by the **agent layer** and MUST route through the Security
  Gateway's `execute` path. Returns a `PlanToolOutcome`:
  - success → `{ ok:true, data, summary }` → node `success`;
  - failure → `{ ok:false, error }` → node `failed` (recorded, never thrown);
  - **gated** → `{ ok:false, requiresConfirmation:true, pendingActionId }` → the node does NOT
    execute; it parks in `waiting_confirmation` (plan → `waiting_confirmation`) and the
    `pendingActionId` is recorded on the node result. A **RED** node (spec `riskLevel:'RED'`) parks
    in `waiting_verification` instead. The plan resumes via `lifecycle.resumePlan`.
- `onNodeUpdate(node)` — called on every status change; the agent forwards it to the client as the
  `plan_update` `AgentStreamEvent` (and the `plan` `ChatCard` carries the whole `TaskPlan`).
- `persistNode?(planId, node)` — incremental snapshot write of ONE node change.
- `persistPlan?(plan)` / `persist?(plan)` — full-snapshot write, called ONCE when the walk starts (`status:'running'`) and ONCE at settlement — deliberately NOT per node (see the clobber guard below; the deprecated
  `persist` is an alias, used when `persistPlan` is absent).
- `loadPlan?(planId)` — load a persisted snapshot (used by the agent layer to resume a plan after a
  process restart / page refresh; the planner itself never calls it).
- `controls?: PlanControlPort` — `pollControls(planId)` (READ-AND-CLEAR) returns
  `PlanControlCommand[]` = `{kind:'pause'} | {kind:'cancel'} | {kind:'retry'; nodeId}`, polled at
  each node checkpoint so a separate HTTP request can steer the run.

## Durable control & resume

`runPlan` is a single in-process walk, but every checkpoint consults `deps.controls` and writes
through the persistence ports, so state survives the request:

- **runPlan reads NO persisted state during a run** — it consults only the in-memory `plan` argument, its own flags, and `deps.controls.pollControls`. It never calls `deps.loadPlan` mid-walk. So a "pause" applied by writing node statuses (the `pausePlan` snapshot shape) does NOT stop a live run; only `PlanControls.pause()` / a durable `{kind:'pause'}` command does.
- **Clobber guard (plan-status write cadence)** — `runPlan` writes the FULL plan snapshot (`persistPlan`) only TWICE: once up front (`status:'running'`) and once at settlement; per-node mutations persist just the node row (`persistNode`). This keeps an out-of-process durable control intact — a `POST /pause` that sets the persisted plan status to `'paused'` (or `POST /cancel` → `'cancelled'`) is NOT overwritten by a stale mid-run `'running'` snapshot, so the next `checkpoint()`'s `deps.controls.pollControls` observes it and the walk stops instead of wrongly starting the next node.
- **Pause** — an in-process `PlanControls.pause()` or a durable `{kind:'pause'}` STOPS the walk and
  RETURNS immediately: `status:'paused'`, un-run nodes still `pending`, already-run nodes
  `success`. Resumption = re-invoking `runPlan` (or `resumePlan`) on the returned snapshot;
  `PlanControls.resume()` only clears the in-process pause flag.
- **Cancel** — `PlanControls.cancel()` / `{kind:'cancel'}` / `opts.signal` abort the walk: `runPlan`
  stops at the next node checkpoint, cancels the in-flight node, then **sweeps the topological order
  and marks EVERY remaining non-terminal node `cancelled`** (nothing dangles as `pending`) before
  settling the plan `cancelled`. A gated *park* is NOT a cancellation — the dependents of a
  `waiting_confirmation`/`waiting_verification` node stay `pending`. Re-invoking `runPlan` on a
  `cancelled` plan is a no-op (idempotency). The pure-halt `cancelPlan` applies the same sweep and
  records the executed / irreversible set (`PlanCancellation.executedNodes`) on each cancelled node,
  so it is durable via node persistence.
- **Retry** — `PlanControls.retry(nodeId)` / `{kind:'retry', nodeId}` / `retryPlan` reset the target
  and its transitive dependents to `pending` and rewind the walk; a node that already `success` is
  NEVER reset or re-invoked.
- **Resume** — `resumePlan` applies the human `PlanToolOutcome` to the gated node (success / re-park /
  failed) and continues the walk, which skips every already-successful node and runs only the
  now-unblocked dependents.

## Compensation policy (non-atomic — no automatic rollback)

The plan's side effects are NOT transactional. The rollback policy is explicit and conservative:

- Already-executed nodes (status `success`) are **NEVER compensated or rolled back automatically** —
  the simulated backend treats executed work as irreversible.
- The planner is pure DAG logic and owns NO banking/domain semantics, so it cannot know a tool's
  inverse action; **automatic compensation is intentionally deferred to the caller/agent layer**,
  which alone knows the compensating tool for a given node.
- On cancel, every node that did not execute is marked `cancelled` (or was already `skipped`), and
  `compensationReport(plan, cancelledAt?)` returns the executed / skipped / cancelled partition plus
  `{ planId, cancelledAt }` — the surface for **manual takeover**.

## Status transitions

`pending → running → { success | failed | waiting_confirmation | waiting_verification | cancelled }`;
a node whose dependency did not succeed (`skipped`, `failed` or `cancelled`) transitively becomes
`skipped`, as do the dependents of a `false` condition. Plan-level status mirrors the
set: `pending | running | paused | waiting_confirmation | success | failed | cancelled`. A paused plan is
reported as `paused` — a NON-terminal, resumable status (cancel/park remain terminal/blocking).

## Constraints

- Pure DAG logic. Imports only `lib/contracts/task` + `lib/errors` + `lib/clock` — never
  banking-sdk / security / agent / audit / prisma.
- Inject all side effects via `PlanDeps`; inject `now` via `RunPlanOptions.now` /
  `BuildPlanInput.now` so agent + planner tests run offline and deterministically (`LLM_MODE=mock`).
- A validated plan is a precondition of `runPlan` — the caller (`submit_plan`) runs `validatePlan`
  first; `runPlan` does not re-validate.
- NEVER throw on a single node failure: record `failed` and continue independent branches.
- Idempotency: a node already terminal (`success`/`failed`/`skipped`/`cancelled`) is never
  re-executed; a `cancelled` plan never re-runs.
- Keep files ≲1000 lines; split by responsibility.

## Rendering note (UI)

The UI shows **task steps, tool status and results only — NEVER LLM chain-of-thought**. The plan
rendered to the user is the `TaskPlan` snapshot delivered via the `plan_update` stream event /
`plan` chat card (`components/` chat panel).

## Routing Table

- `./planner/dag.ts` → pure graph ops: validate / order / readiness / condition eval / transitive
  dependents / buildPlan
- `./planner/executor.ts` → execution engine: `runPlan`, `PlanDeps` (+ `PlanControlPort`),
  `PlanControls`, `PlanToolOutcome`
- `./planner/lifecycle.ts` → durable entry points: `pausePlan` / `cancelPlan` + `compensationReport`
  / `retryPlan` / `resumePlan`
- `./planner/index.ts` → facade barrel (`dag`, `executor`, `lifecycle`, `buildPlan`)
- `../lib/contracts/task.ts` → FROZEN plan/node types (sibling — read-only, escalate writes to root)
- `../lib/db/repositories/task.ts` → AgentTask/AgentTaskNode persistence used by `deps.persist`
  (sibling — read-only, escalate writes to `./lib`)
- `../tests/unit/planner/` → planner unit specs (sibling — read-only, escalate writes to `./tests`):
  `dag.test.ts`, `executor.test.ts`, `lifecycle.test.ts`. This node has NO local test file and NO
  scoped vitest config — the specs live in that sibling tree (run `npx vitest run tests/unit/planner`).

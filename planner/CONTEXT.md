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
- `NodeExecutionContext` — `{ taskId; nodeId }` — the identity of the node a tool call belongs to,
  threaded to `runTool` as its 3rd argument.
- `PlanDeps` — ports (see below); `PlanControls` — `{ pause(); resume(); cancel(); retry(nodeId) }`.
- `RunPlanOptions` — `{ signal?; now?; onControls?; explicitResume? }`. `explicitResume` (default
  `false`) is the ONLY way to re-drive a `'paused'` plan through `runPlan` directly (a bare
  `runPlan(paused, deps)` returns the snapshot unchanged); it also tells the guarded persist that a
  human lifted the pause.
- `GuardedPersistOptions` — `{ explicitResume? }` (parameter of `persistPlanSnapshotGuarded`).
- `isTerminalStatus(status: TaskNodeStatus | undefined): boolean` — terminal set is
  `success | failed | skipped | cancelled`.
- `persistPlanSnapshot(deps, plan)` — writes a snapshot through `persistPlan ?? persist`
  unconditionally (the deprecated `persist` is an alias, used when `persistPlan` is absent).
- `persistPlanSnapshotGuarded(deps, plan, opts?)` — like `persistPlanSnapshot` but, when
  `deps.loadPlan` is supplied, first reads the durable snapshot and SKIPS the write if the durable
  status is **pinned** and differs from the snapshot's status: `'cancelled'`/`'success'` are always
  pinned; `'paused'` is pinned unless `opts.explicitResume` (the concurrent control wins). Without
  `deps.loadPlan` it behaves exactly like `persistPlanSnapshot`. This is the planner-side guard that
  avoids *initiating* a status downgrade; the atomic compare-and-set for a concurrent pause/cancel
  belongs to the caller's `persistPlan` port (out of this node — see the CAS boundary below).
- `runPlan(plan, deps, opts?): Promise<TaskPlan>` — walks the plan in topological order and returns
  the settled snapshot. A NON-RUNNABLE plan is returned UNCHANGED (no node runs, nothing is
  persisted): `'cancelled'` (terminal), `'success'` (terminal), and `'paused'` unless
  `opts.explicitResume === true`.

`lifecycle.ts` — durable entry points (all return a fresh `TaskPlan` snapshot):
- `pausePlan(plan, opts?): TaskPlan` — synchronous. A `'cancelled'` plan is TERMINAL and is returned
  UNCHANGED (a control call never moves it to a non-terminal state). Otherwise returns a resumable
  snapshot with `status:'paused'` (a NON-terminal, resumable status): already-run nodes keep their
  recorded result, un-run nodes surface as `pending`.
- `cancelPlan(plan, deps?, opts?): Promise<TaskPlan>` — a `'cancelled'` plan is returned UNCHANGED
  (no writes). Otherwise halts the plan: terminal nodes keep their status, every remaining
  non-terminal node becomes `cancelled` with `output: PlanCancellation = { cancelled: true, reason,
  executedNodes }`, plan settles `cancelled`.
- `compensationReport(plan, cancelledAt?): CompensationReport` — pure; classifies every node into
  `executed` (`success`) / `skipped` / `cancelledNodes`, plus `{ planId, cancelledAt }`.
- `retryPlan(plan, deps, opts?: RetryPlanOptions): Promise<TaskPlan>` — a `'cancelled'` plan is
  returned UNCHANGED (no resets, `runPlan` never entered). Otherwise resets the targets
  (`opts.nodeIds` or every `failed` node) **and their not-yet-satisfied transitive dependents**
  (`pending`/`failed`/`skipped`/absent) to `pending`, then re-runs through `runPlan`
  (forwarding `opts.explicitResume`). Returns the plan UNCHANGED when there is nothing resettable.
- `resumePlan(plan, resume, deps, opts?: RunPlanOptions): Promise<TaskPlan>` — applies a human
  decision to a gated node and continues via `runPlan`. Throws `AppError('NOT_FOUND')` for an
  unknown `nodeId`. When the plan is `'paused'` and `opts.explicitResume !== true` it is HONORED:
  the decision is still applied to the gated node (`success`/`failed`/re-park) and persisted, but
  the plan KEEPS `status:'paused'` and `runPlan` is NOT called (no dependent advances); the
  `'paused'` snapshot is returned. Otherwise (explicit resume, or a non-paused plan) it sets the
  specific running/waiting/failed status and continues via `runPlan`. Positional signature
  `resumePlan(plan, resume, deps, opts?)` is stable.
- Types: `PlanCancellation`, `PausePlanOptions`, `CancelPlanOptions`, `RetryPlanOptions`,
  `ResumeInput = { nodeId; outcome: PlanToolOutcome }`, `CompensationReport`.

`index.ts` — barrel facade re-exporting the `dag`, `executor` and `lifecycle` namespaces plus the
public functions/types (`buildPlan`, `transitiveDependents`, `isTerminalStatus`,
`persistPlanSnapshot`, `persistPlanSnapshotGuarded`, `pausePlan`, `cancelPlan`, `retryPlan`,
`resumePlan`, `compensationReport`, `GuardedPersistOptions`, `NodeExecutionContext`).

## PlanDeps contract (agent ↔ planner boundary)

- `runTool(toolName, args, ctx)` — supplied by the **agent layer** and MUST route through the Security
  Gateway's `execute` path. `ctx: NodeExecutionContext = { taskId, nodeId }` is the node this call
  belongs to (the agent passes `nodeExecutionKey(taskId, nodeId)` as its idempotency key). Returns a
  `PlanToolOutcome`:
  - success → `{ ok:true, data, summary }` → node `success`;
  - failure → `{ ok:false, error }` → node `failed` (recorded, never thrown);
  - **gated** → `{ ok:false, requiresConfirmation:true, pendingActionId }` → the node does NOT
    execute; it parks in `waiting_confirmation` (plan → `waiting_confirmation`) and the
    `pendingActionId` is recorded on the node result. A **RED** node (spec `riskLevel:'RED'`) parks
    in `waiting_verification` instead. The plan resumes via `lifecycle.resumePlan`.
- `claimNode?(taskId, nodeId, token)` / `releaseNode?(taskId, nodeId, token)` — OPTIONAL DB-atomic
  per-node execution claim, supplied TOGETHER (the agent delegates to `claimNodeExecution` /
  `releaseNodeExecution`). `runPlan` mints ONE claim token per invocation and claims a `kind:'tool'`
  node BEFORE any write for it (condition/note nodes never claim). A lost claim ⇒ ZERO writes for
  that node, the walk halts (dependents do not run, no cancel sweep), the node stays not-yet-settled
  and the plan stays `running` (the final guarded snapshot write is skipped) — the owning executor
  remains the single writer. The claim is ALWAYS released in `finally` (after success, park or
  failure) so a later retry/resume/confirm re-drives the node. When `claimNode` is absent the
  executor behaves exactly as without claiming; `status:'running'` is never used as the claim.
- `isRunOwner?()` — OPTIONAL ownership re-check, consulted AFTER each async node notification resolves and
  BEFORE the next notification is published / the node's tool is launched. It answers `true` while this run
  still owns the PLAN's execution claim (the agent wires it as `planExecutionClaimHeld(plan.id, claimToken)`).
  A lost claim returns the SAME `'owned'` back-off as a lost node claim: ZERO further writes for the node, NO
  tool call, no plan-snapshot persist, node left not-yet-settled and plan `running`. It is consulted at these
  boundaries of `runToolNode`/the walk: right after the node claim + `running` notification, and after EVERY
  settlement notification (before the walk advances to a successor). So a run whose plan claim was taken over
  launches no successor tool and publishes no stale progress. Absent (a claim-less walk) ⇒ a genuine no-op.
- `onNodeUpdate(node)` — called on every status change; the agent forwards it to the client as the
  `plan_update` `AgentStreamEvent` (and the `plan` `ChatCard` carries the whole `TaskPlan`).
- `persistNode?(planId, node)` — incremental snapshot write of ONE node change.
- `persistPlan?(plan)` / `persist?(plan)` — full-snapshot write, called ONCE when the walk starts
  (`status:'running'`) and ONCE at settlement — deliberately NOT per node (see the clobber guard
  below; the deprecated `persist` is an alias, used when `persistPlan` is absent). The write goes
  through `persistPlanSnapshotGuarded`.
- `loadPlan?(planId)` — load a persisted snapshot. Used by the agent layer to resume a plan after a
  process restart / page refresh (the planner itself never calls it for node selection), AND by
  `persistPlanSnapshotGuarded` to avoid overwriting a pinned durable status. When absent, the
  guarded write degrades to an unconditional `persistPlanSnapshot`.
- `controls?: PlanControlPort` — `pollControls(planId)` (READ-AND-CLEAR) returns
  `PlanControlCommand[]` = `{kind:'pause'} | {kind:'cancel'} | {kind:'retry'; nodeId}`, polled at
  each node checkpoint so a separate HTTP request can steer the run.

## Durable control & resume

`runPlan` is a single in-process walk, but every checkpoint consults `deps.controls` and writes
through the persistence ports, so state survives the request:

- **Non-runnable plans (no-op early returns)** — `runPlan` returns the input snapshot UNCHANGED
  (fresh copy, no node runs, nothing persisted) when the plan is `'cancelled'` (terminal,
  idempotent), `'success'` (terminal), or `'paused'` without `opts.explicitResume === true`. A bare
  `runPlan(paused, deps)` therefore never advances a paused plan — lifting the pause requires
  `explicitResume` (or `lifecycle.resumePlan`).
- **runPlan reads NO persisted state for node selection during a run** — it consults only the
  in-memory `plan` argument, its own flags, and `deps.controls.pollControls`. It never calls
  `deps.loadPlan` to decide which node to run. So a "pause" applied by writing node statuses (the
  `pausePlan` snapshot shape) does NOT stop a live run; only `PlanControls.pause()` / a durable
  `{kind:'pause'}` command does. (The one `loadPlan` call is inside the guarded full-snapshot write;
  it guards the WRITE, never node selection.)
- **Clobber guard (plan-status write cadence)** — `runPlan` writes the FULL plan snapshot
  (`persistPlanSnapshotGuarded`) only TWICE: once up front (`status:'running'`) and once at
  settlement; per-node mutations persist just the node row (`persistNode`). This keeps an
  out-of-process durable control intact — a `POST /pause` that sets the persisted plan status to
  `'paused'` (or `POST /cancel` → `'cancelled'`) is NOT overwritten by a stale mid-run `'running'`
  snapshot, so the next `checkpoint()`'s `deps.controls.pollControls` observes it and the walk stops
  instead of wrongly starting the next node. `setNode` NEVER writes the plan/AgentTask status. The
  guarded write additionally refuses to overwrite a durable status that a concurrent control pinned
  (`'cancelled'`/`'success'`, or `'paused'` unless `explicitResume`).
- **CAS boundary (caller-owned)** — the planner-side guard only avoids *initiating* an invalid
  status downgrade. The ATOMIC compare-and-set for a concurrent pause/cancel is owned by the
  caller's `persistPlan` port (the `./agent` layer's `createTaskPersistence` → a guarded
  `claimTaskStatus` transition). `./planner` does not do the CAS itself.
- **Per-node checkpoint ordering** (`runPlan` main loop, `executor.ts`) — each loop iteration, in
  order: (1) `await checkpoint()` → `pollDurableControls()` → `deps.controls.pollControls(plan.id)`;
  (2) guards `stopRequested()` / `paused` break / retry rewind; (3) select `node = order[index]`;
  (4) for a `kind:'tool'` node, `await runToolNode(node)` which first CLAIMS the node (`deps.claimNode`, before any write; a
  lost claim returns `'owned'` and halts the walk) then does `setNode('running')`, re-checks `isRunOwner` AFTER that async notification resolves and before the tool launch, then
  `await deps.runTool(...)` → `setNode(success|failed|parked)`. `setNode` records the result, then
  `onNodeUpdate`, then `persistNode` — it NEVER calls `persistPlan`. Consequence: a control persisted
  DURING node 'a' is not touched by 'a's completion writes (`persistNode` writes only the node row
  via `updateTaskNode`, never `AgentTask.status`) and is observed by the NEXT iteration's
  `checkpoint()` BEFORE node 'b' is selected, so 'b' never runs.
- **Pause** — an in-process `PlanControls.pause()` or a durable `{kind:'pause'}` STOPS the walk and
  RETURNS immediately: `status:'paused'`, un-run nodes still `pending`, already-run nodes `success`.
  Resumption = re-invoking `runPlan` with `explicitResume:true` (or `resumePlan`) on the returned
  snapshot; a bare `runPlan(paused, …)` is a no-op (see non-runnable plans above).
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
  now-unblocked dependents. On a `'paused'` plan without `explicitResume` the decision is recorded
  but the plan stays `'paused'` and nothing advances. If the gated node is the plan's LAST node,
  resume makes NO forward progress beyond deciding it: `resumePlan` resolves that node and `runPlan`
  then finds every node terminal (no tool re-runs), while a re-park returns WITHOUT entering `runPlan`.
  So a resume only demonstrates "remaining nodes ran" when at least one node FOLLOWS the gated node
  (or pending nodes remain after a pause).
- **Cancelled is terminal for the controls** — `pausePlan` / `cancelPlan` / `retryPlan` return a
  `'cancelled'` plan UNCHANGED (no writes, no resets, `runPlan` never entered), so no control call
  can move it back to a non-terminal state. `'success'`/`'failed'` are NOT guarded this way:
  retrying a `'failed'` plan and cancelling a `'success'` plan both still work.
- **Parked is NOT terminal (gotcha)** — the terminal set `TERMINAL = {success, failed, skipped,
  cancelled}` EXCLUDES `waiting_confirmation`/`waiting_verification`, so the walk's skip guard
  `if (existing && TERMINAL.has(existing.status)) { index += 1; continue; }` does NOT skip a parked
  node. Invoking `runPlan` DIRECTLY on a snapshot whose gated node is still parked would re-attempt
  it (call `deps.runTool` again). Always resume a gated plan through `resumePlan`, which resolves the
  node's status first (success / failed / re-park); a re-park returns BEFORE calling `runPlan`.

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
`runPlan` is a no-op on a `'cancelled'`/`'success'`/`'paused'`-without-`explicitResume` snapshot.

## Constraints

- Pure DAG logic. Imports only `lib/contracts/task` + `lib/errors` + `lib/clock` + `lib/ids`
  (`newId` for the per-run claim token) — never
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
  `PlanControls`, `PlanToolOutcome`, `RunPlanOptions.explicitResume`, `persistPlanSnapshotGuarded`
  (+ `GuardedPersistOptions`)
- `./planner/lifecycle.ts` → durable entry points: `pausePlan` / `cancelPlan` + `compensationReport`
  / `retryPlan` / `resumePlan`
- `./planner/index.ts` → facade barrel (`dag`, `executor`, `lifecycle`, `buildPlan`)
- `../lib/contracts/task.ts` → FROZEN plan/node types (sibling — read-only, escalate writes to root)
- `../lib/db/repositories/task.ts` → AgentTask/AgentTaskNode persistence used by `deps.persist`
  (sibling — read-only, escalate writes to `./lib`)
- `../tests/unit/planner/` → planner unit specs (sibling — read-only, escalate writes to `./tests`):
  `dag.test.ts`, `executor.test.ts`, `executor-claim-scope.test.ts`, `lifecycle.test.ts`. This node has NO local test file and NO
  scoped vitest config — the specs live in that sibling tree (run `npx vitest run tests/unit/planner`).

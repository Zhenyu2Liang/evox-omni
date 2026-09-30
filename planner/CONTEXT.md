# planner — DAG Task Planner

## Intent

The deterministic DAG engine backing the agent's `submit_plan` meta-tool. The LLM proposes a
plan (a DAG of `TaskNodeSpec` nodes); the planner **validates** it, computes execution order,
**executes** nodes in topological order, **evaluates** conditional branches, and emits per-node
status updates — the 规划 (plan) + 执行 (execute) stages of the agent loop.

The planner is **pure DAG logic**: it owns no banking, security, or DB behavior. Every side
effect — tool execution, persistence, the clock — is injected through `PlanDeps` / `RunPlanOptions`.

## API Surface

`dag.ts` — pure graph operations (no I/O):
- `validatePlan(nodes: TaskNodeSpec[], knownTools: Set<string>): Result<void>` — rejects duplicate
  ids, unknown tools, malformed nodes, missing deps and cycles (`AppError('VALIDATION')`).
- `topologicalOrder(nodes: TaskNodeSpec[]): TaskNodeSpec[]` — deterministic order (stable by
  declaration order); throws on cycles.
- `getReadyNodes(nodes: TaskNodeSpec[], results: TaskNodeResult[]): TaskNodeSpec[]` — unresolved
  nodes whose every dependency has reached a terminal state.
- `evaluateCondition(condition: TaskCondition, scope: Record<string, unknown>): boolean` — dot-path
  lookup in `scope` + `op` comparison; missing path → `false`; pure and total.
- `buildPlan(input: BuildPlanInput): TaskPlan` — assembles the initial snapshot
  (`status:'pending'`, empty `results`); `now`/`id` injectable for determinism.
- `BuildPlanInput` — `{ sessionId; goal; nodes; now?; id? }`.

`executor.ts` — execution engine:
- `PlanToolOutcome` — `{ ok; data?; summary?; error?; requiresConfirmation?; pendingActionId? }`.
- `PlanDeps` — `{ runTool; onNodeUpdate; persist? }` (see below).
- `PlanControls` — `{ pause(); resume(); cancel(); retry(nodeId) }`.
- `RunPlanOptions` — `{ signal?; now?; onControls? }`.
- `runPlan(plan: TaskPlan, deps: PlanDeps, opts?: RunPlanOptions): Promise<TaskPlan>` — walks the
  plan in topological order and returns the settled snapshot.

`index.ts` — barrel facade re-exporting the `dag` and `executor` namespaces plus `buildPlan` and
the public types.

## PlanDeps contract (agent ↔ planner boundary)

- `runTool(toolName, args)` — supplied by the **agent layer** and MUST route through the Security
  Gateway's `execute` path. Returns a `PlanToolOutcome`:
  - success → `{ ok:true, data, summary }` → node `success`;
  - failure → `{ ok:false, error }` → node `failed` (recorded, never thrown);
  - **gated** → `{ ok:false, requiresConfirmation:true, pendingActionId }` → the node does NOT
    execute; it parks in `waiting_confirmation` (plan → `waiting_confirmation`). After the human
    decision the agent resumes via `PlanControls.resume()` / `retry(nodeId)`, re-invoking `runTool`.
  - A **RED** tool awaiting MFA surfaces the same signal and parks the node in `waiting_verification`.
- `onNodeUpdate(node)` — called on every status change; the agent forwards it to the client as the
  `plan_update` `AgentStreamEvent` (and the `plan` `ChatCard` carries the whole `TaskPlan`).
- `persist?(plan)` — optional snapshot write through `lib/db/repositories` (AgentTask/AgentTaskNode).
  Omitted in unit tests, which keep the plan in memory.

## Status transitions

`pending → running → { success | failed | waiting_confirmation | waiting_verification | cancelled }`;
nodes skipped by a `false` condition transitively become `skipped`. Plan-level status mirrors the
set: `pending | running | waiting_confirmation | success | failed | cancelled`.

## Constraints

- Pure DAG logic. Imports only `lib/contracts/task` + `lib/errors` — never banking-sdk / security /
  agent / audit / prisma.
- Inject all side effects via `PlanDeps`; inject `now` via `RunPlanOptions.now` / `BuildPlanInput.now`
  so agent + planner tests run offline and deterministically (`LLM_MODE=mock`).
- A validated plan is a precondition of `runPlan` — the caller (`submit_plan`) runs `validatePlan`
  first; `runPlan` does not re-validate.
- NEVER throw on a single node failure: record `failed` and continue independent branches.
- Keep files ≲1000 lines; split by responsibility.

## Rendering note (UI)

The UI shows **task steps, tool status and results only — NEVER LLM chain-of-thought**. The plan
rendered to the user is the `TaskPlan` snapshot delivered via the `plan_update` stream event /
`plan` chat card (`components/` chat panel).

## Routing Table

- `./planner/dag.ts` → pure graph ops: validate / order / readiness / condition eval / buildPlan
- `./planner/executor.ts` → execution engine: `runPlan`, `PlanDeps`, `PlanControls`
- `./planner/index.ts` → facade barrel (`dag`, `executor`, `buildPlan`)
- `../lib/contracts/task.ts` → FROZEN plan/node types (sibling — read-only, escalate writes to root)
- `../lib/db/repositories/task.ts` → AgentTask/AgentTaskNode persistence used by `deps.persist`
  (sibling — read-only, escalate writes to `./lib`)

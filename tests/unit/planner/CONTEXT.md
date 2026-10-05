# tests/unit/planner — DAG & executor unit specs

## Intent

Prove the DAG task planner's correctness independent of banking/LLM concerns: graph validation
(duplicate ids, unknown tools, malformed nodes, bad deps, cycles), deterministic topological order,
readiness computation, condition evaluation against a result scope, and the executor's node-state
machine (including gated nodes parked in `waiting_confirmation` and skipped branches), plus the
durable lifecycle controls over a persisted plan.

## API Surface

Implemented specs (real assertions, no `it.todo`), targeting `@/planner` (`dag` / `executor` / `lifecycle`):

- `dag.test.ts` (22 specs) — `validatePlan(nodes, knownTools)`, `topologicalOrder(nodes)`,
  `getReadyNodes(nodes, results)`, `evaluateCondition(condition, scope)`, `buildPlan(input)`.
  Pure; `now`/`id` injectable for determinism.
- `executor.test.ts` (14 specs) — `runPlan(plan, deps, opts?)` with injected `PlanDeps`
  (`runTool`/`onNodeUpdate`/`persist`); gated `runTool` outcome → node `waiting_confirmation`;
  false condition → dependents `skipped`; node failure → `failed` (executor never throws);
  `PlanControls` (pause/resume/cancel/retry); abort signal → `cancelled`.
- `lifecycle.test.ts` — `planner/lifecycle.ts` durable controls (`pausePlan`/`cancelPlan`/`retryPlan`/
  `resumePlan`) over a persisted plan: pause halts progression and yields a resumable `status:'paused'`
  plan snapshot, cancel sweeps EVERY remaining
  non-terminal node to `cancelled` (incl. a durable `{ kind:'cancel' }` polled after the first node of a
  3-node `[a, b(dep a), c(dep b)]` chain settles → `a=success`, `b=c=cancelled`, `b`/`c` never invoked),
  retry re-runs only the failed node, resume continues.
- `executor-claim-scope.test.ts` (3 specs, DB-backed) — the NODE-execution de-dup SCOPE keyed by the
  stable `(taskId,nodeId)` identity (NOT an in-process single-flight Map). Part A drives the CAS
  (`claimNodeExecution`/`releaseNodeExecution` in `@/lib/db/repositories/task`) directly: exactly-once
  claim, non-owner release no-op, owner release clears, cross-task independence. Part B runs two
  SEPARATE `runPlan` invocations with SEPARATE `PlanDeps` over the same identity: while a still-live
  run holds the claim the second run backs off with ZERO node side effects and no settlement write
  (`persistPlan` only ever carries `status:'running'`); after release exactly one run executes the
  node (stable `runTool` ctx → same `nodeExecutionKey`).

## Constraints

- Side effects (tool calls, persistence, clock) are **injected** — most specs need no DB and no LLM;
  `executor-claim-scope.test.ts` IS DB-backed (real `AgentTask`/`AgentTaskNode` rows for the CAS, via
  `useFreshDatabase()` → `../../helpers/db`).
- Deterministic order/timestamps: assert stable ordering by declaration order among equally-ready nodes.
- `evaluateCondition` is total: a missing dot-path resolves to `false`.
- `getReadyNodes` unlocks a dependent ONLY for terminal `success`/`skipped` deps
  (`READY_DEP_STATUSES`); a `failed`/`cancelled` dep does NOT unlock its dependent.
- Import frozen types from `@/lib/contracts/task`; never redeclare `TaskNodeSpec`/`TaskNodeResult`/`TaskPlan`.

## Notes for Agents

- Run: `npx vitest run tests/unit/planner --no-file-parallelism` (`dag`/`executor`/`lifecycle` are pure;
  `executor-claim-scope.test.ts` requires the test SQLite).
- All planner specs are green (no known-red cases).

## Routing Table

- `./dag.test.ts` → graph validation / ordering / conditions / buildPlan
- `./executor.test.ts` → runPlan state machine + plan controls
- `./lifecycle.test.ts` → durable persisted-plan lifecycle (pause/cancel/retry/resume)
- `./executor-claim-scope.test.ts` → DB `(taskId,nodeId)` node-execution claim CAS + cross-run de-dup scope

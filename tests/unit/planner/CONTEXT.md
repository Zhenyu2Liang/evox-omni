# tests/unit/planner — DAG & executor unit specs

## Intent

Prove the DAG task planner's correctness independent of banking/LLM concerns: graph validation
(duplicate ids, unknown tools, malformed nodes, bad deps, cycles), deterministic topological order,
readiness computation, condition evaluation against a result scope, and the executor's node-state
machine (including gated nodes parked in `waiting_confirmation` and skipped branches).

## API Surface

Spec files (all `it.todo` scaffolds today), targeting `@/planner` (`dag` / `executor`):

- `dag.test.ts` — `validatePlan(nodes, knownTools)`, `topologicalOrder(nodes)`, `getReadyNodes(nodes, results)`,
  `evaluateCondition(condition, scope)`, `buildPlan(input)`. Pure; `now`/`id` injectable for determinism.
- `executor.test.ts` — `runPlan(plan, deps, opts?)` with injected `PlanDeps` (`runTool`/`onNodeUpdate`/`persist`);
  gated `runTool` outcome → node `waiting_confirmation`; false condition → dependents `skipped`; node failure →
  `failed` (executor never throws); `PlanControls` (pause/resume/cancel/retry); abort signal → `cancelled`.

## Constraints

- All side effects (tool calls, persistence, clock) are **injected** — these specs need no DB and no LLM.
- Deterministic order/timestamps: assert stable ordering by declaration order among equally-ready nodes.
- `evaluateCondition` is total: a missing dot-path resolves to `false`.
- Import frozen types from `@/lib/contracts/task`; never redeclare `TaskNodeSpec`/`TaskNodeResult`/`TaskPlan`.

## Routing Table

- `./dag.test.ts` → graph validation / ordering / conditions / buildPlan
- `./executor.test.ts` → runPlan state machine + plan controls

# tests/unit/planner — DAG & executor unit specs

## Intent

Prove the DAG task planner's correctness independent of banking/LLM concerns: graph validation
(duplicate ids, unknown tools, malformed nodes, bad deps, cycles), deterministic topological order,
readiness computation, condition evaluation against a result scope, and the executor's node-state
machine (including gated nodes parked in `waiting_confirmation` and skipped branches).

## API Surface

Implemented specs (real assertions, no `it.todo`), targeting `@/planner` (`dag` / `executor`):

- `dag.test.ts` (22 specs) — `validatePlan(nodes, knownTools)`, `topologicalOrder(nodes)`,
  `getReadyNodes(nodes, results)`, `evaluateCondition(condition, scope)`, `buildPlan(input)`.
  Pure; `now`/`id` injectable for determinism.
- `executor.test.ts` (14 specs) — `runPlan(plan, deps, opts?)` with injected `PlanDeps`
  (`runTool`/`onNodeUpdate`/`persist`); gated `runTool` outcome → node `waiting_confirmation`;
  false condition → dependents `skipped`; node failure → `failed` (executor never throws);
  `PlanControls` (pause/resume/cancel/retry); abort signal → `cancelled`.

## Known Issues

- `dag.test.ts` › `getReadyNodes` › "excludes a node whose dependency failed" is **red** with
  `AssertionError: expected [ 'b' ] to deeply equal []` (`dag.test.ts:130`).
  A dependency should unlock its dependent only in a terminal **success/skip** state (per the
  original API spec: "terminal success/skip state"), but `planner/dag.ts`'s `TERMINAL_NODE_STATUSES`
  also contains `failed` and `cancelled`, so a `failed` dependency wrongly unlocks its dependent.
  This is a **sibling bug in `planner/dag.ts`** (read-only from here) — the spec is intentionally
  left red rather than weakened; the fix belongs in `planner/` (escalate to root).

## Constraints

- All side effects (tool calls, persistence, clock) are **injected** — these specs need no DB and no LLM.
- Deterministic order/timestamps: assert stable ordering by declaration order among equally-ready nodes.
- `evaluateCondition` is total: a missing dot-path resolves to `false`.
- Import frozen types from `@/lib/contracts/task`; never redeclare `TaskNodeSpec`/`TaskNodeResult`/`TaskPlan`.

## Notes for Agents

- Run: `npx vitest run tests/unit/planner --no-file-parallelism` (pure — no DB required).
- `dag.test.ts` + `executor.test.ts` currently totals 36 specs: 35 pass, 1 known-red (see Known Issues).

## Routing Table

- `./dag.test.ts` → graph validation / ordering / conditions / buildPlan
- `./executor.test.ts` → runPlan state machine + plan controls

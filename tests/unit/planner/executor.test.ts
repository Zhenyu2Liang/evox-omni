/**
 * Unit: planner/executor — deterministic plan execution over injected ports.
 *
 * Targets `@/planner/executor`: runPlan(plan, deps, opts?) (+ types PlanDeps{runTool,onNodeUpdate,persist},
 * PlanControls, RunPlanOptions, PlanToolOutcome).
 *
 * All side effects are INJECTED (runTool / onNodeUpdate / persist / now / signal) → NO DB, no network.
 */
import { describe, it } from 'vitest';

// import { runPlan } from '@/planner/executor';   // <- uncomment in Phase 2
// import type { PlanDeps, PlanControls } from '@/planner/executor';

describe('planner/executor · ordering + happy path', () => {
  it.todo('executes nodes in topological order (a dependency resolves before its dependent)');
  it.todo('a kind:tool node whose runTool returns { ok:true, data } → node success carrying the data/summary');
  it.todo('deterministic timestamps: startedAt/finishedAt derive from the injected now()');
});

describe('planner/executor · gated tool (confirmation)', () => {
  it.todo('runTool returns { ok:false, requiresConfirmation:true, pendingActionId } → node parked waiting_confirmation (NOT executed)');
  it.todo("a parked node's dependents are NOT executed (they remain pending)");
  it.todo('the pendingActionId is recorded on the node result for later resumption');
});

describe('planner/executor · conditions + failure isolation', () => {
  it.todo('a condition node evaluating false → its transitive dependents become skipped (not failed)');
  it.todo('a failing node (runTool ok:false) → failed, but runPlan NEVER throws');
  it.todo('execution continues along independent branches after a failure');
});

describe('planner/executor · observability + persistence', () => {
  it.todo('deps.onNodeUpdate is emitted on every node status change');
  it.todo('deps.persist is called after each mutation when provided (and omitted safely when not)');
});

describe('planner/executor · controls + abort', () => {
  it.todo('onControls is invoked once with a PlanControls object (pause/resume/cancel/retry)');
  it.todo("aborting the injected signal marks the running node 'cancelled' and settles the plan");
  it.todo('the returned TaskPlan is the final snapshot with updated statuses');
});

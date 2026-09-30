/**
 * Unit: planner/dag — pure DAG operations for the task planner.
 *
 * Targets `@/planner/dag` (also exported via `@/planner`): validatePlan(nodes, knownTools),
 * topologicalOrder(nodes), getReadyNodes(nodes, results), evaluateCondition(condition, scope),
 * buildPlan(input) (+ type BuildPlanInput).
 *
 * Pure & deterministic (no DB, no network; never imports banking-sdk / security / audit / prisma).
 * `buildPlan` accepts an injectable now()/id so tests stay reproducible.
 */
import { describe, it } from 'vitest';

// import { validatePlan, topologicalOrder, getReadyNodes, evaluateCondition, buildPlan } from '@/planner/dag';   // <- uncomment in Phase 2

describe('planner/dag · validatePlan', () => {
  it.todo('valid acyclic plan referencing known tools → ok(undefined)');
  it.todo("duplicate node ids → err(AppError 'VALIDATION')");
  it.todo("a kind:'tool' node referencing an unknown tool → err('VALIDATION')");
  it.todo("a malformed kind:'tool' node without a tool → err('VALIDATION')");
  it.todo("a malformed kind:'condition' node without a condition → err('VALIDATION')");
  it.todo("a dependency pointing at a non-existent node id → err('VALIDATION')");
  it.todo("a cycle (A→B→A) → err('VALIDATION')");
});

describe('planner/dag · topologicalOrder', () => {
  it.todo('returns a deterministic order satisfying every dependency (each dep before its dependents)');
  it.todo('among nodes that are simultaneously ready it is stable by declaration order');
  it.todo("throws AppError('VALIDATION') on a cyclic graph");
});

describe('planner/dag · getReadyNodes', () => {
  it.todo('returns only pending/absent nodes whose every dependency reached success/skip');
  it.todo('excludes nodes whose dependency is still pending/running');
  it.todo('excludes a node whose dependency failed');
  it.todo('a plan with no dependencies → all nodes are ready');
});

describe('planner/dag · evaluateCondition', () => {
  it.todo('resolves a dot-path (e.g. analyze_entertainment.total) against scope');
  it.todo('ops >, >=, <, <=, ==, != compare numeric / string / boolean values');
  it.todo('a missing path resolves to false');
  it.todo('a type mismatch is handled safely → false (never throws)');
});

describe('planner/dag · buildPlan', () => {
  it.todo("status 'pending', empty results[], goal/sessionId echoed");
  it.todo('createdAt === updatedAt === now() using the injected now()');
  it.todo('uses the injected id when provided (deterministic)');
  it.todo('does NOT validate — a malformed graph still builds (validatePlan is called separately)');
});

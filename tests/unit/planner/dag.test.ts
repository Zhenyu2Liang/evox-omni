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
import { describe, it, expect } from 'vitest';

import { validatePlan, topologicalOrder, getReadyNodes, evaluateCondition, buildPlan } from '@/planner/dag';
import { AppError, type Result } from '@/lib/errors';
import type { TaskCondition, TaskNodeResult, TaskNodeSpec } from '@/lib/contracts/task';

/** A `kind:'tool'` node with sensible defaults; override any field. */
function toolNode(id: string, over: Partial<TaskNodeSpec> = {}): TaskNodeSpec {
  return { id, name: id.toUpperCase(), kind: 'tool', tool: 'get_balance', dependencies: [], ...over };
}

/** A minimal `TaskNodeResult` row for `getReadyNodes`. */
function result(id: string, status: TaskNodeResult['status']): TaskNodeResult {
  return { id, name: id.toUpperCase(), status };
}

/** A `TaskCondition` shorthand. */
function cond(path: string, op: TaskCondition['op'], value: TaskCondition['value']): TaskCondition {
  return { path, op, value };
}

/** Assert a `Result` is an `err` carrying `AppError('VALIDATION')`. */
function expectValidationError(res: Result<unknown>): void {
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error.code).toBe('VALIDATION');
}

describe('planner/dag · validatePlan', () => {
  it('valid acyclic plan referencing known tools → ok(undefined)', () => {
    const nodes = [toolNode('a'), toolNode('b', { dependencies: ['a'] })];
    const res = validatePlan(nodes, new Set(['get_balance']));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeUndefined();
  });

  it("duplicate node ids → err(AppError 'VALIDATION')", () => {
    const res = validatePlan([toolNode('a'), toolNode('a')], new Set(['get_balance']));
    expectValidationError(res);
  });

  it("a kind:'tool' node referencing an unknown tool → err('VALIDATION')", () => {
    const res = validatePlan([toolNode('a', { tool: 'delete_everything' })], new Set(['get_balance']));
    expectValidationError(res);
  });

  it("a malformed kind:'tool' node without a tool → err('VALIDATION')", () => {
    const node: TaskNodeSpec = { id: 'a', name: 'A', kind: 'tool', dependencies: [] };
    const res = validatePlan([node], new Set(['get_balance']));
    expectValidationError(res);
  });

  it("a malformed kind:'condition' node without a condition → err('VALIDATION')", () => {
    const node: TaskNodeSpec = { id: 'a', name: 'A', kind: 'condition', dependencies: [] };
    const res = validatePlan([node], new Set());
    expectValidationError(res);
  });

  it("a dependency pointing at a non-existent node id → err('VALIDATION')", () => {
    const res = validatePlan([toolNode('b', { dependencies: ['ghost'] })], new Set(['get_balance']));
    expectValidationError(res);
  });

  it("a cycle (A→B→A) → err('VALIDATION')", () => {
    const cyclic = [toolNode('a', { dependencies: ['b'] }), toolNode('b', { dependencies: ['a'] })];
    const res = validatePlan(cyclic, new Set(['get_balance']));
    expectValidationError(res);
  });
});

describe('planner/dag · topologicalOrder', () => {
  it('returns a deterministic order satisfying every dependency (each dep before its dependents)', () => {
    // Declared dependents-first to prove ordering is derived, not positional.
    const order = topologicalOrder([
      toolNode('c', { dependencies: ['b'] }),
      toolNode('b', { dependencies: ['a'] }),
      toolNode('a'),
    ]);
    expect(order.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('among nodes that are simultaneously ready it is stable by declaration order', () => {
    const order = topologicalOrder([toolNode('b'), toolNode('a'), toolNode('c')]);
    expect(order.map((n) => n.id)).toEqual(['b', 'a', 'c']);
  });

  it("throws AppError('VALIDATION') on a cyclic graph", () => {
    const cyclic = [toolNode('a', { dependencies: ['b'] }), toolNode('b', { dependencies: ['a'] })];
    let caught: unknown;
    try {
      topologicalOrder(cyclic);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('VALIDATION');
  });
});

describe('planner/dag · getReadyNodes', () => {
  const nodes = [toolNode('a'), toolNode('b', { dependencies: ['a'] })];

  it('returns only pending/absent nodes whose every dependency reached success/skip', () => {
    expect(getReadyNodes(nodes, [result('a', 'success')]).map((n) => n.id)).toEqual(['b']);
    expect(getReadyNodes(nodes, [result('a', 'skipped')]).map((n) => n.id)).toEqual(['b']);
  });

  it('excludes nodes whose dependency is still pending/running', () => {
    // `a` itself is still pending → ready; its dependent `b` is NOT.
    const pending = getReadyNodes(nodes, [result('a', 'pending')]).map((n) => n.id);
    expect(pending).toEqual(['a']);
    expect(pending).not.toContain('b');

    // `a` running → resolved, but not success/skip → nothing is ready.
    expect(getReadyNodes(nodes, [result('a', 'running')]).map((n) => n.id)).toEqual([]);
  });

  it('excludes a node whose dependency failed', () => {
    // A dependency in a terminal FAILURE state must NOT unlock its dependent
    // (readiness requires a terminal success/skip dependency).
    expect(getReadyNodes(nodes, [result('a', 'failed')]).map((n) => n.id)).toEqual([]);
  });

  it('a plan with no dependencies → all nodes are ready', () => {
    const independent = [toolNode('a'), toolNode('b')];
    expect(getReadyNodes(independent, []).map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('planner/dag · evaluateCondition', () => {
  it('resolves a dot-path (e.g. analyze_entertainment.total) against scope', () => {
    const scope = { analyze_entertainment: { total: 300, count: 4 } };
    expect(evaluateCondition(cond('analyze_entertainment.total', '>', 100), scope)).toBe(true);
    expect(evaluateCondition(cond('analyze_entertainment.count', '==', 4), scope)).toBe(true);
  });

  it('ops >, >=, <, <=, ==, != compare numeric / string / boolean values', () => {
    const numeric = { v: 10 };
    expect(evaluateCondition(cond('v', '>', 5), numeric)).toBe(true);
    expect(evaluateCondition(cond('v', '>', 10), numeric)).toBe(false);
    expect(evaluateCondition(cond('v', '>=', 10), numeric)).toBe(true);
    expect(evaluateCondition(cond('v', '<', 15), numeric)).toBe(true);
    expect(evaluateCondition(cond('v', '<', 5), numeric)).toBe(false);
    expect(evaluateCondition(cond('v', '<=', 10), numeric)).toBe(true);
    // numeric-string bridge
    expect(evaluateCondition(cond('v', '>', '5'), numeric)).toBe(true);
    expect(evaluateCondition(cond('s', '>=', 42), { s: '42' })).toBe(true);

    // strings
    const named = { name: 'Alice' };
    expect(evaluateCondition(cond('name', '==', 'Alice'), named)).toBe(true);
    expect(evaluateCondition(cond('name', '==', 'Bob'), named)).toBe(false);
    expect(evaluateCondition(cond('name', '!=', 'Bob'), named)).toBe(true);

    // booleans
    const flags = { active: true };
    expect(evaluateCondition(cond('active', '==', true), flags)).toBe(true);
    expect(evaluateCondition(cond('active', '!=', false), flags)).toBe(true);
  });

  it('a missing path resolves to false', () => {
    expect(evaluateCondition(cond('nope.deep', '>', 0), {})).toBe(false);
    expect(evaluateCondition(cond('a.b.c', '==', 1), { a: { b: {} } })).toBe(false);
  });

  it('a type mismatch is handled safely → false (never throws)', () => {
    // boolean is not numeric for ordering ops
    expect(evaluateCondition(cond('flag', '>', 0), { flag: true })).toBe(false);
    // object/array values are incomparable, never throw
    expect(() => evaluateCondition(cond('obj', '>', 1), { obj: { a: 1 } })).not.toThrow();
    expect(evaluateCondition(cond('obj', '>', 1), { obj: { a: 1 } })).toBe(false);
    // mismatched primitive types for == / != are incomparable → false
    expect(evaluateCondition(cond('flag', '==', 'true'), { flag: true })).toBe(false);
    expect(evaluateCondition(cond('flag', '!=', 'true'), { flag: true })).toBe(false);
  });
});

describe('planner/dag · buildPlan', () => {
  const NOW = 4_242;

  it("status 'pending', empty results[], goal/sessionId echoed", () => {
    const nodes = [toolNode('a')];
    const plan = buildPlan({ sessionId: 'session-1', goal: 'pay the bill', nodes, now: () => NOW });
    expect(plan.status).toBe('pending');
    expect(plan.results).toEqual([]);
    expect(plan.goal).toBe('pay the bill');
    expect(plan.sessionId).toBe('session-1');
    expect(plan.nodes).toBe(nodes);
  });

  it('createdAt === updatedAt === now() using the injected now()', () => {
    const plan = buildPlan({ sessionId: 's', goal: 'g', nodes: [toolNode('a')], now: () => NOW });
    expect(plan.createdAt).toBe(NOW);
    expect(plan.updatedAt).toBe(NOW);
    expect(plan.createdAt).toBe(plan.updatedAt);
  });

  it('uses the injected id when provided (deterministic)', () => {
    const plan = buildPlan({ sessionId: 's', goal: 'g', nodes: [toolNode('a')], id: 'plan_fixed' });
    expect(plan.id).toBe('plan_fixed');
  });

  it('does NOT validate — a malformed graph still builds (validatePlan is called separately)', () => {
    const malformed: TaskNodeSpec = { id: 'a', name: 'A', kind: 'tool', dependencies: ['ghost'] };
    let plan: ReturnType<typeof buildPlan> | undefined;
    expect(() => {
      plan = buildPlan({ sessionId: 's', goal: 'g', nodes: [malformed], now: () => NOW });
    }).not.toThrow();
    expect(plan?.nodes).toHaveLength(1);
    expect(plan?.status).toBe('pending');
  });
});

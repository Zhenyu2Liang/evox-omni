/**
 * Unit: planner/executor — deterministic plan execution over injected ports.
 *
 * Targets `@/planner/executor`: runPlan(plan, deps, opts?) (+ types PlanDeps{runTool,onNodeUpdate,persist},
 * PlanControls, RunPlanOptions, PlanToolOutcome).
 *
 * All side effects are INJECTED (runTool / onNodeUpdate / persist / now / signal) → NO DB, no network.
 */
import { describe, it, expect } from 'vitest';

import { runPlan } from '@/planner/executor';
import type { PlanControls, PlanDeps, PlanToolOutcome } from '@/planner/executor';
import type { TaskNodeResult, TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';

/** Fixed injected clock instant (distinct from the demo clock) for determinism. */
const NOW = 1_234_567;

/** A `kind:'tool'` node with sensible defaults; override any field. */
function toolNode(id: string, over: Partial<TaskNodeSpec> = {}): TaskNodeSpec {
  return { id, name: id.toUpperCase(), kind: 'tool', tool: `tool_${id}`, dependencies: [], ...over };
}

/** A fresh pending `TaskPlan` (executor never mutates its input). */
function makePlan(nodes: TaskNodeSpec[]): TaskPlan {
  return {
    id: 'plan_test',
    sessionId: 'session-1',
    goal: 'demo goal',
    status: 'pending',
    nodes,
    results: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface Harness {
  deps: PlanDeps;
  updates: TaskNodeResult[];
  persisted: TaskPlan[];
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

/** Build injected `PlanDeps` that record every side effect. */
function harness(
  handler: (tool: string, args: Record<string, unknown>) => PlanToolOutcome | Promise<PlanToolOutcome>,
  opts: { persist?: boolean } = {},
): Harness {
  const updates: TaskNodeResult[] = [];
  const persisted: TaskPlan[] = [];
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const deps: PlanDeps = {
    async runTool(tool, args) {
      calls.push({ tool, args });
      return handler(tool, args);
    },
    onNodeUpdate(node) {
      updates.push(node);
    },
  };
  if (opts.persist) {
    deps.persist = async (plan) => {
      persisted.push(plan);
    };
  }
  return { deps, updates, persisted, calls };
}

const findResult = (plan: TaskPlan, id: string): TaskNodeResult | undefined =>
  plan.results.find((r) => r.id === id);

describe('planner/executor · ordering + happy path', () => {
  it('executes nodes in topological order (a dependency resolves before its dependent)', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const plan = makePlan([toolNode('b', { dependencies: ['a'] }), toolNode('a')]);
    await runPlan(plan, h.deps, { now: () => NOW });
    expect(h.calls.map((c) => c.tool)).toEqual(['tool_a', 'tool_b']);
  });

  it('a kind:tool node whose runTool returns { ok:true, data } → node success carrying the data/summary', async () => {
    const data = { balance: 12345, currency: 'CNY' };
    const h = harness(() => ({ ok: true, data, summary: 'balance fetched' }));
    const out = await runPlan(makePlan([toolNode('a')]), h.deps, { now: () => NOW });
    const r = findResult(out, 'a') as TaskNodeResult & { summary?: string };
    expect(r.status).toBe('success');
    expect(r.tool).toBe('tool_a');
    expect(r.output).toEqual(data);
    expect(r.summary).toBe('balance fetched');
    expect(out.status).toBe('success');
  });

  it('deterministic timestamps: startedAt/finishedAt derive from the injected now()', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const out = await runPlan(makePlan([toolNode('a')]), h.deps, { now: () => NOW });
    const r = findResult(out, 'a');
    expect(r?.startedAt).toBe(NOW);
    expect(r?.endedAt).toBe(NOW);
    expect(out.updatedAt).toBe(NOW);
  });
});

describe('planner/executor · gated tool (confirmation)', () => {
  it('runTool returns { ok:false, requiresConfirmation:true, pendingActionId } → node parked waiting_confirmation (NOT executed)', async () => {
    const h = harness(() => ({ ok: false, requiresConfirmation: true, pendingActionId: 'pa_1' }));
    const plan = makePlan([toolNode('g'), toolNode('d', { dependencies: ['g'] })]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(findResult(out, 'g')?.status).toBe('waiting_confirmation');
    expect(out.status).toBe('waiting_confirmation');
    // The gated tool must not have run its dependent.
    expect(h.calls.map((c) => c.tool)).toEqual(['tool_g']);
  });

  it("a parked node's dependents are NOT executed (they remain pending)", async () => {
    const h = harness(() => ({ ok: false, requiresConfirmation: true, pendingActionId: 'pa_1' }));
    const plan = makePlan([toolNode('g'), toolNode('d', { dependencies: ['g'] })]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(findResult(out, 'd')?.status).toBe('pending');
  });

  it('the pendingActionId is recorded on the node result for later resumption', async () => {
    const h = harness(() => ({ ok: false, requiresConfirmation: true, pendingActionId: 'pa_42' }));
    const out = await runPlan(makePlan([toolNode('g')]), h.deps, { now: () => NOW });
    const g = findResult(out, 'g') as TaskNodeResult & { pendingActionId?: string };
    expect(g.status).toBe('waiting_confirmation');
    expect(g.pendingActionId).toBe('pa_42');
    expect(g.output).toEqual({ pendingActionId: 'pa_42' });
  });
});

describe('planner/executor · conditions + failure isolation', () => {
  it('a condition node evaluating false → its transitive dependents become skipped (not failed)', async () => {
    const h = harness(() => ({ ok: true, data: { total: 50 } }));
    const plan = makePlan([
      toolNode('t1'),
      {
        id: 'c1',
        name: 'C1',
        kind: 'condition',
        dependencies: ['t1'],
        condition: { path: 't1.total', op: '>', value: 100 },
      },
      toolNode('t2', { dependencies: ['c1'] }),
      toolNode('t3'),
    ]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(findResult(out, 'c1')?.status).toBe('skipped');
    expect(findResult(out, 't2')?.status).toBe('skipped');
    expect(findResult(out, 't3')?.status).toBe('success');
    // t2 never ran (condition false); the independent branch t3 did.
    expect(h.calls.map((c) => c.tool)).toEqual(['tool_t1', 'tool_t3']);
    expect(out.status).toBe('success');
  });

  it('a failing node (runTool ok:false) → failed, but runPlan NEVER throws', async () => {
    const h = harness((tool) => (tool === 'boom' ? { ok: false, error: 'kaboom' } : { ok: true, data: {} }));
    const plan = makePlan([toolNode('a', { tool: 'boom' })]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(findResult(out, 'a')?.status).toBe('failed');
    expect(findResult(out, 'a')?.error).toBe('kaboom');
    expect(out.status).toBe('failed');
  });

  it('execution continues along independent branches after a failure', async () => {
    const h = harness((tool) => (tool === 'boom' ? { ok: false, error: 'kaboom' } : { ok: true, data: {} }));
    const plan = makePlan([toolNode('a', { tool: 'boom' }), toolNode('b')]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(findResult(out, 'a')?.status).toBe('failed');
    expect(findResult(out, 'b')?.status).toBe('success');
    expect(h.calls.map((c) => c.tool)).toEqual(['boom', 'tool_b']);
  });
});

describe('planner/executor · observability + persistence', () => {
  it('deps.onNodeUpdate is emitted on every node status change', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    await runPlan(makePlan([toolNode('a')]), h.deps, { now: () => NOW });
    expect(h.updates.map((u) => u.status)).toEqual(['running', 'success']);
    expect(h.updates.every((u) => u.id === 'a')).toBe(true);
  });

  it('deps.persist is called after each mutation when provided (and omitted safely when not)', async () => {
    const withPersist = harness(() => ({ ok: true, data: {} }), { persist: true });
    const out = await runPlan(makePlan([toolNode('a')]), withPersist.deps, { now: () => NOW });
    expect(withPersist.persisted.length).toBeGreaterThanOrEqual(withPersist.updates.length);
    expect(withPersist.persisted[withPersist.persisted.length - 1]).toEqual(out);

    // No persist port → must settle without throwing.
    const withoutPersist = harness(() => ({ ok: true, data: {} }));
    await expect(runPlan(makePlan([toolNode('a')]), withoutPersist.deps, { now: () => NOW })).resolves.toBeDefined();
  });
});

describe('planner/executor · controls + abort', () => {
  it('onControls is invoked once with a PlanControls object (pause/resume/cancel/retry)', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const seen: PlanControls[] = [];
    await runPlan(makePlan([toolNode('a')]), h.deps, { now: () => NOW, onControls: (c) => seen.push(c) });
    expect(seen).toHaveLength(1);
    const controls = seen[0];
    expect(typeof controls.pause).toBe('function');
    expect(typeof controls.resume).toBe('function');
    expect(typeof controls.cancel).toBe('function');
    expect(typeof controls.retry).toBe('function');
  });

  it("aborting the injected signal marks the running node 'cancelled' and settles the plan", async () => {
    const controller = new AbortController();
    const h = harness(() => {
      controller.abort();
      return { ok: true, data: {} };
    });
    const plan = makePlan([toolNode('a'), toolNode('b', { dependencies: ['a'] })]);
    const out = await runPlan(plan, h.deps, { now: () => NOW, signal: controller.signal });
    expect(findResult(out, 'a')?.status).toBe('cancelled');
    expect(out.status).toBe('cancelled');
    // The dependent never ran.
    expect(h.calls.map((c) => c.tool)).toEqual(['tool_a']);
  });

  it('the returned TaskPlan is the final snapshot with updated statuses', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const plan = makePlan([toolNode('a'), toolNode('b', { dependencies: ['a'] })]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(out.id).toBe(plan.id);
    expect(out.sessionId).toBe(plan.sessionId);
    expect(out.status).toBe('success');
    expect(out.results.map((r) => r.status)).toEqual(['success', 'success']);
    expect(out.updatedAt).toBe(NOW);
  });
});

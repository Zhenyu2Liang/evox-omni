/**
 * planner/lifecycle unit spec — pause / cancel+compensation / retry / resume-after-gate /
 * idempotency, driven entirely by in-memory ports (no DB, no network, deterministic).
 *
 * Canonical test home is the sibling `../tests/unit/planner/` node (the root
 * vitest.config.ts includes only `tests/**`). This spec is kept co-located because the
 * planner agent's scoped authority cannot write the sibling tests node; relocate with
 * `git mv planner/lifecycle.test.ts tests/unit/planner/lifecycle.test.ts` to run it under
 * the standard `npm run test` suite.
 */
import { describe, it, expect } from 'vitest';

import { runPlan } from '@/planner/executor';
import type { PlanControlPort, PlanControls, PlanDeps, PlanToolOutcome } from '@/planner/executor';
import { cancelPlan, compensationReport, pausePlan, resumePlan, retryPlan } from '@/planner/lifecycle';
import { transitiveDependents, validatePlan } from '@/planner/dag';
import { AppError } from '@/lib/errors';
import type { TaskNodeResult, TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';

const NOW = 1_700_000_000;

function toolNode(id: string, over: Partial<TaskNodeSpec> = {}): TaskNodeSpec {
  return { id, name: id.toUpperCase(), kind: 'tool', tool: `tool_${id}`, dependencies: [], ...over };
}

function makePlan(nodes: TaskNodeSpec[], results: TaskNodeResult[] = []): TaskPlan {
  return {
    id: 'plan_lifecycle',
    sessionId: 'session-1',
    goal: 'demo goal',
    status: 'pending',
    nodes,
    results,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface Harness {
  deps: PlanDeps;
  updates: TaskNodeResult[];
  snapshots: TaskPlan[];
  persistedNodes: Array<{ planId: string; node: TaskNodeResult }>;
  calls: string[];
  count(tool: string): number;
}

function harness(
  handler: (tool: string, args: Record<string, unknown>) => PlanToolOutcome | Promise<PlanToolOutcome>,
  opts: { controls?: PlanControlPort } = {},
): Harness {
  const updates: TaskNodeResult[] = [];
  const snapshots: TaskPlan[] = [];
  const persistedNodes: Array<{ planId: string; node: TaskNodeResult }> = [];
  const calls: string[] = [];
  const deps: PlanDeps = {
    async runTool(tool, args) {
      calls.push(tool);
      return handler(tool, args);
    },
    onNodeUpdate(node) {
      updates.push(node);
    },
    async persistPlan(plan) {
      snapshots.push(plan);
    },
    async persistNode(planId, node) {
      persistedNodes.push({ planId, node });
    },
  };
  if (opts.controls) deps.controls = opts.controls;
  return {
    deps,
    updates,
    snapshots,
    persistedNodes,
    calls,
    count: (tool) => calls.filter((t) => t === tool).length,
  };
}

const findResult = (plan: TaskPlan, id: string): TaskNodeResult | undefined =>
  plan.results.find((r) => r.id === id);

describe('planner/lifecycle · dependency order + validation', () => {
  it('respects dependency order end-to-end through runPlan', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const plan = makePlan([
      toolNode('c', { dependencies: ['b'] }),
      toolNode('a'),
      toolNode('b', { dependencies: ['a'] }),
    ]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(h.calls).toEqual(['tool_a', 'tool_b', 'tool_c']);
    expect(out.results.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(out.results.map((r) => r.status)).toEqual(['success', 'success', 'success']);
    expect(out.status).toBe('success');
  });

  it('rejects a cyclic plan with AppError VALIDATION', () => {
    const nodes = [toolNode('x', { dependencies: ['y'] }), toolNode('y', { dependencies: ['x'] })];
    const result = validatePlan(nodes, new Set(['tool_x', 'tool_y']));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AppError);
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('transitiveDependents lists impacted descendants in declaration order', () => {
    const nodes = [
      toolNode('a'),
      toolNode('b', { dependencies: ['a'] }),
      toolNode('c', { dependencies: ['b'] }),
      toolNode('z'),
    ];
    expect(transitiveDependents(nodes, 'a')).toEqual(['b', 'c']);
    expect(transitiveDependents(nodes, 'c')).toEqual([]);
  });
});

describe('planner/lifecycle · pause', () => {
  it('PAUSE via in-process PlanControls stops the walk and returns a resumable paused snapshot', async () => {
    let controls: PlanControls | undefined;
    let pausedOnce = false;
    const h = harness(() => {
      if (!pausedOnce) {
        pausedOnce = true;
        controls?.pause();
      }
      return { ok: true, data: {} };
    });
    const plan = makePlan([
      toolNode('a'),
      toolNode('b', { dependencies: ['a'] }),
      toolNode('c', { dependencies: ['b'] }),
    ]);
    const paused = await runPlan(plan, h.deps, { now: () => NOW, onControls: (c) => (controls = c) });
    expect(h.calls).toEqual(['tool_a']);
    expect(findResult(paused, 'a')?.status).toBe('success');
    expect(findResult(paused, 'b')?.status).toBe('pending');
    expect(findResult(paused, 'c')?.status).toBe('pending');
    expect(paused.status).toBe('paused');
    const resumed = await runPlan(paused, h.deps, { now: () => NOW, explicitResume: true });
    expect(h.calls).toEqual(['tool_a', 'tool_b', 'tool_c']);
    expect(resumed.status).toBe('success');
  });

  it('PAUSE via a durable { kind: "pause" } from deps.controls stops the walk between nodes', async () => {
    let polls = 0;
    const controls: PlanControlPort = {
      pollControls() {
        polls += 1;
        return polls === 2 ? [{ kind: 'pause' }] : [];
      },
    };
    const h = harness(() => ({ ok: true, data: {} }), { controls });
    const plan = makePlan([toolNode('a'), toolNode('b', { dependencies: ['a'] })]);
    const paused = await runPlan(plan, h.deps, { now: () => NOW });
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(h.calls).toEqual(['tool_a']);
    expect(findResult(paused, 'a')?.status).toBe('success');
    expect(findResult(paused, 'b')?.status).toBe('pending');
    expect(paused.status).toBe('paused');
    expect(h.snapshots[h.snapshots.length - 1]?.status).toBe('paused');
  });

  it('pausePlan marks a resumable snapshot as paused and keeps recorded node results', () => {
    const plan = makePlan(
      [toolNode('a'), toolNode('b')],
      [{ id: 'a', name: 'A', status: 'success', tool: 'tool_a', output: { cached: true } }],
    );
    const paused = pausePlan(plan, { now: () => 7 });
    expect(paused.status).toBe('paused');
    expect(paused.updatedAt).toBe(7);
    expect(findResult(paused, 'a')?.status).toBe('success');
    expect(findResult(paused, 'b')?.status).toBe('pending');
    expect(plan.status).toBe('pending');
  });
});

describe('planner/lifecycle · cancel + compensation', () => {
  it('CANCEL halts the plan, keeps executed nodes success, records the irreversible set, and never re-runs it', async () => {
    let controls: PlanControls | undefined;
    let pausedOnce = false;
    const h = harness(() => {
      if (!pausedOnce) {
        pausedOnce = true;
        controls?.pause();
      }
      return { ok: true, data: {} };
    });
    const plan = makePlan([
      toolNode('a'),
      toolNode('b', { dependencies: ['a'] }),
      toolNode('c', { dependencies: ['b'] }),
    ]);
    const paused = await runPlan(plan, h.deps, { now: () => NOW, onControls: (c) => (controls = c) });
    expect(findResult(paused, 'a')?.status).toBe('success');
    const cancelled = await cancelPlan(paused, h.deps, { reason: 'user stopped', now: () => NOW });
    expect(cancelled.status).toBe('cancelled');
    expect(findResult(cancelled, 'a')?.status).toBe('success');
    expect(findResult(cancelled, 'b')?.status).toBe('cancelled');
    expect(findResult(cancelled, 'c')?.status).toBe('cancelled');
    expect(findResult(cancelled, 'b')?.output).toEqual({
      cancelled: true,
      reason: 'user stopped',
      executedNodes: ['a'],
    });
    expect(h.persistedNodes.filter((p) => p.node.status === 'cancelled').map((p) => p.node.id)).toEqual(['b', 'c']);
    expect(compensationReport(cancelled, 42)).toEqual({
      planId: plan.id,
      cancelledAt: 42,
      executed: ['a'],
      skipped: [],
      cancelledNodes: ['b', 'c'],
    });
    const callsBefore = h.calls.length;
    const rerun = await runPlan(cancelled, h.deps, { now: () => NOW });
    expect(h.calls.length).toBe(callsBefore);
    expect(rerun.status).toBe('cancelled');
    expect(findResult(rerun, 'a')?.status).toBe('success');
  });

  it('a durable { kind: "cancel" } halts the walk and settles the plan cancelled', async () => {
    let polls = 0;
    const controls: PlanControlPort = {
      pollControls() {
        polls += 1;
        return polls === 2 ? [{ kind: 'cancel' }] : [];
      },
    };
    const h = harness(() => ({ ok: true, data: {} }), { controls });
    const plan = makePlan([toolNode('a'), toolNode('b', { dependencies: ['a'] })]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(h.calls).toEqual(['tool_a']);
    expect(findResult(out, 'a')?.status).toBe('success');
    expect(findResult(out, 'b')?.status).toBe('cancelled');
    expect(out.status).toBe('cancelled');
  });

  it('a durable { kind: "cancel" } polled AFTER `a` settles sweeps a 3-node chain to cancelled (Case 10)', async () => {
    let h: Harness | undefined;
    const controls: PlanControlPort = {
      // Cancel ONLY once node `a` has executed — i.e. the durable poll happens
      // after `a` settled and before `b` is launched.
      pollControls() {
        return h?.calls.includes('tool_a') ? [{ kind: 'cancel' }] : [];
      },
    };
    h = harness(() => ({ ok: true, data: {} }), { controls });
    const plan = makePlan([
      toolNode('a'),
      toolNode('b', { dependencies: ['a'] }),
      toolNode('c', { dependencies: ['b'] }),
    ]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(findResult(out, 'a')?.status).toBe('success');
    expect(findResult(out, 'b')?.status).toBe('cancelled');
    expect(findResult(out, 'c')?.status).toBe('cancelled');
    expect(out.status).toBe('cancelled');
    // `b` and `c` never ran: `a` is the only node whose tool was invoked.
    expect(h.calls).toEqual(['tool_a']);
    expect(h.count('tool_b')).toBe(0);
    expect(h.count('tool_c')).toBe(0);
  });

  it('cancelPlan works without ports (pure halt) and never re-executes a successful node', async () => {
    const plan = makePlan(
      [toolNode('a'), toolNode('b'), toolNode('c')],
      [
        { id: 'a', name: 'A', status: 'success', tool: 'tool_a' },
        { id: 'b', name: 'B', status: 'failed', tool: 'tool_b', error: 'nope' },
        { id: 'c', name: 'C', status: 'skipped', tool: 'tool_c' },
      ],
    );
    const out = await cancelPlan(plan, undefined, { reason: 'abort', now: () => NOW });
    expect(out.status).toBe('cancelled');
    expect(out.results.map((r) => r.status)).toEqual(['success', 'failed', 'skipped']);
    expect(compensationReport(out, 1)).toEqual({
      planId: plan.id,
      cancelledAt: 1,
      executed: ['a'],
      skipped: ['c'],
      cancelledNodes: [],
    });
  });
});

describe('planner/lifecycle · retry', () => {
  it('RETRY re-runs only the failed node + its impacted descendants (successful node NOT re-invoked)', async () => {
    let failB = true;
    const h = harness((tool) =>
      tool === 'tool_b' && failB ? { ok: false, error: 'kaboom' } : { ok: true, data: {} },
    );
    const plan = makePlan([
      toolNode('a'),
      toolNode('b', { dependencies: ['a'] }),
      toolNode('c', { dependencies: ['b'] }),
    ]);
    const first = await runPlan(plan, h.deps, { now: () => NOW });
    expect(findResult(first, 'a')?.status).toBe('success');
    expect(findResult(first, 'b')?.status).toBe('failed');
    expect(findResult(first, 'c')?.status).toBe('skipped');
    expect(first.status).toBe('failed');
    expect(h.count('tool_a')).toBe(1);
    expect(h.count('tool_b')).toBe(1);
    failB = false;
    const retried = await retryPlan(first, h.deps, { now: () => NOW });
    expect(h.count('tool_a')).toBe(1);
    expect(h.count('tool_b')).toBe(2);
    expect(h.count('tool_c')).toBe(1);
    expect(findResult(retried, 'a')?.status).toBe('success');
    expect(findResult(retried, 'b')?.status).toBe('success');
    expect(findResult(retried, 'c')?.status).toBe('success');
    expect(retried.status).toBe('success');
  });

  it('RETRY returns the plan unchanged when there is nothing to retry', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const settled = await runPlan(makePlan([toolNode('a')]), h.deps, { now: () => NOW });
    const callsBefore = h.calls.length;
    const again = await retryPlan(settled, h.deps, { now: () => NOW });
    expect(again).toBe(settled);
    expect(h.calls.length).toBe(callsBefore);
  });

  it('RETRY honours explicit opts.nodeIds', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const plan = makePlan(
      [toolNode('a'), toolNode('b', { dependencies: ['a'] })],
      [
        { id: 'a', name: 'A', status: 'success', tool: 'tool_a' },
        { id: 'b', name: 'B', status: 'skipped', tool: 'tool_b' },
      ],
    );
    const out = await retryPlan(plan, h.deps, { nodeIds: ['b'], now: () => NOW });
    expect(h.calls).toEqual(['tool_b']);
    expect(findResult(out, 'a')?.status).toBe('success');
    expect(findResult(out, 'b')?.status).toBe('success');
    expect(out.status).toBe('success');
  });

  it('a durable { kind: "retry", nodeId } re-drives the node and its dependents within one walk', async () => {
    let failOnce = true;
    let polls = 0;
    const controls: PlanControlPort = {
      pollControls() {
        polls += 1;
        return polls === 3 ? [{ kind: 'retry', nodeId: 'b' }] : [];
      },
    };
    const h = harness(
      (tool) => {
        if (tool === 'tool_b' && failOnce) {
          failOnce = false;
          return { ok: false, error: 'transient' };
        }
        return { ok: true, data: {} };
      },
      { controls },
    );
    const plan = makePlan([
      toolNode('a'),
      toolNode('b', { dependencies: ['a'] }),
      toolNode('c', { dependencies: ['b'] }),
    ]);
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(h.count('tool_a')).toBe(1);
    expect(h.count('tool_b')).toBe(2);
    expect(findResult(out, 'b')?.status).toBe('success');
    expect(findResult(out, 'c')?.status).toBe('success');
    expect(out.status).toBe('success');
  });
});

describe('planner/lifecycle · resume (gated node)', () => {
  it('RESUME applies the human decision and continues from the gated node without re-running successes', async () => {
    const h = harness((tool) =>
      tool === 'gated'
        ? { ok: false, requiresConfirmation: true, pendingActionId: 'pa_1' }
        : { ok: true, data: { done: tool } },
    );
    const plan = makePlan([
      toolNode('e'),
      toolNode('g', { tool: 'gated' }),
      toolNode('d', { dependencies: ['g'] }),
    ]);
    const parked = await runPlan(plan, h.deps, { now: () => NOW });
    expect(findResult(parked, 'e')?.status).toBe('success');
    expect(findResult(parked, 'g')?.status).toBe('waiting_confirmation');
    expect(findResult(parked, 'd')?.status).toBe('pending');
    expect(parked.status).toBe('waiting_confirmation');
    expect(h.calls).toEqual(['tool_e', 'gated']);
    const resumed = await resumePlan(
      parked,
      { nodeId: 'g', outcome: { ok: true, data: { approved: true } } },
      h.deps,
      { now: () => NOW },
    );
    expect(findResult(resumed, 'g')?.status).toBe('success');
    expect(findResult(resumed, 'g')?.output).toEqual({ approved: true });
    expect(findResult(resumed, 'd')?.status).toBe('success');
    expect(h.count('tool_e')).toBe(1);
    expect(h.count('gated')).toBe(1);
    expect(resumed.status).toBe('success');
  });

  it('RESUME with a still-gated outcome re-parks the node and runs nothing further', async () => {
    const h = harness((tool) =>
      tool === 'gated'
        ? { ok: false, requiresConfirmation: true, pendingActionId: 'pa_1' }
        : { ok: true, data: {} },
    );
    const plan = makePlan([toolNode('g', { tool: 'gated' }), toolNode('d', { dependencies: ['g'] })]);
    const parked = await runPlan(plan, h.deps, { now: () => NOW });
    const stillParked = await resumePlan(
      parked,
      { nodeId: 'g', outcome: { ok: false, requiresConfirmation: true, pendingActionId: 'pa_2' } },
      h.deps,
      { now: () => NOW },
    );
    const g = findResult(stillParked, 'g') as TaskNodeResult & { pendingActionId?: string };
    expect(g.status).toBe('waiting_confirmation');
    expect(g.pendingActionId).toBe('pa_2');
    expect(findResult(stillParked, 'd')?.status).toBe('pending');
    expect(stillParked.status).toBe('waiting_confirmation');
    expect(h.count('gated')).toBe(1);
  });

  it('RESUME with a failed decision records the failure and settles the plan failed', async () => {
    const h = harness((tool) =>
      tool === 'gated'
        ? { ok: false, requiresConfirmation: true, pendingActionId: 'pa_1' }
        : { ok: true, data: {} },
    );
    const plan = makePlan([toolNode('g', { tool: 'gated' }), toolNode('d', { dependencies: ['g'] })]);
    const parked = await runPlan(plan, h.deps, { now: () => NOW });
    const resumed = await resumePlan(
      parked,
      { nodeId: 'g', outcome: { ok: false, error: 'user rejected' } },
      h.deps,
      { now: () => NOW },
    );
    expect(findResult(resumed, 'g')?.status).toBe('failed');
    expect(findResult(resumed, 'g')?.error).toBe('user rejected');
    expect(findResult(resumed, 'd')?.status).toBe('skipped');
    expect(resumed.status).toBe('failed');
  });

  it('RESUME throws AppError NOT_FOUND for a node that is not in the plan', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const plan = makePlan([toolNode('a')]);
    await expect(
      resumePlan(plan, { nodeId: 'missing', outcome: { ok: true } }, h.deps, { now: () => NOW }),
    ).rejects.toMatchObject({ name: 'AppError', code: 'NOT_FOUND' });
    expect(h.calls).toEqual([]);
  });
});

describe('planner/lifecycle · idempotency', () => {
  it('never re-executes a node already terminal (success) in the input plan', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const plan = makePlan(
      [toolNode('a'), toolNode('b', { dependencies: ['a'] })],
      [
        {
          id: 'a',
          name: 'A',
          status: 'success',
          tool: 'tool_a',
          output: { cached: true },
          startedAt: NOW,
          endedAt: NOW,
        },
      ],
    );
    const out = await runPlan(plan, h.deps, { now: () => NOW });
    expect(h.calls).toEqual(['tool_b']);
    expect(findResult(out, 'a')?.output).toEqual({ cached: true });
    expect(findResult(out, 'b')?.status).toBe('success');
    expect(out.status).toBe('success');
    expect(h.updates.map((u) => u.id)).toEqual(['b', 'b']);
  });

  it('persists node results incrementally alongside persistPlan snapshots', async () => {
    const h = harness(() => ({ ok: true, data: {} }));
    const out = await runPlan(makePlan([toolNode('a')]), h.deps, { now: () => NOW });
    expect(h.persistedNodes.map((p) => p.node.status)).toEqual(['running', 'success']);
    expect(h.persistedNodes.every((p) => p.planId === out.id)).toBe(true);
    expect(h.snapshots[h.snapshots.length - 1]).toEqual(out);
  });
});

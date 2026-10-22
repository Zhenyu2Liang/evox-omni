/**
 * planner/plan-drive-guard.test.ts — regression coverage for the "settled refusal" guard: a node
 * whose gated action is LOCKED or no longer OPEN must never be driven again (no tool call, no fresh
 * `pending` row, no invented `pendingActionId`), while a still-OPEN action must still be re-driven.
 *
 * The four guarded paths are exercised here through the public entry points:
 *  - `runPlan` → `runToolNode`'s pre-claim guard (the node converges to `failed`);
 *  - `runPlan`'s cooperative `retry` control;
 *  - `lifecycle.retryPlan` (no reset, no run);
 *  - `lifecycle.resumePlan` (no decision recorded, nothing written).
 *
 * Pure injection (`plan-test-harness.ts`): NO database, NO network.
 */
import { describe, expect, it } from 'vitest';

import { runPlan } from './executor';
import { resumePlan, retryPlan } from './lifecycle';
import type { PlanFailure } from './failure';
import type { TaskPlan } from '@/lib/contracts/task';
import { findResult, makePlan, NOW, parkedResult, planHarness, toolNode } from './plan-test-harness';

/** The typed facts of an exhausted-verification refusal (a LOCKED refusal). */
const LOCKED_FAILURE: PlanFailure = { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted' };

describe('planner · a locked / settled action is never re-driven', () => {
  it('(F) a node parked on a locked action converges to failed with no tool call and no new pending action', async () => {
    const h = planHarness(() => ({ ok: true, data: {} }));
    const plan = makePlan(
      [toolNode('pay'), toolNode('next', { dependencies: ['pay'] })],
      [parkedResult('pay', { pendingActionId: 'pa_1', actionStatus: 'locked', failure: LOCKED_FAILURE })],
    );

    const out = await runPlan(plan, h.deps, { now: () => NOW });

    expect(h.calls).toEqual([]);
    // EXACT shape: the recorded facts survive, no `waiting_confirmation` and no new pendingActionId.
    expect(findResult(out, 'pay')).toEqual({
      id: 'pay',
      name: 'PAY',
      tool: 'tool_pay',
      status: 'failed',
      pendingActionId: 'pa_1',
      actionStatus: 'locked',
      failure: { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted' },
      endedAt: NOW,
    });
    expect(out.results.map((r) => ({ id: r.id, status: r.status }))).toEqual([
      { id: 'pay', status: 'failed' },
      { id: 'next', status: 'skipped' },
    ]);
    expect(out.status).toBe('failed');
    // The only node rows written are the seal + the dependent skip: no `running` write for a sealed node.
    expect(h.nodeRows.map((r) => ({ id: r.id, status: r.status }))).toEqual([
      { id: 'pay', status: 'failed' },
      { id: 'next', status: 'skipped' },
    ]);
    expect(h.snapshots.at(-1)?.status).toBe('failed');
  });

  it('(G) a node parked on an already-executed action is sealed the same way', async () => {
    const h = planHarness(() => ({ ok: true, data: {} }));
    const plan = makePlan(
      [toolNode('pay')],
      [parkedResult('pay', { pendingActionId: 'pa_9', actionStatus: 'executed' })],
    );

    const out = await runPlan(plan, h.deps, { now: () => NOW });

    expect(h.calls).toEqual([]);
    expect(findResult(out, 'pay')).toEqual({
      id: 'pay',
      name: 'PAY',
      tool: 'tool_pay',
      status: 'failed',
      pendingActionId: 'pa_9',
      actionStatus: 'executed',
      endedAt: NOW,
    });
    expect(out.status).toBe('failed');
    expect(h.nodeRows.map((r) => r.status)).toEqual(['failed']);
  });

  it('(H) retryPlan neither resets a locked refusal nor re-runs the tool', async () => {
    const h = planHarness(() => ({ ok: true, data: {} }));
    const plan: TaskPlan = {
      ...makePlan([toolNode('pay')], [parkedResult('pay', { status: 'failed', failure: LOCKED_FAILURE })]),
      status: 'failed',
    };

    const out = await retryPlan(plan, h.deps, { now: () => NOW });

    // Nothing to reset ⇒ the snapshot comes back UNTOUCHED (same reference, zero writes).
    expect(out).toBe(plan);
    expect(h.calls).toEqual([]);
    expect(h.nodeRows).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.snapshots).toEqual([]);
    // The recorded failure is not overwritten by a fresh `pending` row.
    expect(findResult(out, 'pay')).toEqual({
      id: 'pay',
      name: 'PAY',
      tool: 'tool_pay',
      status: 'failed',
      failure: { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted' },
    });
  });

  it('(I) an in-run retry control does not reset or re-drive a sealed node', async () => {
    const h = planHarness(() => ({ ok: true, data: {} }));
    const plan = makePlan(
      [toolNode('pay')],
      [parkedResult('pay', { pendingActionId: 'pa_1', actionStatus: 'locked', failure: LOCKED_FAILURE })],
    );

    const out = await runPlan(plan, h.deps, { now: () => NOW, onControls: (controls) => controls.retry('pay') });

    expect(h.calls).toEqual([]);
    // The retry never wrote a `pending` row for the sealed node.
    expect(h.nodeRows.map((r) => r.status)).toEqual(['failed']);
    expect(findResult(out, 'pay')?.status).toBe('failed');
    expect(findResult(out, 'pay')?.failure).toEqual(LOCKED_FAILURE);
    expect(out.status).toBe('failed');
  });

  it('(J) resumePlan records no decision and writes nothing for a sealed node', async () => {
    const h = planHarness(() => ({ ok: true, data: {} }));
    const plan = makePlan(
      [toolNode('pay')],
      [parkedResult('pay', { pendingActionId: 'pa_1', actionStatus: 'locked', failure: LOCKED_FAILURE })],
    );

    const out = await resumePlan(
      plan,
      { nodeId: 'pay', outcome: { ok: true, data: { approved: true } } },
      h.deps,
      { now: () => NOW },
    );

    expect(out).toBe(plan);
    expect(h.calls).toEqual([]);
    expect(h.nodeRows).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.snapshots).toEqual([]);
    expect(findResult(out, 'pay')?.status).toBe('waiting_confirmation');
  });

  it('(K) replaying the returned snapshot never re-drives a node sealed by a locked action status', async () => {
    const h = planHarness(() => ({ ok: true, data: {} }));
    const plan = makePlan(
      [toolNode('pay')],
      [parkedResult('pay', { pendingActionId: 'pa_1', actionStatus: 'locked' })],
    );

    const first = await runPlan(plan, h.deps, { now: () => NOW });
    const second = await runPlan(first, h.deps, { now: () => NOW });

    expect(h.calls).toEqual([]);
    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    expect(findResult(second, 'pay')?.status).toBe('failed');
  });

  it('(K) replaying the returned snapshot never re-drives a node sealed by the locked refusal reason', async () => {
    const h = planHarness(() => ({ ok: true, data: {} }));
    const plan = makePlan(
      [toolNode('pay')],
      [parkedResult('pay', { pendingActionId: 'pa_2', failure: LOCKED_FAILURE })],
    );

    const first = await runPlan(plan, h.deps, { now: () => NOW });
    const second = await runPlan(first, h.deps, { now: () => NOW });

    expect(h.calls).toEqual([]);
    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    expect(findResult(second, 'pay')?.status).toBe('failed');
  });

  it('(L) a still-OPEN action IS re-driven exactly once and the plan advances', async () => {
    const h = planHarness(() => ({ ok: true, data: { approved: true } }));
    const plan = makePlan(
      [toolNode('pay'), toolNode('next', { dependencies: ['pay'] })],
      [parkedResult('pay', { pendingActionId: 'pa_1', actionStatus: 'pending' })],
    );

    const out = await runPlan(plan, h.deps, { now: () => NOW });

    expect(h.calls.map((c) => c.tool)).toEqual(['tool_pay', 'tool_next']);
    expect(h.calls.filter((c) => c.tool === 'tool_pay')).toHaveLength(1);
    expect(h.calls[0].ctx).toEqual({ taskId: 'plan_test', nodeId: 'pay' });
    expect(findResult(out, 'pay')?.status).toBe('success');
    expect(findResult(out, 'next')?.status).toBe('success');
    expect(out.status).toBe('success');
  });
});

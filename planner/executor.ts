/**
 * planner/executor.ts — Deterministic plan execution engine.
 *
 * Walks a validated `TaskPlan` in topological order, executing `kind:'tool'`
 * nodes through an injected `runTool` port and evaluating `kind:'condition'`
 * nodes to skip dependent branches. All side effects (tool calls, persistence,
 * clock) live behind `PlanDeps` — the executor itself holds no banking,
 * security, or DB logic.
 *
 * The `runTool` port is supplied by the agent layer and routes through the
 * Security Gateway, so a node that needs human confirmation surfaces
 * `requiresConfirmation`/`pendingActionId` instead of executing — the executor
 * then parks the node in `waiting_confirmation` (see `planner/CONTEXT.md`).
 */
import type { TaskNodeResult, TaskNodeSpec, TaskNodeStatus, TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import { AppError } from '@/lib/errors';
import { demoNow } from '@/lib/clock';
import { evaluateCondition, topologicalOrder } from './dag';

/**
 * Outcome of one tool invocation, as reported by the injected `runTool` port.
 * A gated tool call must NOT execute here — it returns
 * `{ ok:false, requiresConfirmation:true, pendingActionId }` so the executor can
 * transition the node to `waiting_confirmation`/`waiting_verification`.
 */
export interface PlanToolOutcome {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
}

/** Side-effect ports the executor depends on. */
export interface PlanDeps {
  /** Execute one banking tool. Routes through the Security Gateway in production. */
  runTool(toolName: string, args: Record<string, unknown>): Promise<PlanToolOutcome>;
  /** Emitted on every node status change; the agent forwards it as `plan_update`. */
  onNodeUpdate(node: TaskNodeResult): void | Promise<void>;
  /** Optional persistence of the plan snapshot (AgentTask/AgentTaskNode). */
  persist?(plan: TaskPlan): Promise<void>;
}

/** Out-of-band controls handed to the caller so a running plan can be steered. */
export interface PlanControls {
  pause(): void;
  resume(): void;
  cancel(): void;
  retry(nodeId: string): void;
}

export interface RunPlanOptions {
  /** Abort signal; aborting cancels the plan and marks the running node `cancelled`. */
  signal?: AbortSignal;
  /** Injectable clock for deterministic timestamps; defaults to the demo clock (`demoNow`). */
  now?: () => number;
  /**
   * Receives the `PlanControls` object once execution starts, so callers
   * (`POST /api/tasks/:id/...`) can pause/resume/cancel/retry a running plan.
   */
  onControls?: (controls: PlanControls) => void;
}

/** A node status that will not change again on its own (dependents may proceed). */
const TERMINAL: ReadonlySet<TaskNodeStatus> = new Set<TaskNodeStatus>([
  'success',
  'failed',
  'skipped',
  'cancelled',
]);

/**
 * Execute a plan to settlement and return its final snapshot.
 *
 * - Node statuses transition `pending → running → success | failed |
 *   waiting_confirmation | waiting_verification | cancelled | skipped`.
 * - A `condition` node evaluating `false` marks its transitive dependents `skipped`.
 * - A failing node is recorded as `failed`; the executor NEVER throws on a single
 *   node failure and continues independent branches.
 * - `deps.persist` is called after each mutation when provided.
 *
 * Assumes a VALIDATED plan (call `validatePlan` first — `submit_plan` does); this
 * function does not re-validate. The input `plan` is never mutated: every emitted
 * / returned state is a fresh snapshot with a copy of the results array.
 *
 * Controls (all cooperative, checked between node checkpoints):
 * - `pause()`/`resume()` gate the walk; `cancel()` and `opts.signal` abort it,
 *   marking the in-flight node `cancelled` and settling the plan `cancelled`.
 * - `retry(nodeId)` resets that node and its transitive dependents to `pending`
 *   and rewinds the walk to the earliest such node, so they re-run on the next
 *   checkpoints (re-invoking `runTool`). Requests are de-duplicated per pass.
 */
export async function runPlan(plan: TaskPlan, deps: PlanDeps, opts: RunPlanOptions = {}): Promise<TaskPlan> {
  const now = opts.now ?? (() => demoNow());
  const signal = opts.signal;

  const byId = new Map<string, TaskNodeSpec>();
  for (const node of plan.nodes) byId.set(node.id, node);

  const order = topologicalOrder(plan.nodes);
  const positionOf = new Map<string, number>();
  order.forEach((node, i) => positionOf.set(node.id, i));

  // Direct dependents map (dependency id → nodes that depend on it).
  const dependents = new Map<string, string[]>();
  for (const node of plan.nodes) {
    for (const dep of node.dependencies) {
      const arr = dependents.get(dep);
      if (arr) arr.push(node.id);
      else dependents.set(dep, [node.id]);
    }
  }
  const collectTransitiveDependents = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [...(dependents.get(id) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      for (const next of dependents.get(current) ?? []) stack.push(next);
    }
    return out;
  };

  // Working copy of the results (input plan untouched). Keyed by node id.
  const results = new Map<string, TaskNodeResult>();
  for (const r of plan.results) results.set(r.id, { ...r });

  let planStatus: TaskPlanStatus = 'running';

  const snapshot = (): TaskPlan => ({
    id: plan.id,
    sessionId: plan.sessionId,
    goal: plan.goal,
    status: planStatus,
    nodes: plan.nodes,
    results: plan.nodes.map((n) => {
      const r = results.get(n.id);
      if (r) return { ...r };
      // Not executed yet (e.g. dependents of a parked node): surface as pending.
      return { id: n.id, name: n.name, status: 'pending' as TaskNodeStatus, tool: n.kind === 'tool' ? n.tool : undefined };
    }),
    createdAt: plan.createdAt,
    updatedAt: now(),
  });

  /** Record a node result, notify the listener and persist the snapshot. */
  const setNode = async (result: TaskNodeResult): Promise<void> => {
    results.set(result.id, { ...result });
    await deps.onNodeUpdate({ ...result });
    await deps.persist?.(snapshot());
  };

  /** Scope for condition evaluation: prior node id → its recorded `output`. */
  const buildScope = (): Record<string, unknown> => {
    const scope: Record<string, unknown> = {};
    for (const node of plan.nodes) {
      const r = results.get(node.id);
      if (r) scope[node.id] = r.output;
    }
    return scope;
  };

  /** Mark a node `skipped` (transitive skip propagation), preserving terminal nodes. */
  const markSkipped = async (id: string, reason: string): Promise<void> => {
    const existing = results.get(id);
    if (existing && TERMINAL.has(existing.status)) return;
    const node = byId.get(id);
    await setNode({
      id,
      name: node?.name ?? id,
      status: 'skipped',
      tool: node?.kind === 'tool' ? node.tool : undefined,
      output: { skipped: true, reason },
      endedAt: now(),
    });
  };

  // ---- controls state -------------------------------------------------------
  let paused = false;
  let cancelled = false;
  let aborted = Boolean(signal?.aborted);
  let waiters: Array<() => void> = [];
  const retryRequests = new Set<string>();

  const flushWaiters = (): void => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  };
  const onAbort = (): void => {
    aborted = true;
    flushWaiters();
  };
  if (signal) {
    if (signal.aborted) aborted = true;
    else signal.addEventListener('abort', onAbort);
  }

  const stopRequested = (): boolean => cancelled || aborted || Boolean(signal?.aborted);

  const controls: PlanControls = {
    pause() {
      if (!stopRequested()) paused = true;
    },
    resume() {
      paused = false;
      flushWaiters();
    },
    cancel() {
      cancelled = true;
      flushWaiters();
    },
    retry(nodeId) {
      retryRequests.add(nodeId);
    },
  };

  /** Await pause gate; returns immediately when stop is requested. */
  const checkpoint = async (): Promise<void> => {
    if (signal?.aborted) aborted = true;
    while (paused && !stopRequested()) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };

  /** Cancel the node currently in flight (or the next pending one). */
  const cancelNode = async (node: TaskNodeSpec): Promise<void> => {
    const existing = results.get(node.id);
    if (existing && TERMINAL.has(existing.status)) return;
    await setNode({
      id: node.id,
      name: node.name,
      status: 'cancelled',
      tool: node.kind === 'tool' ? node.tool : undefined,
      startedAt: existing?.startedAt,
      endedAt: now(),
    });
  };

  /** Execute a `kind:'tool'` node. */
  const runToolNode = async (node: TaskNodeSpec): Promise<'settled' | 'parked' | 'stopped'> => {
    const startedAt = now();
    await setNode({ id: node.id, name: node.name, status: 'running', tool: node.tool, startedAt });

    if (stopRequested()) {
      await cancelNode(node);
      return 'stopped';
    }

    let outcome: PlanToolOutcome;
    try {
      outcome = await deps.runTool(node.tool as string, node.args ?? {});
    } catch (e) {
      outcome = { ok: false, error: AppError.from(e).message };
    }

    if (stopRequested()) {
      await cancelNode(node);
      return 'stopped';
    }

    // Gated tool: it did NOT execute — park the node for human confirmation/MFA.
    if (outcome.requiresConfirmation || (!outcome.ok && outcome.pendingActionId !== undefined)) {
      const isRed = (node as { riskLevel?: unknown }).riskLevel === 'RED';
      planStatus = 'waiting_confirmation';
      const parked: TaskNodeResult & { pendingActionId?: string } = {
        id: node.id,
        name: node.name,
        status: isRed ? 'waiting_verification' : 'waiting_confirmation',
        tool: node.tool,
        output: outcome.pendingActionId !== undefined ? { pendingActionId: outcome.pendingActionId } : undefined,
        error: outcome.error,
        startedAt,
        endedAt: now(),
      };
      if (outcome.pendingActionId !== undefined) parked.pendingActionId = outcome.pendingActionId;
      await setNode(parked);
      return 'parked';
    }

    if (outcome.ok) {
      let output = outcome.data;
      if (output === undefined && outcome.summary !== undefined) output = { summary: outcome.summary };
      const success: TaskNodeResult & { summary?: string } = {
        id: node.id,
        name: node.name,
        status: 'success',
        tool: node.tool,
        output,
        startedAt,
        endedAt: now(),
      };
      if (outcome.summary !== undefined) success.summary = outcome.summary;
      await setNode(success);
      return 'settled';
    }

    // Failure: record it and continue — never throw.
    await setNode({
      id: node.id,
      name: node.name,
      status: 'failed',
      tool: node.tool,
      error: outcome.error ?? `tool '${node.tool ?? node.id}' failed`,
      startedAt,
      endedAt: now(),
    });
    return 'settled';
  };

  // ---- main walk ------------------------------------------------------------
  opts.onControls?.(controls);

  let stopped = false;
  let parked = false;

  try {
    let index = 0;
    while (index < order.length || retryRequests.size > 0) {
      await checkpoint();

      if (stopRequested()) {
        stopped = true;
        const node = order[index];
        if (node) await cancelNode(node);
        break;
      }

      // Cooperative retry: reset affected nodes + rewind to the earliest.
      if (retryRequests.size > 0) {
        let rewindTo = index;
        for (const id of retryRequests) {
          for (const affected of [id, ...collectTransitiveDependents(id)]) {
            const node = byId.get(affected);
            if (!node) continue;
            await setNode({
              id: affected,
              name: node.name,
              status: 'pending',
              tool: node.kind === 'tool' ? node.tool : undefined,
            });
          }
          const pos = positionOf.get(id);
          if (pos !== undefined && pos < rewindTo) rewindTo = pos;
        }
        retryRequests.clear();
        index = rewindTo;
        continue;
      }

      const node = order[index];
      const existing = results.get(node.id);

      // Already settled in a prior pass/run — leave the recorded result intact.
      if (existing && TERMINAL.has(existing.status)) {
        index += 1;
        continue;
      }

      // Transitive skip propagation: a skipped dependency skips this node too.
      const depSkipped = node.dependencies.some((dep) => results.get(dep)?.status === 'skipped');
      if (depSkipped) {
        await markSkipped(node.id, 'dependency skipped');
        index += 1;
        continue;
      }

      if (node.kind === 'condition') {
        const startedAt = now();
        const truthy = node.condition ? evaluateCondition(node.condition, buildScope()) : false;
        await setNode({
          id: node.id,
          name: node.name,
          status: truthy ? 'success' : 'skipped',
          output: { result: truthy },
          startedAt,
          endedAt: now(),
        });
        if (!truthy) {
          for (const dependent of collectTransitiveDependents(node.id)) {
            await markSkipped(dependent, `condition '${node.id}' evaluated false`);
          }
        }
        index += 1;
        continue;
      }

      if (node.kind === 'note') {
        const startedAt = now();
        await setNode({ id: node.id, name: node.name, status: 'success', startedAt, endedAt: now() });
        index += 1;
        continue;
      }

      // kind === 'tool'
      const outcome = await runToolNode(node);
      if (outcome === 'stopped') {
        stopped = true;
        break;
      }
      if (outcome === 'parked') {
        parked = true;
        break;
      }
      index += 1;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (stopped) {
    planStatus = 'cancelled';
  } else if (parked) {
    planStatus = 'waiting_confirmation';
  } else {
    const allSettled = plan.nodes.every((node) => {
      const status = results.get(node.id)?.status;
      return status === 'success' || status === 'skipped';
    });
    planStatus = allSettled ? 'success' : 'failed';
  }

  const final = snapshot();
  await deps.persist?.(final);
  return final;
}

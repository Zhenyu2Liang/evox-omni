/**
 * planner/executor.ts — Deterministic plan execution engine.
 *
 * Walks a validated `TaskPlan` in topological order, executing `kind:'tool'`
 * nodes through an injected `runTool` port and evaluating `kind:'condition'`
 * nodes to skip dependent branches. All side effects (tool calls, persistence,
 * clock, cross-request steering) live behind `PlanDeps` — the executor itself
 * holds no banking, security, or DB logic.
 *
 * The `runTool` port is supplied by the agent layer and routes through the
 * Security Gateway, so a node that needs human confirmation surfaces
 * `requiresConfirmation`/`pendingActionId` instead of executing — the executor
 * then parks the node in `waiting_confirmation` (see `planner/CONTEXT.md`).
 *
 * Durability is the CALLER's concern: `PlanDeps` exposes optional
 * `persistPlan`/`persistNode`/`loadPlan` ports plus a durable `controls` port
 * polled at each node checkpoint, so an out-of-process (HTTP) request can steer
 * a running plan and a paused/parked plan can be resumed (`runPlan` with
 * `explicitResume:true`, or `lifecycle.resumePlan` — see `planner/lifecycle.ts`).
 */
import type { TaskNodeResult, TaskNodeSpec, TaskNodeStatus, TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import { AppError } from '@/lib/errors';
import { demoNow } from '@/lib/clock';
import { evaluateCondition, topologicalOrder, transitiveDependents } from './dag';

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

/** One durable control command, delivered out-of-process (e.g. `POST /api/tasks/:id`). */
export type PlanControlCommand =
  | { kind: 'pause' }
  | { kind: 'cancel' }
  | { kind: 'retry'; nodeId: string };

/**
 * Durable control source, consulted at each node checkpoint so an out-of-process
 * (HTTP) request can steer a running plan. `pollControls` should READ-AND-CLEAR
 * the pending commands for the plan.
 */
export interface PlanControlPort {
  pollControls(planId: string): Promise<PlanControlCommand[]> | PlanControlCommand[];
}

/**
 * Side-effect ports the executor depends on. Every port is injected by the
 * caller, keeping `./planner` DB-agnostic.
 */
export interface PlanDeps {
  /** Execute one banking tool. Routes through the Security Gateway in production. */
  runTool(toolName: string, args: Record<string, unknown>): Promise<PlanToolOutcome>;
  /** Emitted on every node status change; the agent forwards it as `plan_update`. */
  onNodeUpdate(node: TaskNodeResult): void | Promise<void>;
  /** Persist the full plan snapshot (AgentTask/AgentTaskNode). */
  persistPlan?(plan: TaskPlan): Promise<void>;
  /** Persist one node result incrementally (`planId`, node). */
  persistNode?(planId: string, node: TaskNodeResult): Promise<void>;
  /**
   * Load a persisted plan snapshot. Used by the durable entry points AND by
   * `persistPlanSnapshotGuarded` (the planner-side guard that refuses to
   * overwrite a durable `'cancelled'`/`'success'`/`'paused'` status).
   */
  loadPlan?(planId: string): Promise<TaskPlan | undefined>;
  /** Durable control source consulted at each checkpoint (cross-request steering). Optional. */
  controls?: PlanControlPort;
  /**
   * @deprecated kept for BACKWARD COMPATIBILITY — an alias for `persistPlan`
   * (called after each mutation when `persistPlan` is absent).
   */
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
  /** Abort signal; aborting cancels the plan and marks every not-yet-terminal node `cancelled`. */
  signal?: AbortSignal;
  /** Injectable clock for deterministic timestamps; defaults to the demo clock (`demoNow`). */
  now?: () => number;
  /**
   * Receives the `PlanControls` object once execution starts, so an IN-PROCESS
   * caller can pause/resume/cancel/retry a running plan. Cross-request steering
   * uses the durable `deps.controls` port instead.
   */
  onControls?: (controls: PlanControls) => void;
  /**
   * Explicitly re-drive a plan whose snapshot says `'paused'`. A paused plan is
   * NOT runnable on its own (see `runPlan`): this flag is the ONLY way to advance
   * it through `runPlan` directly — a bare `runPlan(paused, deps)` returns the
   * snapshot unchanged.
   *
   * It also tells `persistPlanSnapshotGuarded` that the pause has been lifted by
   * a human, so a DURABLE `'paused'` status may be overwritten (a durable
   * `'cancelled'`/`'success'` stays pinned regardless — see there).
   */
  explicitResume?: boolean;
}

/** A node status that will not change again on its own (dependents may proceed). */
const TERMINAL: ReadonlySet<TaskNodeStatus> = new Set<TaskNodeStatus>([
  'success',
  'failed',
  'skipped',
  'cancelled',
]);

/** Is `status` terminal (the node will not run again on its own)? */
export function isTerminalStatus(status: TaskNodeStatus | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

/**
 * Persist a full plan snapshot through `deps.persistPlan` (or the deprecated
 * `deps.persist` alias) when either port is supplied.
 */
export async function persistPlanSnapshot(deps: PlanDeps, plan: TaskPlan): Promise<void> {
  const persist = deps.persistPlan ?? deps.persist;
  await persist?.(plan);
}

/** Options for `persistPlanSnapshotGuarded`. */
export interface GuardedPersistOptions {
  /**
   * The caller EXPLICITLY re-drove a paused plan (see `RunPlanOptions.explicitResume`):
   * a human already lifted the pause, so a durable `'paused'` status is NOT pinned.
   * A durable `'cancelled'`/`'success'` stays pinned regardless.
   */
  explicitResume?: boolean;
}

/** Plan statuses a concurrent control may have pinned durably (see `isPinnedDurableStatus`). */
const PINNED_PLAN_STATUSES: ReadonlySet<TaskPlanStatus> = new Set<TaskPlanStatus>(['cancelled', 'success']);

/** Is `status` a durable status this run must not overwrite? */
function isPinnedDurableStatus(status: TaskPlanStatus, opts: GuardedPersistOptions): boolean {
  if (status === 'paused') return opts.explicitResume !== true;
  return PINNED_PLAN_STATUSES.has(status);
}

/**
 * Persist a full plan snapshot WITHOUT clobbering a plan status a concurrent
 * control pinned durably.
 *
 * `runPlan` writes the FULL snapshot exactly twice (up-front `'running'` and at
 * settlement); every other plan mutation writes only the affected NODE row. When
 * `deps.loadPlan` is supplied, this helper reads the durable snapshot first and
 * SKIPS the write if the durable status is pinned (`'cancelled'`/`'success'`, or
 * `'paused'` unless `explicitResume`) and differs from the snapshot's status: the
 * concurrent control wins, so a stale run never downgrades a cancelled plan back
 * to a non-terminal state (nor settles a plan a human just paused).
 *
 * The atomic compare-and-set for a concurrent pause/cancel belongs to the
 * caller's `persistPlan` port (e.g. a guarded `claimTaskStatus` transition) —
 * this is only the planner-side guard that avoids INITIATING the downgrade.
 * Without `deps.loadPlan` it behaves exactly like `persistPlanSnapshot`.
 */
export async function persistPlanSnapshotGuarded(
  deps: PlanDeps,
  plan: TaskPlan,
  opts: GuardedPersistOptions = {},
): Promise<void> {
  const loadPlan = deps.loadPlan;
  if (loadPlan !== undefined) {
    const durable = await loadPlan(plan.id);
    if (durable && durable.status !== plan.status && isPinnedDurableStatus(durable.status, opts)) return;
  }
  await persistPlanSnapshot(deps, plan);
}

/**
 * Execute a plan to settlement and return its final snapshot.
 *
 * - Node statuses transition `pending → running → success | failed |
 *   waiting_confirmation | waiting_verification | cancelled | skipped`.
 * - A `condition` node evaluating `false` marks its transitive dependents `skipped`.
 * - A failing node is recorded as `failed`; the executor NEVER throws on a single
 *   node failure and continues independent branches.
 * - A node that is ALREADY terminal (`success`/`failed`/`skipped`/`cancelled`) in
 *   the input plan is never re-executed (idempotency) — its recorded result is
 *   kept, so a paused/parked plan resumes by re-invoking `runPlan`.
 * - A NON-RUNNABLE plan is returned UNCHANGED without running a node: a
 *   `'cancelled'` or `'success'` plan (both terminal) and a `'paused'` plan (unless
 *   `opts.explicitResume` is set — the ONLY way to advance a paused snapshot
 *   directly). Nothing is persisted in those cases.
 * - `deps.persistPlan ?? deps.persist` is called after each mutation, and
 *   `deps.persistNode` on every node status change, when provided.
 *
 * Assumes a VALIDATED plan (call `validatePlan` first — `submit_plan` does); this
 * function does not re-validate. The input `plan` is never mutated: every emitted
 * / returned state is a fresh snapshot with a copy of the results array.
 *
 * Controls (all cooperative, consulted at each node checkpoint):
 * - `pause()` (in-process) or a durable `{ kind:'pause' }` from
 *   `deps.controls.pollControls(planId)` STOP the walk and RETURN a resumable
 *   snapshot (`status:'paused'`, un-run nodes still `pending`, already-run nodes
 *   `success`). Resumption is done by re-invoking `runPlan` with
 *   `explicitResume:true` (or via `resumePlan`). `PlanControls.resume()` only
 *   clears the in-process pause flag.
 * - `cancel()` and `opts.signal` abort the walk, marking EVERY not-yet-terminal node
 *   `cancelled` and settling the plan `cancelled`.
 * - `retry(nodeId)` resets that node and its transitive dependents to `pending`
 *   (never a node that already succeeded) and rewinds the walk to the earliest
 *   such node, so they re-run on the next checkpoints (re-invoking `runTool`).
 *   Requests are de-duplicated per pass.
 */
export async function runPlan(plan: TaskPlan, deps: PlanDeps, opts: RunPlanOptions = {}): Promise<TaskPlan> {
  const now = opts.now ?? (() => demoNow());
  const signal = opts.signal;

  /**
   * A fresh copy of the input snapshot, returned when the plan is NOT runnable
   * (cancelled / paused / already settled): no node runs and nothing is persisted.
   */
  const passthrough = (): TaskPlan => ({
    ...plan,
    results: plan.results.map((r) => ({ ...r })),
    updatedAt: now(),
  });

  // A plan is runnable only from a live status. Three non-runnable snapshots are
  // returned UNCHANGED — the recorded plan status and node results are preserved:

  // 1. Idempotency: a CANCELLED plan is terminal. Re-invoking `runPlan` on it must
  //    never resurrect nodes nor re-execute a node that already succeeded.
  if (plan.status === 'cancelled') return passthrough();

  // 2. A PAUSED plan is never advanced silently — a bare `runPlan(paused, deps)`
  //    would run the dependents of the pause with no human decision behind it.
  //    Lifting the pause requires `opts.explicitResume` (or `lifecycle.resumePlan`).
  if (plan.status === 'paused' && opts.explicitResume !== true) return passthrough();

  // 3. A SUCCESS plan is terminal: every node settled, nothing is left to run.
  if (plan.status === 'success') return passthrough();
  const byId = new Map<string, TaskNodeSpec>();
  for (const node of plan.nodes) byId.set(node.id, node);

  const order = topologicalOrder(plan.nodes);
  const positionOf = new Map<string, number>();
  order.forEach((node, i) => positionOf.set(node.id, i));

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

  /**
   * Record a node result: notify the listener and persist the affected NODE row.
   *
   * Deliberately does NOT re-write the whole plan snapshot. The plan status is
   * written ONCE at the start ('running') and ONCE at settlement (see the walk).
   * Rewriting it on every node mutation would CLOBBER a durable control status
   * written out-of-process during the run — e.g. `POST /api/tasks/:id`
   * `{action:'pause'}` sets the persisted plan status to 'paused', which the next
   * `checkpoint()` must observe via `deps.controls`; a mid-run
   * `persistPlan({status:'running'})` would erase it and the walk would wrongly
   * start the next node. Node-level progress is still persisted incrementally
   * (`deps.persistNode`), so a live UI keeps per-node status.
   */
  const setNode = async (result: TaskNodeResult): Promise<void> => {
    results.set(result.id, { ...result });
    await deps.onNodeUpdate({ ...result });
    await deps.persistNode?.(plan.id, { ...result });
    // (the full plan snapshot is NOT re-persisted per node — see the walk below)
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
  const retryRequests = new Set<string>();

  const onAbort = (): void => {
    aborted = true;
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
    // Clears the in-process pause flag only. Durable resumption of a paused plan
    // is done by re-invoking `runPlan` / `resumePlan` (see `planner/lifecycle.ts`).
    resume() {
      paused = false;
    },
    cancel() {
      cancelled = true;
    },
    retry(nodeId) {
      retryRequests.add(nodeId);
    },
  };

  /**
   * Poll the durable control port (READ-AND-CLEAR per its contract) and apply
   * the commands to this run's flags. No-op when `deps.controls` is absent.
   */
  const pollDurableControls = async (): Promise<void> => {
    if (!deps.controls) return;
    const commands = await deps.controls.pollControls(plan.id);
    for (const command of commands ?? []) {
      if (!command || typeof command !== 'object') continue;
      if (command.kind === 'pause') {
        if (!stopRequested()) paused = true;
      } else if (command.kind === 'cancel') {
        cancelled = true;
      } else if (command.kind === 'retry' && typeof command.nodeId === 'string') {
        retryRequests.add(command.nodeId);
      }
    }
  };

  /** Node checkpoint: refresh the abort flag and poll any durable controls. */
  const checkpoint = async (): Promise<void> => {
    if (signal?.aborted) aborted = true;
    await pollDurableControls();
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

  // Persist the running status ONCE up front (and again at settlement). Mid-run
  // node mutations only touch the affected NODE rows (`persistNode`), so they
  // never clobber a durable `paused`/`cancelled` written out-of-process during
  // the run — which the next `checkpoint()`'s `deps.controls` poll must observe.
  // The GUARDED write additionally refuses to overwrite a plan status a
  // concurrent control pinned durably (see `persistPlanSnapshotGuarded`).
  await persistPlanSnapshotGuarded(deps, snapshot(), { explicitResume: opts.explicitResume });

  let stopped = false;
  let parked = false;
  let wasPaused = false;

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

      // Pause: STOP launching further nodes and RETURN a resumable snapshot.
      if (paused) {
        wasPaused = true;
        break;
      }

      // Cooperative retry: reset affected nodes + rewind to the earliest.
      // Idempotency: a node that already succeeded is NEVER reset/re-run.
      if (retryRequests.size > 0) {
        let rewindTo = index;
        let anyReset = false;
        for (const id of retryRequests) {
          for (const affected of [id, ...transitiveDependents(plan.nodes, id)]) {
            const node = byId.get(affected);
            if (!node) continue;
            if (results.get(affected)?.status === 'success') continue;
            await setNode({
              id: affected,
              name: node.name,
              status: 'pending',
              tool: node.kind === 'tool' ? node.tool : undefined,
            });
            anyReset = true;
          }
          const pos = positionOf.get(id);
          if (pos !== undefined && pos < rewindTo) rewindTo = pos;
        }
        retryRequests.clear();
        if (anyReset) index = rewindTo;
        continue;
      }

      const node = order[index];
      const existing = results.get(node.id);

      // Already settled in a prior pass/run — leave the recorded result intact.
      if (existing && TERMINAL.has(existing.status)) {
        index += 1;
        continue;
      }

      // Transitive skip propagation: a dependency that did not succeed (skipped,
      // failed or cancelled) blocks this node too, so it becomes skipped.
      const depBlocked = node.dependencies.some((dep) => {
        const depStatus = results.get(dep)?.status;
        return depStatus === 'skipped' || depStatus === 'failed' || depStatus === 'cancelled';
      });
      if (depBlocked) {
        await markSkipped(node.id, 'dependency did not succeed');
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
          for (const dependent of transitiveDependents(plan.nodes, node.id)) {
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
    // A cancellation (in-process `cancel()`, durable `{kind:'cancel'}` or an
    // `opts.signal` abort) halts the whole walk: sweep the topological order and
    // cancel EVERY not-yet-terminal node, so nothing dangles as `pending`. A
    // gated park is NOT a cancellation — its dependents stay `pending` (below).
    for (const node of order) {
      if (!isTerminalStatus(results.get(node.id)?.status)) await cancelNode(node);
    }
    planStatus = 'cancelled';
  } else if (parked) {
    planStatus = 'waiting_confirmation';
  } else if (wasPaused) {
    // A pause (in-process `pause()` or durable `{kind:'pause'}`) halts the walk
    // but does NOT settle the plan: it stays resumable with `status:'paused'`.
    planStatus = 'paused';
  } else {
    const allSettled = plan.nodes.every((node) => {
      const status = results.get(node.id)?.status;
      return status === 'success' || status === 'skipped';
    });
    planStatus = allSettled ? 'success' : 'failed';
  }

  const final = snapshot();
  await persistPlanSnapshotGuarded(deps, final, { explicitResume: opts.explicitResume });
  return final;
}

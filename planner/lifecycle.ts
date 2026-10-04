/**
 * planner/lifecycle.ts — Durable control & resume entry points.
 *
 * `executor.runPlan` is a single in-process walk: it can pause, park and settle,
 * but it holds no cross-request state. These helpers add the *durable* lifecycle
 * on top of it — pause / cancel (+compensation) / retry / resume — each of which
 * returns a fresh `TaskPlan` snapshot and (when a `PlanDeps` is supplied) drives
 * the caller's persistence ports. They contain NO banking / security / DB logic:
 * every side effect is injected through `PlanDeps` / the options.
 *
 * A plan is resumed by RE-INVOKING `runPlan` on its snapshot: `runPlan` skips
 * every terminal node (idempotency) and only launches the now-unblocked
 * dependents. Nothing here re-executes a node that already succeeded.
 */
import type { TaskNodeResult, TaskNodeStatus, TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import { AppError } from '@/lib/errors';
import { demoNow } from '@/lib/clock';
import { transitiveDependents } from './dag';
import {
  isTerminalStatus,
  persistPlanSnapshot,
  runPlan,
  type PlanDeps,
  type PlanToolOutcome,
  type RunPlanOptions,
} from './executor';

/**
 * The record written to every CANCELLED node's `output`: it names the nodes that
 * already executed (irreversible under the simulated backend) so the
 * executed/irreversible set is persisted alongside the cancellation.
 */
export interface PlanCancellation {
  cancelled: true;
  reason: string;
  executedNodes: string[];
}

/** Options for `pausePlan`. */
export interface PausePlanOptions {
  /** Injectable clock; defaults to the demo clock (`demoNow`). */
  now?: () => number;
}

/** Options for `cancelPlan`. */
export interface CancelPlanOptions {
  /** Human-readable cancellation reason (recorded on each cancelled node). */
  reason?: string;
  /** Injectable clock; defaults to the demo clock (`demoNow`). */
  now?: () => number;
}

/** Options for `retryPlan` (a superset of `RunPlanOptions` plus the retry targets). */
export interface RetryPlanOptions extends RunPlanOptions {
  /** Nodes to retry; defaults to every node currently `failed`. */
  nodeIds?: string[];
}

/** The human decision to apply when resuming a gated (`waiting_confirmation`/`waiting_verification`) node. */
export interface ResumeInput {
  nodeId: string;
  outcome: PlanToolOutcome;
}

/** A pure compensation report: which nodes executed, were skipped, or were cancelled. */
export interface CompensationReport {
  planId: string;
  cancelledAt: number;
  /** Ids of nodes whose status is `success` (they executed — irreversible). */
  executed: string[];
  /** Ids of nodes whose status is `skipped` (their branch intentionally did not run). */
  skipped: string[];
  /** Ids of nodes whose status is `cancelled`. */
  cancelledNodes: string[];
}

/** Build a full `TaskPlan` snapshot from a working results map (declaration order). */
function snapshotWith(
  plan: TaskPlan,
  results: Map<string, TaskNodeResult>,
  status: TaskPlanStatus,
  updatedAt: number,
): TaskPlan {
  return {
    id: plan.id,
    sessionId: plan.sessionId,
    goal: plan.goal,
    status,
    nodes: plan.nodes,
    results: plan.nodes.map((n) => {
      const r = results.get(n.id);
      if (r) return { ...r };
      return {
        id: n.id,
        name: n.name,
        status: 'pending' as TaskNodeStatus,
        tool: n.kind === 'tool' ? n.tool : undefined,
      };
    }),
    createdAt: plan.createdAt,
    updatedAt,
  };
}

/**
 * Mark a plan PAUSED. `TaskPlanStatus` has no `'paused'`, so a paused plan is
 * returned with `status:'pending'`: its un-run nodes stay `pending` and its
 * already-successful nodes keep their `success` result (resumable by re-invoking
 * `runPlan` / `resumePlan`).
 */
export function pausePlan(plan: TaskPlan, opts: PausePlanOptions = {}): TaskPlan {
  const now = opts.now ?? (() => demoNow());
  return { ...plan, status: 'pending', updatedAt: now() };
}

/**
 * Pure compensation report over a plan snapshot: classifies every node by its
 * recorded result so the caller can see exactly what executed before a halt.
 * Never mutates the plan; missing results are treated as not-executed.
 */
export function compensationReport(plan: TaskPlan, cancelledAt?: number): CompensationReport {
  const executed: string[] = [];
  const skipped: string[] = [];
  const cancelledNodes: string[] = [];
  const statusById = new Map<string, TaskNodeStatus>();
  for (const r of plan.results) statusById.set(r.id, r.status);

  for (const node of plan.nodes) {
    const status = statusById.get(node.id);
    if (status === 'success') executed.push(node.id);
    else if (status === 'skipped') skipped.push(node.id);
    else if (status === 'cancelled') cancelledNodes.push(node.id);
  }

  return {
    planId: plan.id,
    cancelledAt: cancelledAt ?? demoNow(),
    executed,
    skipped,
    cancelledNodes,
  };
}

/**
 * Halt a plan. Terminal nodes (`success`/`failed`/`skipped`/`cancelled`) keep
 * their status — `success` nodes already executed and are irreversible under the
 * simulated backend. Every remaining non-terminal node becomes `cancelled` with
 * `output = { cancelled: true, reason, executedNodes }`, so the executed set is
 * recorded durably through node persistence. The plan settles `cancelled`.
 *
 * Cancelling NEVER re-executes a successful node. When `deps` is supplied the
 * cancellations and the final snapshot are persisted; `deps` may be omitted for
 * a pure in-memory cancellation.
 */
export async function cancelPlan(
  plan: TaskPlan,
  deps?: PlanDeps,
  opts: CancelPlanOptions = {},
): Promise<TaskPlan> {
  const now = opts.now ?? (() => demoNow());
  const reason = opts.reason ?? 'cancelled by user';

  const results = new Map<string, TaskNodeResult>();
  for (const r of plan.results) results.set(r.id, { ...r });

  const executedNodes = plan.nodes
    .filter((n) => results.get(n.id)?.status === 'success')
    .map((n) => n.id);
  const output: PlanCancellation = { cancelled: true, reason, executedNodes };

  const changed: TaskNodeResult[] = [];
  for (const node of plan.nodes) {
    const existing = results.get(node.id);
    if (isTerminalStatus(existing?.status)) continue; // keep success/failed/skipped/cancelled
    const cancelled: TaskNodeResult = {
      id: node.id,
      name: node.name,
      status: 'cancelled',
      tool: node.kind === 'tool' ? node.tool : undefined,
      output,
      startedAt: existing?.startedAt,
      endedAt: now(),
    };
    results.set(node.id, cancelled);
    changed.push(cancelled);
  }

  for (const node of changed) {
    await deps?.onNodeUpdate({ ...node });
    await deps?.persistNode?.(plan.id, { ...node });
  }

  const snapshot = snapshotWith(plan, results, 'cancelled', now());
  if (deps) await persistPlanSnapshot(deps, snapshot);
  return snapshot;
}

/**
 * Retry the `failed` nodes (or the explicit `opts.nodeIds`) plus their
 * not-yet-satisfied descendants: the targeted nodes and every transitive
 * dependent whose status is `failed`/`skipped`/`pending` (or absent) are reset
 * to `pending`, then the plan is re-run through `runPlan`.
 *
 * A node that already `success` is NEVER reset/re-run (idempotency). When there
 * is nothing to retry (no target, or no resettable node) the plan is returned
 * UNCHANGED.
 */
export async function retryPlan(
  plan: TaskPlan,
  deps: PlanDeps,
  opts: RetryPlanOptions = {},
): Promise<TaskPlan> {
  const now = opts.now ?? (() => demoNow());

  const results = new Map<string, TaskNodeResult>();
  for (const r of plan.results) results.set(r.id, { ...r });
  const nodesById = new Map(plan.nodes.map((n) => [n.id, n]));

  const targets =
    opts.nodeIds && opts.nodeIds.length > 0
      ? opts.nodeIds.filter((id) => nodesById.has(id))
      : plan.nodes.filter((n) => results.get(n.id)?.status === 'failed').map((n) => n.id);

  if (targets.length === 0) return plan; // nothing to retry

  const resetIds = new Set<string>();
  for (const id of targets) {
    resetIds.add(id);
    for (const dependent of transitiveDependents(plan.nodes, id)) resetIds.add(dependent);
  }

  const reset: TaskNodeResult[] = [];
  for (const id of resetIds) {
    const node = nodesById.get(id);
    if (!node) continue;
    const status = results.get(id)?.status;
    // Reset ONLY failed/skipped/pending nodes — never an already-successful one.
    const resettable =
      status === undefined || status === 'pending' || status === 'failed' || status === 'skipped';
    if (!resettable) continue;
    const pending: TaskNodeResult = {
      id,
      name: node.name,
      status: 'pending',
      tool: node.kind === 'tool' ? node.tool : undefined,
    };
    results.set(id, pending);
    reset.push(pending);
  }

  if (reset.length === 0) return plan; // nothing resettable

  for (const node of reset) {
    await deps.onNodeUpdate({ ...node });
    await deps.persistNode?.(plan.id, { ...node });
  }
  const snapshot = snapshotWith(plan, results, 'pending', now());
  await persistPlanSnapshot(deps, snapshot);

  return runPlan(snapshot, deps, { now: opts.now, signal: opts.signal, onControls: opts.onControls });
}

/**
 * Apply a HUMAN decision to a gated node and continue the plan from there.
 *
 * - `outcome.ok` → the node becomes `success` (carrying `data`/`summary`);
 * - `outcome.requiresConfirmation` (or a `pendingActionId` with `ok:false`) →
 *   the node re-parks in `waiting_confirmation`/`waiting_verification` (recording
 *   `pendingActionId`) and NO further node runs;
 * - otherwise → the node becomes `failed` (carrying `error`).
 *
 * After a SUCCESSFUL decision the plan continues via `runPlan`, which skips every
 * already-successful node and runs only the now-unblocked dependents. Throws
 * `AppError('NOT_FOUND')` when `nodeId` is not a node of the plan.
 */
export async function resumePlan(
  plan: TaskPlan,
  resume: ResumeInput,
  deps: PlanDeps,
  opts: RunPlanOptions = {},
): Promise<TaskPlan> {
  const now = opts.now ?? (() => demoNow());
  const node = plan.nodes.find((n) => n.id === resume.nodeId);
  if (!node) throw new AppError('NOT_FOUND', `plan '${plan.id}' has no node '${resume.nodeId}'`);

  const outcome = resume.outcome;
  const results = new Map<string, TaskNodeResult>();
  for (const r of plan.results) results.set(r.id, { ...r });
  const previous = results.get(node.id);

  let status: TaskNodeStatus;
  if (outcome.ok) {
    status = 'success';
  } else if (outcome.requiresConfirmation || outcome.pendingActionId !== undefined) {
    const isRed = (node as { riskLevel?: unknown }).riskLevel === 'RED';
    status = isRed ? 'waiting_verification' : 'waiting_confirmation';
  } else {
    status = 'failed';
  }

  const updated: TaskNodeResult & { summary?: string; pendingActionId?: string } = {
    id: node.id,
    name: node.name,
    status,
    tool: node.tool,
    startedAt: previous?.startedAt ?? now(),
    endedAt: now(),
  };
  if (status === 'success') {
    let output = outcome.data;
    if (output === undefined && outcome.summary !== undefined) output = { summary: outcome.summary };
    updated.output = output;
    if (outcome.summary !== undefined) updated.summary = outcome.summary;
  } else if (status === 'failed') {
    updated.error = outcome.error ?? `tool '${node.tool ?? node.id}' failed`;
  } else {
    updated.output =
      outcome.pendingActionId !== undefined ? { pendingActionId: outcome.pendingActionId } : undefined;
    updated.error = outcome.error;
    if (outcome.pendingActionId !== undefined) updated.pendingActionId = outcome.pendingActionId;
  }

  results.set(node.id, updated);
  await deps.onNodeUpdate({ ...updated });
  await deps.persistNode?.(plan.id, { ...updated });

  const planStatus: TaskPlanStatus =
    status === 'waiting_confirmation' || status === 'waiting_verification'
      ? 'waiting_confirmation'
      : status === 'failed'
        ? 'failed'
        : 'running';
  const snapshot = snapshotWith(plan, results, planStatus, now());
  await persistPlanSnapshot(deps, snapshot);

  // A re-parked node has NOT been decided — wait for the next human decision.
  if (status === 'waiting_confirmation' || status === 'waiting_verification') return snapshot;

  // A satisfied (or hard-failed) decision continues the walk; `runPlan` skips
  // every already-successful node and only launches the unblocked dependents.
  return runPlan(snapshot, deps, opts);
}

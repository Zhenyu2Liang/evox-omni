/**
 * planner/dag.ts — Pure DAG operations for the task planner.
 *
 * No side effects, no I/O: validates, orders, and evaluates plan graphs.
 * Tool execution, persistence and the clock are injected by the caller
 * (see `executor.ts` / `PlanDeps`). Deterministic: `buildPlan` accepts an
 * injectable `now` and `id` so tests stay reproducible.
 *
 * Only depends on the frozen shared contracts (`lib/contracts/task`) and the
 * project error convention (`lib/errors`). Never imports banking-sdk / security
 * / agent / audit / prisma.
 */
import type { TaskCondition, TaskNodeResult, TaskNodeSpec, TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { AppError, err, ok, type Result } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { demoNow } from '@/lib/clock';

/**
 * A node status that means "this node will not change again on its own and its
 * dependents may proceed": success / failed / skipped / cancelled. Statuses
 * still in flight (pending / running / waiting_confirmation / waiting_verification)
 * are NOT terminal.
 */
const TERMINAL_NODE_STATUSES: ReadonlySet<TaskNodeStatus> = new Set<TaskNodeStatus>([
  'success',
  'failed',
  'skipped',
  'cancelled',
]);

/**
 * Input to `buildPlan`. `now` and `id` are injectable for deterministic tests;
 * in production they default to the demo clock and a generated id.
 */
export interface BuildPlanInput {
  sessionId: string;
  goal: string;
  nodes: TaskNodeSpec[];
  now?: () => number;
  id?: string;
}

/**
 * Validate a plan graph against the set of registered tool names.
 *
 * Detects (returning `err(new AppError('VALIDATION', ...))`):
 *  - duplicate node ids;
 *  - nodes with a missing/blank `id` or `name` (malformed);
 *  - unknown tools referenced by `kind: 'tool'` nodes (not in `knownTools`);
 *  - malformed nodes (`tool` node without a tool, `condition` node without a condition);
 *  - dependencies pointing at non-existent node ids;
 *  - cycles in the dependency graph.
 *
 * Returns `ok(undefined)` for a well-formed, acyclic plan. All detected problems
 * are collected into a single message (and the raw list in `detail`) so callers
 * can surface everything at once.
 */
export function validatePlan(nodes: TaskNodeSpec[], knownTools: Set<string>): Result<void> {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const knownIds = new Set<string>();

  // Pass 1 — structural: node identity + naming.
  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      problems.push('a plan node is null/undefined');
      continue;
    }
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (id === '') {
      problems.push('a node has a missing or blank id');
    } else if (seenIds.has(id)) {
      problems.push(`duplicate node id '${id}'`);
    } else {
      seenIds.add(id);
      knownIds.add(id);
    }
    if (typeof node.name !== 'string' || node.name.trim() === '') {
      problems.push(`node '${id || '?'}' has a missing or blank name`);
    }
  }

  // Pass 2 — node payloads + dependency references.
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const label = typeof node.id === 'string' && node.id.trim() !== '' ? node.id : '?';

    if (node.kind === 'tool') {
      if (typeof node.tool !== 'string' || node.tool.trim() === '') {
        problems.push(`tool node '${label}' is missing a 'tool'`);
      } else if (!knownTools.has(node.tool)) {
        problems.push(`tool node '${label}' references unknown tool '${node.tool}'`);
      }
    } else if (node.kind === 'condition') {
      if (!node.condition || typeof node.condition !== 'object') {
        problems.push(`condition node '${label}' is missing a 'condition'`);
      }
    } else if (node.kind !== 'note') {
      problems.push(`node '${label}' has an unsupported kind '${String(node.kind)}'`);
    }

    const deps = Array.isArray(node.dependencies) ? node.dependencies : [];
    for (const dep of deps) {
      if (!knownIds.has(dep)) problems.push(`node '${label}' depends on unknown node '${dep}'`);
    }
  }

  if (problems.length > 0) return err(new AppError('VALIDATION', problems.join('; '), problems));

  // Pass 3 — cycles. `topologicalOrder` throws `AppError('VALIDATION')` on a cycle.
  try {
    topologicalOrder(nodes);
  } catch (e) {
    problems.push(AppError.from(e).message);
    return err(new AppError('VALIDATION', problems.join('; '), problems));
  }

  return ok(undefined);
}

/**
 * Return nodes in deterministic topological order (stable by declaration order
 * among nodes with equal readiness — i.e. a Kahn walk whose "ready" frontier is
 * a priority queue keyed by the node's position in the input array).
 *
 * Assumes the graph is acyclic and has unique ids — callers validate first via
 * `validatePlan`. Throws `AppError('VALIDATION')` on cycles. Never mutates the
 * input array (returns the original node references).
 */
export function topologicalOrder(nodes: TaskNodeSpec[]): TaskNodeSpec[] {
  const byId = new Map<string, TaskNodeSpec>();
  const indexOf = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (!byId.has(n.id)) {
      byId.set(n.id, n);
      indexOf.set(n.id, i);
    }
  });

  const indegree = new Map<string, number>();
  for (const n of nodes) {
    if (!byId.has(n.id)) continue;
    if (indegree.has(n.id)) continue;
    let deg = 0;
    for (const d of n.dependencies) if (byId.has(d)) deg += 1;
    indegree.set(n.id, deg);
  }

  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    if (!byId.has(n.id)) continue;
    for (const d of n.dependencies) {
      if (!byId.has(d)) continue;
      const arr = dependents.get(d);
      if (arr) arr.push(n.id);
      else dependents.set(d, [n.id]);
    }
  }

  // Ready frontier, kept in declaration order (ascending input index).
  const ready: string[] = [];
  const queued = new Set<string>();
  for (const n of nodes) {
    if (queued.has(n.id)) continue;
    if ((indegree.get(n.id) ?? 0) === 0) {
      queued.add(n.id);
      ready.push(n.id);
    }
  }

  const ordered: TaskNodeSpec[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const node = byId.get(id);
    if (node) ordered.push(node);

    for (const dep of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, remaining);
      if (remaining === 0 && !queued.has(dep)) {
        queued.add(dep);
        const pos = indexOf.get(dep) ?? Number.MAX_SAFE_INTEGER;
        let at = ready.length;
        for (let k = 0; k < ready.length; k += 1) {
          if ((indexOf.get(ready[k]) ?? Number.MAX_SAFE_INTEGER) > pos) {
            at = k;
            break;
          }
        }
        ready.splice(at, 0, dep);
      }
    }
  }

  if (ordered.length !== byId.size) {
    throw new AppError(
      'VALIDATION',
      `plan dependency graph contains a cycle (${ordered.length} of ${byId.size} nodes ordered)`,
    );
  }

  return ordered;
}

/**
 * Return the nodes that are ready to execute given the current `results`:
 * nodes not yet resolved (`pending`, or absent from `results`) whose every
 * dependency has reached a terminal state (`success | failed | skipped | cancelled`).
 *
 * A dependency still `pending` / `running` / `waiting_confirmation` /
 * `waiting_verification` means its dependents are NOT ready. Declaration order
 * is preserved. Used by the executor to walk the DAG incrementally and by retry
 * logic to find re-runnable nodes.
 */
export function getReadyNodes(nodes: TaskNodeSpec[], results: TaskNodeResult[]): TaskNodeSpec[] {
  const statusById = new Map<string, TaskNodeStatus>();
  for (const r of results) statusById.set(r.id, r.status);

  const ready: TaskNodeSpec[] = [];
  for (const node of nodes) {
    const status = statusById.get(node.id);
    if (status !== undefined && status !== 'pending') continue; // already resolved
    const depsTerminal = node.dependencies.every((dep) => {
      const depStatus = statusById.get(dep);
      return depStatus !== undefined && TERMINAL_NODE_STATUSES.has(depStatus);
    });
    if (depsTerminal) ready.push(node);
  }
  return ready;
}

/** Coerce a primitive to a finite number, or `undefined` when it is not numeric. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Is `value` a comparable primitive (`number` | `string` | `boolean`)? */
function isPrimitive(value: unknown): value is number | string | boolean {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
}

/**
 * Equality between two primitives, with a safe numeric-string bridge
 * (`'42' == 42`). Any non-primitive or genuinely mismatched pair is
 * `{ comparable: false }` — callers then return `false` (never throw).
 */
function safeEquals(left: unknown, right: unknown): { comparable: boolean; equal: boolean } {
  if (!isPrimitive(left) || !isPrimitive(right)) return { comparable: false, equal: false };
  if (typeof left === typeof right) return { comparable: true, equal: left === right };
  const ln = toNumber(left);
  const rn = toNumber(right);
  if (ln !== undefined && rn !== undefined) return { comparable: true, equal: ln === rn };
  return { comparable: false, equal: false };
}

/** Resolve a dot-path (`a.b.c`) into `scope`; `{ found:false }` on any miss/null. */
function resolvePath(scope: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  if (typeof path !== 'string' || path === '') return { found: false, value: undefined };
  const parts = path.split('.');
  let current: unknown = scope;
  for (const part of parts) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (typeof current !== 'object') return { found: false, value: undefined };
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return { found: false, value: undefined };
      current = current[idx];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined || current === null) return { found: false, value: undefined };
  return { found: true, value: current };
}

/**
 * Evaluate a `TaskCondition` against a scope built from prior node outputs.
 * `condition.path` is a dot-path (e.g. `analyze_entertainment.total`) resolved
 * against `scope`; a missing path (or a traversal through a null/undefined/
 * non-object) resolves to `false`.
 *
 * Comparison uses `op` (`> >= < <= == !=`):
 *  - numeric ops coerce numbers and numeric strings to `number`; an
 *    incomparable pair (non-numeric, missing, object/array) yields `false`;
 *  - `==`/`!=` compare equal-typed primitives (with a numeric-string bridge for
 *    `'42' == 42`); an incomparable/mismatched pair yields `false` (for both ops).
 *
 * Pure and TOTAL: never throws on type mismatch, missing keys, non-objects or arrays.
 */
export function evaluateCondition(condition: TaskCondition, scope: Record<string, unknown>): boolean {
  if (!condition || typeof condition !== 'object') return false;
  const resolved = resolvePath(scope ?? {}, condition.path);
  if (!resolved.found) return false;

  const left = resolved.value;
  const right = condition.value;

  switch (condition.op) {
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (ln === undefined || rn === undefined) return false;
      if (condition.op === '>') return ln > rn;
      if (condition.op === '>=') return ln >= rn;
      if (condition.op === '<') return ln < rn;
      return ln <= rn;
    }
    case '==': {
      const eq = safeEquals(left, right);
      return eq.comparable ? eq.equal : false;
    }
    case '!=': {
      const eq = safeEquals(left, right);
      return eq.comparable ? !eq.equal : false;
    }
    default:
      return false;
  }
}

/**
 * Assemble an initial `TaskPlan` from the LLM-proposed nodes:
 * status `pending`, empty `results`, `createdAt === updatedAt === now()`.
 * Does NOT validate — call `validatePlan` first (the `submit_plan` tool does).
 */
export function buildPlan(input: BuildPlanInput): TaskPlan {
  const timestamp = input.now ? input.now() : demoNow();
  return {
    id: input.id ?? newId('plan'),
    sessionId: input.sessionId,
    goal: input.goal,
    status: 'pending',
    nodes: input.nodes,
    results: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

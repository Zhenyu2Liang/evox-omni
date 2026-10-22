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
import { outputFieldAt, type ToolOutputContracts } from '@/lib/contracts/tool-output';
import { compareDecimal } from '@/lib/decimal';

/**
 * A hard dependency unlocks its dependents only after success. A skipped,
 * failed, cancelled, or in-flight dependency leaves its dependents not ready.
 * Ordering-only predecessors use `after` and require a terminal status.
 */
const READY_DEP_STATUSES: ReadonlySet<TaskNodeStatus> = new Set<TaskNodeStatus>(['success']);

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

/** Redemption口径 a plan node must state explicitly — the planner never picks one for the caller. */
const REDEEM_MODES: ReadonlySet<string> = new Set(['SHARES', 'AMOUNT', 'ALL']);

/**
 * Why a `redeem_investment` node cannot be executed as written, or `undefined` when its口径 is
 * explicit and unambiguous (`docs/cn/investments.md`: 按份额 / 按金额 / 全额, never inferred).
 *
 * A node carrying only an `amount` or only a `shares` states no口径, so the executor would have to
 * guess one — exactly what the contract forbids. The retired principal field `redeemAmount` and a
 * mixed口径 are refused for the same reason.
 */
function redeemModeProblem(args: unknown): string | undefined {
  const nodeArgs: Record<string, unknown> = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  if (nodeArgs.redeemAmount !== undefined) {
    return '使用已废止的 redeemAmount，赎回需要显式口径 mode（SHARES/AMOUNT/ALL）';
  }
  const mode = nodeArgs.mode;
  if (mode === undefined || mode === null || mode === '') {
    return '的赎回缺少显式口径 mode（SHARES/AMOUNT/ALL）：仅给出金额或份额不足以确定赎回口径';
  }
  if (typeof mode !== 'string' || !REDEEM_MODES.has(mode)) {
    return `的赎回口径 mode 必须是 SHARES/AMOUNT/ALL，实际为 '${String(mode)}'`;
  }
  const mixed = mode === 'SHARES'
    ? nodeArgs.amount !== undefined
    : mode === 'AMOUNT'
      ? nodeArgs.shares !== undefined
      : nodeArgs.shares !== undefined || nodeArgs.amount !== undefined;
  if (mixed) {
    return `的赎回口径 mode=${mode} 不可混用参数：SHARES 只接受 shares，AMOUNT 只接受 amount，ALL 不接受 shares/amount`;
  }
  return undefined;
}

/**
 * Validate a plan graph against the set of registered tool names.
 *
 * Detects (returning `err(new AppError('VALIDATION', ...))`):
 *  - duplicate node ids;
 *  - nodes with a missing/blank `id` or `name` (malformed);
 *  - unknown tools referenced by `kind: 'tool'` nodes (not in `knownTools`);
 *  - a `redeem_investment` node whose口径 (`mode`: SHARES/AMOUNT/ALL) is missing, unknown, retired
 *    (`redeemAmount`) or mixed with the other口径's parameter — the planner never guesses 口径;
 *  - malformed nodes (`tool` node without a tool, `condition` node without a condition);
 *  - dependencies pointing at non-existent node ids;
 *  - cycles in the dependency graph.
 *
 * Returns `ok(undefined)` for a well-formed, acyclic plan. All detected problems
 * are collected into a single message (and the raw list in `detail`) so callers
 * can surface everything at once.
 */
export function validatePlan(nodes: TaskNodeSpec[], knownTools: Set<string>, outputContracts?: ToolOutputContracts): Result<void> {
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
      } else if (node.tool === 'redeem_investment') {
        // 赎回口径只能由调用方显式给出（按份额 / 按金额 / 全额）：server 在这里挡住需要猜口径的节点。
        const redeemProblem = redeemModeProblem(node.args);
        if (redeemProblem) problems.push(`tool node '${label}' ${redeemProblem}`);
      }
    } else if (node.kind === 'condition') {
      if (!node.condition || typeof node.condition !== 'object') {
        problems.push(`condition node '${label}' is missing a 'condition'`);
      } else {
        const condition = node.condition;
        if (typeof condition.path !== 'string' || !condition.path.trim() ||
            !['>', '>=', '<', '<=', '==', '!='].includes(condition.op) ||
            !isPrimitive(condition.value) || (typeof condition.value === 'number' && !Number.isFinite(condition.value))) {
          problems.push(`condition node '${label}' requires a valid path/op/value`);
        }
      }
    } else if (node.kind !== 'note') {
      problems.push(`node '${label}' has an unsupported kind '${String(node.kind)}'`);
    }

    if (!Array.isArray(node.dependencies) || !node.dependencies.every(id => typeof id === 'string')) {
      problems.push(`node '${label}' has invalid dependencies`);
    }
    if (node.after !== undefined && (!Array.isArray(node.after) || !node.after.every(id => typeof id === 'string'))) {
      problems.push(`node '${label}' has invalid ordering predecessors`);
    }
    const deps = [...(Array.isArray(node.dependencies) ? node.dependencies : []), ...(Array.isArray(node.after) ? node.after : [])];
    for (const dep of deps) {
      if (!knownIds.has(dep)) problems.push(`node '${label}' depends on unknown node '${dep}'`);
    }
  }

  if (problems.length > 0) return err(new AppError('VALIDATION', problems.join('; '), problems));

  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    if (node?.kind !== 'condition' || typeof node.condition?.path !== 'string') continue;
    const [sourceId, ...fieldPath] = node.condition.path.split('.');
    const source = byId.get(sourceId);
    if (!source || fieldPath.length === 0) {
      problems.push(`condition node '${node.id}' requires a reference to an existing node output field`);
      continue;
    }
    if (!transitiveDependents(nodes, sourceId).includes(node.id)) {
      problems.push(`condition node '${node.id}' must depend on its data source '${sourceId}'`);
    }
    const contract = source.kind === 'condition'
      ? { type: 'object' as const, fields: { result: { type: 'boolean' as const } } }
      : source.tool ? outputContracts?.[source.tool] : undefined;
    const field = contract ? outputFieldAt(contract, fieldPath) : undefined;
    if (outputContracts && !field) {
      problems.push(`condition node '${node.id}' references an unsupported output field '${node.condition.path}'`);
    } else if (field && ['>', '>=', '<', '<='].includes(node.condition.op)
      && !['decimal', 'number'].includes(field.type)) {
      problems.push(`condition node '${node.id}' requires a numeric output field for ordering comparison`);
    } else if (field && ['object', 'array'].includes(field.type)) {
      problems.push(`condition node '${node.id}' must reference a comparable scalar output field`);
    }
    if (field?.type === 'decimal' || field?.type === 'number') {
      try {
        const literal = node.condition.value;
        if (field.type === 'decimal' && typeof literal !== 'string') throw new Error('Expected exact decimal text.');
        if (field.type === 'number' && typeof literal !== 'number') throw new Error('Expected a numeric scalar.');
        if (typeof literal !== 'string' && typeof literal !== 'number') throw new Error('Expected a numeric literal.');
        compareDecimal(literal, 0);
      } catch {
        problems.push(`condition node '${node.id}' requires a valid decimal comparison value`);
      }
    } else if (field?.type === 'boolean' && typeof node.condition.value !== 'boolean') {
      problems.push(`condition node '${node.id}' requires a boolean comparison value`);
    } else if (field?.type === 'string' && typeof node.condition.value !== 'string') {
      problems.push(`condition node '${node.id}' requires a string comparison value`);
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
    for (const d of new Set([...n.dependencies, ...(n.after ?? [])])) if (byId.has(d)) deg += 1;
    indegree.set(n.id, deg);
  }

  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    if (!byId.has(n.id)) continue;
    for (const d of new Set([...n.dependencies, ...(n.after ?? [])])) {
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
 * Return the nodes that can execute given the current `results`: nodes not yet
 * resolved (`pending`, or absent from `results`) whose every hard dependency
 * succeeded and every ordering-only predecessor reached a terminal status.
 *
 * A dependency that was skipped, failed, or cancelled — like one still in flight
 * (`pending` / `running` / `waiting_confirmation` / `waiting_verification`) —
 * leaves its dependents NOT ready. Declaration order is preserved.
 *
 * Pure helper: it reads `nodes` + `results` and returns the ready subset
 * (returning the original node references); it performs no I/O and holds no
 * state.
 */
export function getReadyNodes(nodes: TaskNodeSpec[], results: TaskNodeResult[]): TaskNodeSpec[] {
  const statusById = new Map<string, TaskNodeStatus>();
  for (const r of results) statusById.set(r.id, r.status);

  const ready: TaskNodeSpec[] = [];
  for (const node of nodes) {
    const status = statusById.get(node.id);
    if (status !== undefined && status !== 'pending') continue; // already resolved
    const depsReady = node.dependencies.every((dep) => {
      const depStatus = statusById.get(dep);
      return depStatus !== undefined && READY_DEP_STATUSES.has(depStatus);
    });
    const orderReady = (node.after ?? []).every(dep => ['success', 'skipped', 'failed', 'cancelled'].includes(statusById.get(dep) ?? ''));
    if (depsReady && orderReady) ready.push(node);
  }
  return ready;
}

/**
 * Return the ids of every node that TRANSITIVELY depends on `id` — its direct
 * dependents, their dependents, and so on — in declaration order.
 *
 * BFS over the dependency graph built from `nodes`; a node reached through any
 * path is included exactly once. Pure helper: no I/O, no mutation. Shared by the
 * executor (skip propagation / cooperative retry) and the durable lifecycle
 * helpers (`retryPlan` / `cancelPlan` / compensation) instead of each carrying a
 * private copy.
 */
export function transitiveDependents(nodes: TaskNodeSpec[], id: string): string[] {
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependencies ?? []) {
      const arr = dependents.get(dep);
      if (arr) arr.push(node.id);
      else dependents.set(dep, [node.id]);
    }
  }

  const reachable = new Set<string>();
  const queue: string[] = [...(dependents.get(id) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const next of dependents.get(current) ?? []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }

  return nodes.filter((node) => reachable.has(node.id)).map((node) => node.id);
}

/** Validate decimal input without converting financial values to binary floating point. */
function toDecimal(value: unknown): string | number | bigint | undefined {
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') return undefined;
  try {
    compareDecimal(value, value);
    return value;
  } catch { return undefined; }
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
  const ln = toDecimal(left);
  const rn = toDecimal(right);
  if (ln !== undefined && rn !== undefined) return { comparable: true, equal: compareDecimal(ln, rn) === 0 };
  if (typeof left === typeof right) return { comparable: true, equal: left === right };
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
 *  - ordering ops compare exact aligned decimal coefficients; an
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
      const ln = toDecimal(left);
      const rn = toDecimal(right);
      if (ln === undefined || rn === undefined) return false;
      const comparison = compareDecimal(ln, rn);
      if (condition.op === '>') return comparison > 0;
      if (condition.op === '>=') return comparison >= 0;
      if (condition.op === '<') return comparison < 0;
      return comparison <= 0;
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

/** A missing/non-comparable output is an execution error, not a false business condition. */
export function assertConditionResolvable(condition: TaskCondition, scope: Record<string, unknown>): void {
  const result = resolvePath(scope, condition.path);
  if (!result.found || (['>', '>=', '<', '<='].includes(condition.op)
    ? toDecimal(result.value) === undefined || toDecimal(condition.value) === undefined
    : !safeEquals(result.value, condition.value).comparable)) {
    throw new AppError('VALIDATION', `Condition output is missing or incomparable: ${condition.path}`);
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

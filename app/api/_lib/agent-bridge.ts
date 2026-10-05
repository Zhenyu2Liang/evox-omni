/**
 * app/api/_lib/agent-bridge.ts — the ONE module that knows about the agent's control/ownership API.
 *
 * Route handlers stay thin (`validate (zod) → delegate → serialize`); the tricky bits live here:
 *  - **Task execution control** (`pause` | `resume` | `cancel` | `retry`) and the **plan lookup**
 *    (`findTaskByPendingAction` / `getTaskPlan`): all are STATIC named imports of the `@/agent`
 *    facade. `resolveTaskControl(action)` still returns a `TaskControlFn` (so callers are unchanged)
 *    but is now a plain `Record` lookup over those imports; a missing entry still fails LOUDLY
 *    (`TOOL_FAILED`) rather than silently pretending a plan was steered.
 *  - **Plan-forwarding helpers** for the human-decision routes: `locateOwningPlan` finds the plan
 *    node parked on a pending action (BEFORE the decision clears it), `withPlanUpdate` appends the
 *    refreshed plan to the continuation events so `/agent` can refresh its plan view.
 *  - **Ownership forwarding** for confirm/verify/cancel: `userId`/`sessionId` are threaded through
 *    to the agent runtime so it can enforce that a caller only settles its own actions.
 *
 * It imports ONLY the `@/agent` facade — no Prisma, no DAG logic.
 */
import {
  cancelAction as agentCancel,
  cancelTask,
  confirmAction as agentConfirm,
  findTaskByPendingAction,
  getTaskPlan,
  pauseTask,
  resumeTask,
  retryTask,
  verifyAction as agentVerify,
} from '@/agent';
import type { ConfirmationOutcome, ConfirmOptions } from '@/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import { AppError } from '@/lib/errors';

/** The four execution-control actions `POST /api/tasks/[id]` accepts. */
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'retry';

/**
 * Shape of an `@/agent` task-control capability: given the owning session and the task id, steer
 * the RUNNING plan and return its updated `TaskPlan` (or `undefined` when no plan could be
 * produced).
 */
export type TaskControlFn = (
  sessionId: string,
  taskId: string,
) => Promise<TaskPlan | undefined>;

/** Ownership context forwarded to the agent runtime for confirm/verify/cancel. */
export interface OwnershipOptions {
  userId?: string;
  sessionId?: string;
}

/**
 * `TaskControlAction` → its `@/agent` implementation. Typed `| undefined` so a hypothetical gap
 * stays VISIBLE to the type checker and reachable by the runtime guard below.
 */
const CONTROL_FNS: Record<TaskControlAction, TaskControlFn | undefined> = {
  pause: pauseTask,
  resume: resumeTask,
  cancel: cancelTask,
  retry: retryTask,
};

/**
 * Resolve the `@/agent` control capability for `action`.
 *
 * Throws `AppError('TOOL_FAILED')` when the map has no entry for `action`, so a mis-wired control
 * surfaces to the caller instead of silently no-op'ing the request.
 */
export function resolveTaskControl(action: TaskControlAction): TaskControlFn {
  const fn = CONTROL_FNS[action];
  if (typeof fn !== 'function') {
    throw new AppError(
      'TOOL_FAILED',
      `任务控制能力不可用：当前 Agent 运行时未提供 ${action} 对应的控制函数。`,
    );
  }
  return fn;
}

/**
 * Build the `ConfirmOptions` bag forwarded to the agent runtime.
 *
 * `ConfirmOptions` carries `userId`/`sessionId`; the cast tolerates a runtime that ignores them —
 * the extra keys are harmless and become enforced the moment the gateway checks ownership.
 */
function ownershipBag(o: OwnershipOptions): ConfirmOptions {
  return { userId: o.userId, sessionId: o.sessionId } as unknown as ConfirmOptions;
}

/** Confirm a pending action, forwarding its ownership context to the agent runtime. */
export function confirmOwned(
  actionId: string,
  ownership: OwnershipOptions,
): Promise<ConfirmationOutcome> {
  return agentConfirm(actionId, ownershipBag(ownership));
}

/** Verify the mock MFA code for a RED action, forwarding its ownership context. */
export function verifyOwned(
  actionId: string,
  code: string,
  ownership: OwnershipOptions,
): Promise<ConfirmationOutcome> {
  return agentVerify(actionId, code, ownershipBag(ownership));
}

/** Cancel a pending action, forwarding its ownership context. */
export function cancelOwned(
  actionId: string,
  ownership: OwnershipOptions,
): Promise<ConfirmationOutcome> {
  return agentCancel(actionId, ownershipBag(ownership));
}

/** A plan node parked on a pending action, resolved to its owning session + plan id. */
export interface LocatedPlan {
  sessionId: string;
  taskId: string;
}

/**
 * Locate the plan whose node is parked on `actionId`.
 *
 * MUST run BEFORE the confirm/verify executes: resuming the plan clears the node's
 * `pendingActionId`, after which the reverse lookup finds nothing. Returns `undefined` when there is
 * no session to look up (a plain non-plan action, or an unresolvable caller) — never an error.
 */
export async function locateOwningPlan(
  sessionId: string | undefined,
  actionId: string,
): Promise<LocatedPlan | undefined> {
  if (!sessionId) return undefined;
  const located = await findTaskByPendingAction(sessionId, actionId);
  if (located === undefined) return undefined;
  return { sessionId, taskId: located.taskId };
}

/**
 * Append the refreshed plan to a successful continuation so the browser can refresh its plan view.
 *
 * Returns `outcome` unchanged when there is no owning plan, the decision did not succeed, or the
 * runtime already emitted a `plan_update`. Otherwise re-reads the plan (ownership-checked) and
 * appends a `plan_update` event. This only RE-READS + FORWARDS — no DAG logic, no re-resume.
 */
export async function withPlanUpdate(
  outcome: ConfirmationOutcome,
  located: LocatedPlan | undefined,
): Promise<ConfirmationOutcome> {
  if (located === undefined) return outcome;
  if (outcome.ok !== true) return outcome;
  if (outcome.events.some((event) => event.type === 'plan_update')) return outcome;
  const plan = await getTaskPlan(located.sessionId, located.taskId);
  return { ...outcome, events: [...outcome.events, { type: 'plan_update', plan }] };
}

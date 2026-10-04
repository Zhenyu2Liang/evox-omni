/**
 * app/api/_lib/agent-bridge.ts — the ONE module that knows about the agent's control/ownership API.
 *
 * Route handlers stay thin (`validate (zod) → delegate → serialize`); the tricky bits live here:
 *  - **Task execution control** (`pause` | `resume` | `cancel` | `retry`). A parallel workstream adds
 *    `pauseTask`/`resumeTask`/`cancelTask`/`retryTask` to the `@/agent` facade. Those capability
 *    names do NOT exist at this commit, so this module resolves them off a NAMESPACE import at
 *    runtime (never a named import, which would break `tsc`). It therefore tolerates the facade
 *    BEFORE and AFTER the parallel control-API lands — and fails LOUDLY (`TOOL_FAILED`) when a
 *    capability is missing rather than silently pretending a plan was steered.
 *  - **Ownership forwarding** for confirm/verify/cancel: `userId`/`sessionId` are threaded through
 *    to the agent runtime so it can enforce that a caller only settles its own actions.
 *
 * It imports ONLY the `@/agent` facade — no Prisma, no DAG logic.
 */
import * as agentFacade from '@/agent';
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

/** `TaskControlAction` → the `@/agent` facade export name that implements it. */
const CONTROL_FN_BY_ACTION: Record<TaskControlAction, string> = {
  pause: 'pauseTask',
  resume: 'resumeTask',
  cancel: 'cancelTask',
  retry: 'retryTask',
};

/**
 * Resolve the `@/agent` control capability for `action` at RUNTIME.
 *
 * Throws `AppError('TOOL_FAILED')` when the facade does not (yet) export the capability, so a
 * mis-wired control surfaces to the caller instead of silently no-op'ing the request.
 */
export function resolveTaskControl(action: TaskControlAction): TaskControlFn {
  const fnName = CONTROL_FN_BY_ACTION[action];
  const fn = (agentFacade as Partial<Record<string, unknown>>)[fnName];
  if (typeof fn !== 'function') {
    throw new AppError(
      'TOOL_FAILED',
      `任务控制能力不可用：当前 Agent 运行时未提供 ${fnName}（${action}）。`,
    );
  }
  return fn as TaskControlFn;
}

/**
 * Build the `ConfirmOptions` bag forwarded to the agent runtime.
 *
 * The cast is required until `ConfirmOptions` gains the `userId`/`sessionId` fields (a parallel
 * ownership workstream extends it). Until then the extra keys are harmless — the runtime simply
 * ignores them — and the gateway starts enforcing them the moment the ownership API lands.
 */
function ownershipBag(o: OwnershipOptions): ConfirmOptions {
  return { userId: o.userId, sessionId: o.sessionId } as unknown as ConfirmOptions;
}

/** Confirm a pending action, forwarding its ownership context to the agent runtime. */
export function confirmOwned(
  actionId: string,
  ownership: OwnershipOptions,
): Promise<ConfirmationOutcome> {
  return agentFacade.confirm(actionId, ownershipBag(ownership));
}

/** Verify the mock MFA code for a RED action, forwarding its ownership context. */
export function verifyOwned(
  actionId: string,
  code: string,
  ownership: OwnershipOptions,
): Promise<ConfirmationOutcome> {
  return agentFacade.verify(actionId, code, ownershipBag(ownership));
}

/** Cancel a pending action, forwarding its ownership context. */
export function cancelOwned(
  actionId: string,
  ownership: OwnershipOptions,
): Promise<ConfirmationOutcome> {
  return agentFacade.cancel(actionId, ownershipBag(ownership));
}

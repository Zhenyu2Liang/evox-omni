/**
 * GET /api/tasks/[id] — read one task plan.
 * POST /api/tasks/[id] — control a task plan's EXECUTION (`pause` | `resume` | `cancel` | `retry`).
 *
 * Contract:
 *  - Identity (both verbs): the configured demo user and fixed workspace via `requireIdentity`.
 *    Cookies and query identifiers cannot select another user or session. No login is required.
 *  - GET: reads the persisted plan through the sanctioned repository read path
 *    (`@/lib/db/repositories/task`) and maps it to the `AppTaskPlan` (a `TaskPlan` whose `results`
 *    ADDITIVELY carry each node's `pendingActionId`, so the UI can restore the confirm/MFA entry).
 *    Every node parked on a human decision additionally carries `pendingActionStatus` — the parked
 *    `PendingAction`'s CURRENT persisted status, loaded advisory-only via `_lib/task-pending-actions`
 *    — so a client can tell an OPEN decision (`pending`/`awaiting_mfa`) from a TERMINAL `locked` one.
 *    `locked` can NEVER be completed (the MFA attempt limit was exhausted and the action was parked
 *    terminally); the user must start a NEW request rather than be prompted for another code.
 *    Enforces ownership: a plan belonging to another session/user gets `403 SECURITY_DENIED`.
 *    READ-ONLY: reading never reopens, retries, recovers or executes anything and never writes
 *    `PendingAction.status`; a missing action row simply omits `pendingActionStatus`.
 *    Success: `200 { ok: true, data: TaskPlanWithDecisionState }` (additive widening of `AppTaskPlan`);
 *    unknown id → `404 NOT_FOUND`.
 *  - POST: body `{ action }` (validated with `taskControlSchema`). Delegates to the RUNNING executor
 *    through `@/agent` (via `_lib/agent-bridge`), which performs the real execution control:
 *    `pause` stops before the next node; `cancel` stops and cancels the remaining nodes; `retry`
 *    re-runs only the failed node; `resume` continues without re-running already-succeeded nodes.
 *    Success: `200 { ok: true, data: TaskPlan }` (plan snapshot after the control). A session that
 *    does not own the plan → `403 SECURITY_DENIED`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { getTask } from '@/lib/db/repositories/task';
import type { TaskPlan } from '@/lib/contracts/task';
import { resolveTaskControl } from '../../_lib/agent-bridge';
import { errorResponse, jsonResponse, parseBody } from '../../_lib/http';
import { requireIdentity } from '../../_lib/session';
import {
  withPendingActionStatuses,
  type TaskPlanWithDecisionState,
} from '../../_lib/task-pending-actions';
import type { IdRouteContext } from '../../_lib/types';
import { toTaskPlan, type AppTaskPlan } from '../../_lib/task-plans';

/** Request body schema for `POST /api/tasks/[id]`. */
const taskControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry', 'rollback']),
});
type TaskControlBody = z.infer<typeof taskControlSchema>;

export async function GET(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    // Resolve the fixed demo workspace before checking persisted task ownership.
    const identity = await requireIdentity(req);
    const id = (await ctx.params).id;

    const task = await getTask(id);
    if (!task) throw new AppError('NOT_FOUND', `Task plan not found: ${id}`);

    // Ownership: the plan must belong to the caller's trusted session AND its (server-derived)
    // user id. `identity.userId` IS the owning `AgentSession` row's `userId` (see `resolveIdentity`).
    if (task.sessionId !== identity.sessionId || task.userId !== identity.userId) {
      throw new AppError('SECURITY_DENIED', '无权查看该任务。');
    }

    // Additive, advisory decision state: one batched read of the plan's parked actions (no write).
    return jsonResponse<TaskPlanWithDecisionState>(await withPendingActionStatuses(toTaskPlan(task)));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    // Resolve the fixed demo workspace before checking persisted task ownership.
    const identity = await requireIdentity(req);
    const id = (await ctx.params).id;
    const body = await parseBody(taskControlSchema, req);

    const existing = await getTask(id);
    if (!existing) throw new AppError('NOT_FOUND', `Task plan not found: ${id}`);
    if (existing.sessionId !== identity.sessionId || existing.userId !== identity.userId) {
      throw new AppError('SECURITY_DENIED', '无权控制该任务。');
    }

    // Delegate the REAL execution control to the running executor via the agent facade; the bridge
    // fails loudly (`TOOL_FAILED`) when the control capability is unavailable.
    const updated = await resolveTaskControl(body.action)(identity.sessionId, id);
    if (!updated) {
      throw new AppError('TOOL_FAILED', '任务控制未返回计划。');
    }
    return jsonResponse<TaskPlan>(updated);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { TaskControlBody, TaskPlan, AppTaskPlan, TaskPlanWithDecisionState };

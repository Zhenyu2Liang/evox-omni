/**
 * GET /api/tasks/[id] — read one task plan.
 * POST /api/tasks/[id] — steer a task plan (`pause` | `resume` | `cancel` | `retry`).
 *
 * Contract:
 *  - GET: reads the persisted plan through the sanctioned repository read path
 *    (`@/lib/db/repositories/task`) and maps it to the frozen `TaskPlan` contract.
 *    Success: `200 { ok: true, data: TaskPlan }`; unknown id → `404 NOT_FOUND`.
 *  - POST: body `{ action }` (validated with `taskControlSchema`).
 *    Success: `200 { ok: true, data: TaskPlan }` (plan snapshot after the control).
 *
 * NOTE: the `@/planner` facade exposes no cross-request `PlanControls` registry — the executor's
 * controls are in-process and unreachable across HTTP requests — so steering is applied
 * BEST-EFFORT to the PERSISTED `AgentTask` row (see `POST`).
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import {
  getTask,
  updateTaskNodeStatus,
  updateTaskStatus,
} from '@/lib/db/repositories/task';
import type { TaskPlan } from '@/lib/contracts/task';
import { errorResponse, jsonResponse, parseBody } from '../../_lib/http';
import type { IdRouteContext } from '../../_lib/types';
import { toTaskPlan } from '../../_lib/task-plans';

/** Request body schema for `POST /api/tasks/[id]`. */
const taskControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry']),
});
type TaskControlBody = z.infer<typeof taskControlSchema>;

/**
 * Persisted `AgentTask.status` each control action maps to. The planner executor's in-process
 * `PlanControls` are not reachable across HTTP requests, so these statuses are the best-effort
 * reflection of the requested control on the stored plan.
 */
const STATUS_BY_ACTION: Record<TaskControlBody['action'], string> = {
  pause: 'pending',
  resume: 'running',
  cancel: 'cancelled',
  retry: 'pending',
};

export async function GET(_req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;
    const task = await getTask(id);
    if (!task) throw new AppError('NOT_FOUND', `Task plan not found: ${id}`);
    return jsonResponse<TaskPlan>(toTaskPlan(task));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const id = (await ctx.params).id;
    const body = await parseBody(taskControlSchema, req);

    const existing = await getTask(id);
    if (!existing) throw new AppError('NOT_FOUND', `Task plan not found: ${id}`);

    // Best-effort control on the PERSISTED row: there is no cross-request `PlanControls` registry
    // (the executor's controls are in-process only), so we update `AgentTask.status` and, for a
    // `retry`, reset the node statuses to `pending` so the plan can be re-run.
    await updateTaskStatus(id, STATUS_BY_ACTION[body.action]);
    if (body.action === 'retry') {
      for (const node of existing.nodes) {
        await updateTaskNodeStatus(id, node.nodeId, 'pending');
      }
    }

    const updated = await getTask(id);
    if (!updated) throw new AppError('NOT_FOUND', `Task plan not found: ${id}`);
    return jsonResponse<TaskPlan>(toTaskPlan(updated));
  } catch (e) {
    return errorResponse(e);
  }
}

export type { TaskControlBody, TaskPlan };

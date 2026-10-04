/**
 * GET /api/tasks/[id] — read one task plan.
 * POST /api/tasks/[id] — control a task plan's EXECUTION (`pause` | `resume` | `cancel` | `retry`).
 *
 * Contract:
 *  - GET: reads the persisted plan through the sanctioned repository read path
 *    (`@/lib/db/repositories/task`) and maps it to the frozen `TaskPlan` contract.
 *    Success: `200 { ok: true, data: TaskPlan }`; unknown id → `404 NOT_FOUND`.
 *  - POST: body `{ action }` (validated with `taskControlSchema`). Delegates to the RUNNING executor
 *    through `@/agent` (via `_lib/agent-bridge`), which performs the real execution control:
 *    `pause` stops before the next node; `cancel` stops and cancels the remaining nodes; `retry`
 *    re-runs only the failed node; `resume` continues without re-running already-succeeded nodes.
 *    Success: `200 { ok: true, data: TaskPlan }` (plan snapshot after the control).
 *    Requires the owning session (cookie/query); a session that does not own the plan →
 *    `403 SECURITY_DENIED`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { getTask } from '@/lib/db/repositories/task';
import type { TaskPlan } from '@/lib/contracts/task';
import { resolveTaskControl } from '../../_lib/agent-bridge';
import { errorResponse, jsonResponse, parseBody } from '../../_lib/http';
import { resolveSessionId } from '../../_lib/session';
import type { IdRouteContext } from '../../_lib/types';
import { toTaskPlan } from '../../_lib/task-plans';

/** Request body schema for `POST /api/tasks/[id]`. */
const taskControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry']),
});
type TaskControlBody = z.infer<typeof taskControlSchema>;

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

    const sessionId = resolveSessionId(req);
    if (!sessionId) {
      throw new AppError('VALIDATION', '无法在没有会话的情况下控制任务。');
    }

    const existing = await getTask(id);
    if (!existing) throw new AppError('NOT_FOUND', `Task plan not found: ${id}`);
    if (existing.sessionId !== sessionId) {
      throw new AppError('SECURITY_DENIED', '无权控制该任务。');
    }

    // Delegate the REAL execution control to the running executor via the agent facade; the bridge
    // fails loudly (`TOOL_FAILED`) when the control capability is unavailable.
    const updated = await resolveTaskControl(body.action)(sessionId, id);
    if (!updated) {
      throw new AppError('TOOL_FAILED', '任务控制未返回计划。');
    }
    return jsonResponse<TaskPlan>(updated);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { TaskControlBody, TaskPlan };

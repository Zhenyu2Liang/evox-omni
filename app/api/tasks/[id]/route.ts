/**
 * GET /api/tasks/[id] — read one task plan.
 * POST /api/tasks/[id] — steer a task plan (`pause` | `resume` | `cancel` | `retry`).
 *
 * Contract:
 *  - GET: delegates to the planner plan-store read (`@/planner`).
 *    Success: `200 { ok: true, data: TaskPlan }`; unknown id → `404 NOT_FOUND`.
 *  - POST: body `{ action }` (validated with `taskControlSchema`); delegates to the planner's
 *    `PlanControls` (`@/planner`, the controls object surfaced by a running plan).
 *    Success: `200 { ok: true, data: TaskPlan }` (plan snapshot after the control).
 *
 * STUB (Genesis architecture pass): bodies not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
// Planner plan-store / controls (owner: `@/planner`).
import * as planner from '@/planner';
import type { TaskPlan } from '@/lib/contracts/task';
import type { IdRouteContext } from '../../_lib/types';

/** Request body schema for `POST /api/tasks/[id]`. */
export const taskControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry']),
});
export type TaskControlBody = z.infer<typeof taskControlSchema>;

export async function GET(_req: NextRequest, _ctx: IdRouteContext): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

export async function POST(_req: NextRequest, _ctx: IdRouteContext): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void planner;
export type { TaskPlan };

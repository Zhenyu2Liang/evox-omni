/**
 * GET /api/tasks — list agent task plans for a session.
 *
 * Contract:
 *  - Query (validated with `taskListQuerySchema`): `{ sessionId?: string; limit?: number }`.
 *  - Delegates to the planner's plan-store read (`@/planner`), which reads persisted
 *    `AgentTask`/`AgentTaskNode` rows for the session.
 *  - Success: `200 { ok: true, data: { plans: TaskPlan[] } }`, newest-first.
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
// Planner plan-store (owner: `@/planner`).
import * as planner from '@/planner';
import type { TaskPlan } from '@/lib/contracts/task';
import { sessionIdQuerySchema, limitQuerySchema } from '../_lib/schemas';

/** Query schema for `GET /api/tasks`. */
export const taskListQuerySchema = sessionIdQuerySchema.merge(limitQuerySchema);
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** Success payload shape for `GET /api/tasks`. */
export interface TaskListData {
  plans: TaskPlan[];
}

export async function GET(_req: NextRequest): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void planner;

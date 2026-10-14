/**
 * GET /api/tasks — list agent task plans for the TRUSTED caller session.
 *
 * Contract:
 *  - Query (validated with `limitQuerySchema`): `{ limit?: number }`. A `?sessionId=` query param is
 *    IGNORED (identity is never query-trusted).
 *  - Session: the configured demo user's fixed workspace, resolved by `resolveIdentity`.
 *    Opening the page loads the same workspace across browsers; missing cookies do not alter it.
 *  - Reads persisted `AgentTask`/`AgentTaskNode` rows through the sanctioned repository read path
 *    (`@/lib/db/repositories/task`) and maps them to the frozen `TaskPlan` contract (`_lib/task-plans`).
 *    The `@/planner` facade exposes no plan-store reader (see `_lib/task-plans.ts`).
 *  - Success: `200 { ok: true, data: { plans: TaskPlan[] } }`, newest-first.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTask, listTasksBySession } from '@/lib/db/repositories/task';
import type { TaskPlan } from '@/lib/contracts/task';
import { errorResponse, jsonResponse, parseQuery } from '../_lib/http';
import { limitQuerySchema } from '../_lib/schemas';
import { resolveIdentity } from '../_lib/session';
import { toTaskPlan } from '../_lib/task-plans';

/** Query schema for `GET /api/tasks`. */
const taskListQuerySchema = limitQuerySchema;
type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** Success payload shape for `GET /api/tasks`. */
export interface TaskListData {
  plans: TaskPlan[];
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const query: TaskListQuery = parseQuery(taskListQuerySchema, req);
    const identity = await resolveIdentity(req);

    const rows = await listTasksBySession(identity.sessionId);
    const plans: TaskPlan[] = [];
    for (const row of rows) {
      // `listTasksBySession` returns rows only; load nodes per task to build the full plan.
      const full = await getTask(row.id);
      if (full) plans.push(toTaskPlan(full));
    }

    plans.sort((a, b) => b.createdAt - a.createdAt); // newest-first
    const data: TaskListData = { plans: query.limit ? plans.slice(0, query.limit) : plans };
    return jsonResponse<TaskListData>(data);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { TaskListQuery };

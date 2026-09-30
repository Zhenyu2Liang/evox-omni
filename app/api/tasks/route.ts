/**
 * GET /api/tasks — list agent task plans for a session.
 *
 * Contract:
 *  - Query (validated with `taskListQuerySchema`): `{ sessionId?: string; limit?: number }`.
 *  - `sessionId` precedence: `?sessionId=` query → `banking_session` cookie. An empty/unknown
 *    session yields `{ plans: [] }` (200, never an error).
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
import { sessionIdQuerySchema, limitQuerySchema } from '../_lib/schemas';
import { resolveSessionId } from '../_lib/session';
import { toTaskPlan } from '../_lib/task-plans';

/** Query schema for `GET /api/tasks`. */
const taskListQuerySchema = sessionIdQuerySchema.merge(limitQuerySchema);
type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** Success payload shape for `GET /api/tasks`. */
export interface TaskListData {
  plans: TaskPlan[];
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const query: TaskListQuery = parseQuery(taskListQuerySchema, req);
    const sessionId = query.sessionId ?? resolveSessionId(req) ?? '';
    if (!sessionId) return jsonResponse<TaskListData>({ plans: [] });

    const rows = await listTasksBySession(sessionId);
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

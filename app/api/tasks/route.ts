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
 *  - ADDITIVE decision state: every returned node that is parked on a human decision
 *    (`pendingActionId`) also carries `pendingActionStatus` — the parked `PendingAction`'s CURRENT
 *    persisted status, loaded advisory-only through `_lib/task-pending-actions`. It lets a client
 *    tell an OPEN decision (`pending`/`awaiting_mfa`) from a TERMINAL `locked` one. `locked` means
 *    the decision can NEVER be completed: the MFA attempt limit was exhausted and the action was
 *    parked terminally, so the user must start a NEW request instead of re-prompting for a code.
 *  - READ-ONLY: this read model never reopens, retries, recovers or executes anything, and never
 *    writes `PendingAction.status`; a missing action row simply omits `pendingActionStatus`.
 *  - Success: `200 { ok: true, data: { plans: TaskPlanWithDecisionState[] } }`, newest-first
 *    (still envelope-compatible: `TaskPlanWithDecisionState` is an additive widening of `TaskPlan`).
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTask, listTasksBySession } from '@/lib/db/repositories/task';
import { errorResponse, jsonResponse, parseQuery } from '../_lib/http';
import { limitQuerySchema } from '../_lib/schemas';
import { resolveIdentity } from '../_lib/session';
import { withPendingActionStatusesForPlans, type TaskPlanWithDecisionState } from '../_lib/task-pending-actions';
import { toTaskPlan, type AppTaskPlan } from '../_lib/task-plans';

/** Query schema for `GET /api/tasks`. */
const taskListQuerySchema = limitQuerySchema;
type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** Success payload shape for `GET /api/tasks`. */
export interface TaskListData {
  plans: TaskPlanWithDecisionState[];
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const query: TaskListQuery = parseQuery(taskListQuerySchema, req);
    const identity = await resolveIdentity(req);

    const rows = await listTasksBySession(identity.sessionId);
    const plans: AppTaskPlan[] = [];
    for (const row of rows) {
      // `listTasksBySession` returns rows only; load nodes per task to build the full plan.
      const full = await getTask(row.id);
      if (full) plans.push(toTaskPlan(full));
    }

    plans.sort((a, b) => b.createdAt - a.createdAt); // newest-first
    // Page FIRST, then annotate: only the returned plans' actions are looked up.
    const page = query.limit ? plans.slice(0, query.limit) : plans;
    // ONE status batch across every listed plan (advisory, read-only — see the module header).
    const annotated = await withPendingActionStatusesForPlans(page);

    const data: TaskListData = { plans: annotated };
    return jsonResponse<TaskListData>(data);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { TaskListQuery, TaskPlanWithDecisionState };

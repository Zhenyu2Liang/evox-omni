import type { PendingAction } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import { AppError } from '@/lib/errors';
import { resumeTaskForAction } from '../task-control';
import { synchronizeScheduledWorkflow } from '../scheduled-dispatcher';
import type { ToolExecutionResult } from '../tools';
import type { ConfirmOptions } from './contracts';
import { emitAll } from './outcomes';
import { executeGatedTool } from './gated-execution';

/** Workflow continuation cannot change an already committed business result. */
export async function resumeOwningPlan(
  action: PendingAction, result: ToolExecutionResult, userId: string, opts?: ConfirmOptions,
): Promise<AgentStreamEvent[]> {
  try {
    const resumed = await resumeTaskForAction(
      action.sessionId, action.id,
      { ok: result.ok, data: result.data, summary: result.summary, error: result.error },
      {
        runTool: (toolName, args, ctx) => executeGatedTool({
          sessionId: action.sessionId, userId, toolName: toolName as ToolName, args,
          userRequest: action.userRequest ?? '', taskId: ctx.taskId, nodeId: ctx.nodeId,
        }),
      },
    );
    if (resumed === undefined) return [];
    await synchronizeScheduledWorkflow(resumed.plan.id);
    const events: AgentStreamEvent[] = [{ type: 'plan_update', plan: resumed.plan }];
    emitAll(events, opts);
    return events;
  } catch (error) {
    const events: AgentStreamEvent[] = [{ type: 'error', message: `任务计划恢复失败：${AppError.from(error).message}` }];
    emitAll(events, opts);
    return events;
  }
}

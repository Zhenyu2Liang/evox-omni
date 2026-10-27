import type { PendingAction } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import type { ErrorCode } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import { createTranslator, DEFAULT_LOCALE } from '@/lib/i18n/shared';
import { isInternalDiagnostic, safePublicText, securityNotice } from '@/lib/public-text';
import { resumeTaskForAction } from '../task-control';
import { synchronizeScheduledWorkflow } from '../scheduled-dispatcher';
import type { ToolExecutionResult } from '../tools';
import type { ConfirmOptions } from './contracts';
import { emitAll } from './outcomes';
import { executeGatedTool } from './gated-execution';

/** One translator for this layer: the text below is server-authored in the default locale. */
const t = createTranslator(DEFAULT_LOCALE);

/**
 * A raw security payload must never become the persisted plan-node error (the node's failure is
 * rendered back to the user): an internal diagnostic is replaced by the typed security notice, while
 * an ordinary business error string is forwarded unchanged.
 */
function publicPlanError(error: string | undefined, errorCode: ErrorCode | undefined): string | undefined {
  if (error === undefined || !isInternalDiagnostic(error)) return error;
  return errorCode !== undefined
    ? securityNotice({ code: errorCode }, t)
    : t('chat.error.operationNotStarted');
}

/** Workflow continuation cannot change an already committed business result. */
export async function resumeOwningPlan(
  action: PendingAction, result: ToolExecutionResult, userId: string, opts?: ConfirmOptions,
): Promise<AgentStreamEvent[]> {
  try {
    const resumed = await resumeTaskForAction(
      action.sessionId, action.id,
      {
        ok: result.ok, data: result.data, summary: result.summary,
        error: publicPlanError(result.error, result.errorCode),
      },
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
    const failure = AppError.from(error);
    // The raw error may be a block payload, JSON or an internal id: only catalog text is public.
    const events: AgentStreamEvent[] = [{
      type: 'error',
      message: safePublicText(failure.message, t, 'chat.error.unknownOutcome'),
      code: failure.code,
    }];
    emitAll(events, opts);
    return events;
  }
}

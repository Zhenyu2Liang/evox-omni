import type { ExecutionFenceCheck } from '@/banking-sdk';
import type { ToolExecutionResult } from '../tools';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolName } from '@/lib/contracts/tools';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { executeGatedTool } from '../confirmation/gated-execution';
import { resumeTask, getTaskPlan } from '../task-control';
import { runSubmitPlan } from '../tools/planning';
import { safeParse } from '@/lib/json';
import type { ConversationIntent } from '@/lib/contracts/intent';
import { hasRedactedCredentials } from './checkpoint';
import { createTranslator, DEFAULT_LOCALE } from '@/lib/i18n/shared';
import { isInternalDiagnostic } from '@/lib/public-text';

const t = createTranslator(DEFAULT_LOCALE);

/** Resume the original graph only after the recovery owner proves its newly acquired run lease. */
export async function resumeOriginalRunTask(runId: string, parentInvocationId: string,
  runtimeFence: ExecutionFenceCheck, onPlanUpdate?: (plan: TaskPlan) => void | Promise<void>): Promise<ToolExecutionResult | undefined> {
  const source = await prisma.agentRun.findUnique({ where: { id: runId } });
  const parent = await prisma.toolInvocation.findUnique({ where: { id: parentInvocationId } });
  if (!source || parent?.runId !== runId || parent.toolName !== 'submit_plan') throw new AppError('CONFLICT', 'Original workflow source is invalid');
  const request = safeParse<{ message?: string; input?: string }>(source.requestJson, {});
  const checkpoint = safeParse<{ snapshot?: { sessionId: string; userId: string; intent?: ConversationIntent } }>(source.checkpointJson, {});
  const intent = checkpoint.snapshot?.sessionId === source.sessionId && checkpoint.snapshot.userId === source.userId ? checkpoint.snapshot.intent : undefined;
  const userRequest = intent?.requestText ?? request.message ?? request.input ?? '';
  const tasks = await prisma.agentTask.findMany({ where: { runId, parentInvocationId } });
  if (tasks.length === 0) {
    const childCount = await prisma.toolInvocation.count({ where: { runId, parentInvocationId, origin: 'workflow' } });
    if (childCount !== 0) throw new AppError('CONFLICT', 'Workflow graph is missing despite recorded child invocations');
    const args = safeParse<Record<string, unknown> | null>(parent.argsJson, null);
    if (!args) throw new AppError('CONFLICT', 'Original workflow arguments are missing');
    if (hasRedactedCredentials(args)) throw new AppError('CONFLICT', 'Original workflow credentials require a fresh user decision');
    return runSubmitPlan(source.userId, args, { sessionId: source.sessionId, runtimeFence, onPlanUpdate,
      userRequest: () => userRequest, conversationIntent: () => intent,
      runTool: (toolName, nodeArgs, context) => executeGatedTool({ ...context, userId: source.userId,
        sessionId: source.sessionId, toolName, args: nodeArgs, userRequest, runtimeFence }),
    }, { runId, parentInvocationId });
  }
  if (tasks.length !== 1) throw new AppError('CONFLICT', 'Original workflow source has ambiguous task graphs');
  const task = tasks[0];
  if (task.sessionId !== source.sessionId || task.userId !== source.userId) throw new AppError('SECURITY_DENIED', 'Original workflow ownership does not match');
  // The run lease was rotated after interruption, so effects from the dead source owner are fenced.
  await prisma.$transaction(async tx => {
    await runtimeFence(tx);
    await tx.agentTask.updateMany({ where: { id: task.id, executionToken: task.executionToken, generation: task.generation },
      data: { executionToken: null, executionClaimedAt: null } });
  });
  let plan: TaskPlan;
  if (task.status === 'paused' || task.status === 'cancelled' || task.status === 'success') {
    plan = await getTaskPlan(task.sessionId, task.id);
  } else {
    plan = await resumeTask(task.sessionId, task.id, { runTool: (toolName, args, context) => executeGatedTool({
      ...context, userId: task.userId, sessionId: task.sessionId, toolName: toolName as ToolName,
      args, userRequest, runtimeFence,
    }) });
  }
  await onPlanUpdate?.(plan);
  const completed = plan.results.filter(node => node.status === 'success').length;
  const failure = plan.status === 'failed' ? plan.results.find(node => node.status === 'failed') : undefined;
  // `gated-execution.ts` copies a gateway `auth.blockReason` (`__SECURITY_BLOCK__…`) into a node error, so a node's own
  // text is not automatically public: an internal diagnostic becomes a catalog fallback classified by a TYPED code,
  // while a business sentence stays verbatim. The summary carries no raw internal status literal.
  const internal = isInternalDiagnostic(failure?.error);
  return { ok: plan.status !== 'failed', data: plan,
    summary: `Workflow ${plan.id}: ${completed} of ${plan.results.length} steps completed.`,
    ...(plan.status === 'failed' ? { error: internal ? t('chat.error.toolFailed') : failure?.error ?? 'Workflow execution failed',
      ...(internal ? { errorCode: 'TOOL_FAILED' as const } : {}) } : {}) };
}

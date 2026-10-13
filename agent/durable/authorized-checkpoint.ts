import type { AgentRun } from '@prisma/client';
import type { ResumeTurnInput } from '../turns/contracts';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { prepareBankingCommand } from '@/lib/contracts/command';
import type { ToolName } from '@/lib/contracts/tools';
import { ledgerKeyForAction } from '@/lib/ledger';
import { readCommandReceipt } from '../command-execution';
import { runtimeRequestDigest } from './serialization';

/** Narration recovery proves the original outcome without executing the authorized command again. */
export async function verifiedAuthorizationInput(run: AgentRun, input: ResumeTurnInput): Promise<ResumeTurnInput> {
  if (input.sessionId !== run.sessionId || !input.toolResult || typeof input.toolResult.ok !== 'boolean') throw new AppError('CONFLICT', 'The original authorization continuation is incomplete');
  if (!input.actionId) throw new AppError('SECURITY_DENIED', 'The original authorization action is required for restart recovery');
  const action = await prisma.pendingAction.findFirst({ where: { id: input.actionId, sessionId: run.sessionId, userId: run.userId } });
  if (!action || !['executed', 'failed', 'cancelled'].includes(action.status)) throw new AppError('SECURITY_DENIED', 'The original authorization outcome is not terminal');
  const toolName = input.resultToolName ?? input.toolName;
  if (toolName !== action.toolName) throw new AppError('CONFLICT', 'Authorization narration does not match the original bank tool');
  if ((input.taskId ?? null) !== action.taskId || (input.nodeId ?? null) !== action.nodeId) throw new AppError('CONFLICT', 'Authorization narration does not match the original workflow node');
  const args = safeParse<Record<string, unknown>>(action.argsJson, {});
  const sourceAccountId = typeof args.sourceAccountId === 'string' ? args.sourceAccountId : undefined;
  if (input.sourceAccountId !== sourceAccountId) throw new AppError('CONFLICT', 'Authorization narration does not match the original source account');
  if (!action.invocationId) throw new AppError('CONFLICT', 'The original authorization invocation is missing');
  const child = await prisma.toolInvocation.findUnique({ where: { id: action.invocationId }, include: { run: true } });
  if (!child || child.run.sessionId !== run.sessionId || child.run.userId !== run.userId || child.toolName !== action.toolName) throw new AppError('CONFLICT', 'The original authorization invocation identity is not valid');
  const target = child.origin === 'workflow' && child.parentInvocationId
    ? await prisma.toolInvocation.findUnique({ where: { id: child.parentInvocationId }, include: { run: true } }) : child;
  const expectedToolName = action.taskId ? 'submit_plan' : action.toolName;
  if (!target || target.origin !== 'pi' || target.run.sessionId !== run.sessionId || target.run.userId !== run.userId || target.toolName !== expectedToolName || input.toolName !== expectedToolName) throw new AppError('CONFLICT', 'The authorization outcome cannot be injected into another provider tool');
  if (input.toolCallId !== undefined && input.toolCallId !== target.callId) throw new AppError('CONFLICT', 'Authorization narration does not match the original provider call');
  input = { ...input, toolCallId: target.callId };
  const model = await prisma.modelRequest.findFirst({ where: { runId: run.id }, orderBy: { ordinal: 'desc' } });
  if (model) {
    const messages = safeParse<{ messages?: Array<{ role?: string; toolCallId?: string; toolName?: string; details?: unknown }> }>(model.inputJson, {}).messages;
    const response = messages?.findLast(message => message.role === 'toolResult' && message.toolCallId === target.callId && message.toolName === expectedToolName);
    if (!response || runtimeRequestDigest('authorized_context', response.details) !== runtimeRequestDigest('authorized_context', input.toolResult.data)) throw new AppError('CONFLICT', 'The model checkpoint does not contain the original authorized call result');
  }
  if (!input.toolResult.ok) {
    if (action.status === 'executed') throw new AppError('CONFLICT', 'A committed operation cannot be replaced by failure narration');
    return input;
  }
  if (action.status !== 'executed') throw new AppError('CONFLICT', 'A successful narration requires the original executed action');
  let result = safeParse<{ ok?: boolean; data?: unknown }>(action.resultJson, {});
  if (catalogEntry(action.toolName)?.effect === 'write') {
    result = await readCommandReceipt(prepareBankingCommand(run.userId, ledgerKeyForAction(action), action.toolName as ToolName,
      args)) ?? {};
  }
  if (result.ok !== true || runtimeRequestDigest('authorized_outcome', result.data) !== runtimeRequestDigest('authorized_outcome', input.toolResult.data)) throw new AppError('CONFLICT', 'The authorization outcome has no matching original execution evidence');
  return input;
}

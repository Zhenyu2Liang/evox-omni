import type { Prisma, ToolInvocation } from '@/lib/db/prisma';
import { prisma, type DbClient } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { nodeExecutionKey } from '@/lib/ledger';
import type { ToolReplayPolicy } from '@/lib/contracts/runtime';
import { ensureStandaloneWorkflowRun } from './workflowRun';

export interface WorkflowInvocationIdentity {
  sessionId: string;
  userId: string;
  taskId: string;
  nodeId: string;
  toolName: string;
  argsJson: string;
  requestDigest: string;
  policy: ToolReplayPolicy;
  expectedClaim?: { taskId: string; nodeId: string; planToken: string | undefined; nodeToken: string | undefined };
}
export interface WorkflowInvocationClaim {
  invocation: ToolInvocation;
  created: boolean;
  planToken: string | null;
  nodeToken: string | null;
  generation: number;
}

async function appendWorkflowEvent(tx: Prisma.TransactionClient, runId: string, eventType: string, payload: unknown): Promise<void> {
  const sequence = await tx.agentRun.update({ where: { id: runId }, data: { nextSequence: { increment: 1 } }, select: { nextSequence: true } });
  await tx.agentRunEvent.create({ data: { runId, sequence: sequence.nextSequence, channel: 'internal', eventType, payloadJson: JSON.stringify(payload) } });
}

/** Intent and source linkage commit before either permission evaluation or a bank effect. */
export async function beginWorkflowInvocation(input: WorkflowInvocationIdentity, runtimeFence?: (client: Prisma.TransactionClient) => Promise<void>): Promise<WorkflowInvocationClaim> {
  return prisma.$transaction(async tx => {
    await runtimeFence?.(tx);
    // Take the SQLite writer before allocating shared run ordinals or inspecting execution claims.
    await tx.agentTask.updateMany({ where: { id: input.taskId }, data: { generation: { increment: 0 } } });
    const task = await tx.agentTask.findUnique({ where: { id: input.taskId } });
    const node = await tx.agentTaskNode.findUnique({ where: { taskId_nodeId: { taskId: input.taskId, nodeId: input.nodeId } } });
    const session = await tx.agentSession.findUnique({ where: { id: input.sessionId } });
    if (!task || !node || task.sessionId !== input.sessionId || task.userId !== input.userId || session?.userId !== input.userId) {
      throw new AppError('SECURITY_DENIED', 'Workflow invocation ownership is invalid');
    }
    if (node.kind !== 'tool' || node.tool !== input.toolName) throw new AppError('CONFLICT', 'Workflow invocation does not match its declared node tool');
    if (input.expectedClaim && (input.expectedClaim.taskId !== task.id || input.expectedClaim.nodeId !== node.nodeId ||
      task.executionToken !== (input.expectedClaim.planToken ?? null) || node.executionToken !== (input.expectedClaim.nodeToken ?? null))) {
      throw new AppError('CONFLICT', 'Workflow executor lost its claim before intent persistence');
    }
    const previous = await tx.toolInvocation.findUnique({ where: { taskId_nodeId: { taskId: task.id, nodeId: node.nodeId } } });
    if (previous && (previous.toolName !== input.toolName || previous.requestDigest !== input.requestDigest || previous.operationKey !== nodeExecutionKey(task.id, node.nodeId))) {
      throw new AppError('CONFLICT', 'Workflow invocation identity was reused with different arguments');
    }
    if (task.status === 'cancelled') throw new AppError('CONFLICT', 'Cancelled workflow cannot launch a tool');
    let runId = task.runId;
    if (runId === null) {
      // Staged server-owned graphs also acquire a source before their first tool intent.
      runId = await ensureStandaloneWorkflowRun(task, tx);
    }
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.sessionId !== task.sessionId || run.userId !== task.userId) throw new AppError('CONFLICT', 'Workflow journal ownership is invalid');
    let invocation = previous;
    if (!invocation) {
      let modelRequestId: string | null = null;
      if (task.parentInvocationId) {
        const parent = await tx.toolInvocation.findUnique({ where: { id: task.parentInvocationId } });
        if (parent?.runId !== runId || parent.toolName !== 'submit_plan') throw new AppError('CONFLICT', 'Workflow parent invocation is invalid');
        modelRequestId = parent.modelRequestId;
      }
      const allocated = await tx.agentRun.update({ where: { id: runId }, data: { nextOrdinal: { increment: 1 } }, select: { nextOrdinal: true } });
      invocation = await tx.toolInvocation.create({ data: {
        runId, ordinal: allocated.nextOrdinal, callId: `workflow:${task.id}:${node.nodeId}`, origin: 'workflow',
        parentInvocationId: task.parentInvocationId, modelRequestId, taskId: task.id, nodeId: node.nodeId,
        toolName: input.toolName, argsJson: input.argsJson, requestDigest: input.requestDigest,
        operationKey: nodeExecutionKey(task.id, node.nodeId), replaySafety: input.policy.safety, maxAttempts: input.policy.maxAttempts,
      } });
      await appendWorkflowEvent(tx, runId, 'workflow_tool_started', { invocationId: invocation.id, taskId: task.id, nodeId: node.nodeId, toolName: invocation.toolName, args: JSON.parse(input.argsJson) });
    }
    return { invocation, created: previous === null, planToken: task.executionToken, nodeToken: node.executionToken, generation: task.generation };
  });
}

/** The captured workflow owner governs journal writes independently of a completed source run lease. */
export async function assertWorkflowInvocationClaim(input: WorkflowInvocationIdentity, claim: WorkflowInvocationClaim, client: DbClient): Promise<void> {
  const task = await client.agentTask.findUnique({ where: { id: input.taskId } });
  const node = await client.agentTaskNode.findUnique({ where: { taskId_nodeId: { taskId: input.taskId, nodeId: input.nodeId } } });
  if (!task || !node || task.userId !== input.userId || task.sessionId !== input.sessionId || task.status === 'cancelled' ||
      task.executionToken !== claim.planToken || task.generation !== claim.generation || node.executionToken !== claim.nodeToken) {
    throw new AppError('CONFLICT', 'Workflow invocation execution claim is no longer valid');
  }
}

export async function retryWorkflowInvocation(input: WorkflowInvocationIdentity, claim: WorkflowInvocationClaim): Promise<WorkflowInvocationClaim> {
  const invocation = await prisma.$transaction(async tx => {
    await assertWorkflowInvocationClaim(input, claim, tx);
    const retry = await tx.toolInvocation.updateMany({
      where: { id: claim.invocation.id, attempt: claim.invocation.attempt, status: claim.invocation.status },
      data: { status: 'started', attempt: { increment: 1 }, errorCode: null, finishedAt: null },
    });
    if (retry.count !== 1) throw new AppError('CONFLICT', 'Workflow invocation retry was already claimed');
    const record = await tx.toolInvocation.findUniqueOrThrow({ where: { id: claim.invocation.id } });
    await appendWorkflowEvent(tx, record.runId, 'workflow_tool_retry_started', { invocationId: record.id, attempt: record.attempt });
    return record;
  });
  return { ...claim, invocation };
}

export async function finishWorkflowInvocation(input: WorkflowInvocationIdentity, claim: WorkflowInvocationClaim,
  status: string, resultJson: string, errorCode?: string, runtimeFence?: (client: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await prisma.$transaction(async tx => {
    await runtimeFence?.(tx);
    await assertWorkflowInvocationClaim(input, claim, tx);
    const current = await tx.toolInvocation.findUniqueOrThrow({ where: { id: claim.invocation.id } });
    // A command receipt may have completed this invocation inside the bank transaction already.
    if (current.status !== 'completed' && current.status !== 'cancelled') {
      const changed = await tx.toolInvocation.updateMany({ where: { id: current.id, attempt: claim.invocation.attempt, status: current.status },
        data: { status, resultJson, errorCode, finishedAt: status.startsWith('waiting_') ? null : new Date() } });
      if (changed.count !== 1) throw new AppError('CONFLICT', 'Workflow invocation result belongs to a superseded attempt');
    }
    await appendWorkflowEvent(tx, current.runId, 'workflow_tool_settled', { invocationId: current.id, attempt: claim.invocation.attempt, status: current.status === 'completed' ? 'completed' : status, result: JSON.parse(resultJson) });
  });
}

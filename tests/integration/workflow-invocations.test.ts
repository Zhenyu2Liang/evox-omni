import { describe, expect, it, vi } from 'vitest';
import { useFreshDatabase as registerDatabaseReset, getTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID, CONTACTS } from '@/tests/helpers/fixtures';
import { getOrCreateSession, confirmAction, retryTask } from '@/agent';
import { createTaskGraph } from '@/lib/db/repositories/task';
import { nodeExecutionKey } from '@/lib/ledger';
import { executeGatedTool } from '@/agent/confirmation/gated-execution';
import { runWorkflowInvocation } from '@/agent/durable/workflow-invocations';
import { withWorkflowExecutionClaim } from '@/agent/workflows/execution-context';
import { beginRun, AgentRunJournal } from '@/agent/durable/journal';
import { resumeOriginalRunTask } from '@/agent/durable/workflow-resumption';
import { assertAgentRunLease } from '@/lib/db/repositories/agentRun';

registerDatabaseReset();

async function workflow(toolName = 'get_balance', args: Record<string, unknown> = {}) {
  const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
  const task = await createTaskGraph({ sessionId, userId: DEMO_USER_ID, goal: 'Inspect workflow journaling', status: 'running' },
    [{ nodeId: 'balance', name: 'Inspect balance', kind: 'tool', tool: toolName, args, status: 'running' }]);
  return { sessionId, userId: DEMO_USER_ID, taskId: task.id, nodeId: 'balance', toolName: toolName as Parameters<typeof executeGatedTool>[0]['toolName'], args, userRequest: 'Inspect workflow journaling' };
}

describe('durable workflow child invocations', () => {
  it('persists GREEN intent before execution and replays its original result without another read', async () => {
    const context = await workflow();
    const execute = vi.fn(async () => {
      const records = await getTestPrisma().toolInvocation.findMany({ where: { taskId: context.taskId } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ status: 'started', origin: 'workflow', operationKey: nodeExecutionKey(context.taskId, context.nodeId) });
      return { ok: true, data: { balance: '10.00' }, summary: 'Balance retrieved' };
    });
    const result = await runWorkflowInvocation(context, execute);
    expect(await runWorkflowInvocation(context, execute)).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    const task = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: context.taskId } });
    const events = await getTestPrisma().agentRunEvent.findMany({ where: { runId: task.runId! }, orderBy: { sequence: 'asc' } });
    expect(events.map(event => event.eventType)).toEqual(['workflow_tool_started', 'workflow_tool_settled']);
  });

  it('keeps a gated transfer and its human-authorized completion on one invocation and operation key', async () => {
    const context = await workflow('transfer_money', { name: CONTACTS[0].name, amount: '200.00' });
    const result = await executeGatedTool(context);
    expect(result.requiresConfirmation).toBe(true);
    const record = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { taskId: context.taskId } });
    expect(record.status).toBe('waiting_confirmation');
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: result.pendingActionId! } });
    expect(action.invocationId).toBe(record.id);
    const confirmation = await confirmAction(action.id);
    expect(confirmation.ok).toBe(true);
    const completed = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: record.id } });
    expect(completed.status).toBe('completed');
    expect(completed.operationKey).toBe(record.operationKey);
    expect(await getTestPrisma().toolInvocation.count({ where: { taskId: context.taskId } })).toBe(1);
    expect(await getTestPrisma().executionReceipt.count({ where: { key: record.operationKey } })).toBe(1);
  });

  it('records RED authorization as waiting for verification', async () => {
    const result = await executeGatedTool(await workflow('transfer_money', { name: CONTACTS[0].name, amount: '2000.00' }));
    const action = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: result.pendingActionId! } });
    const record = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: action.invocationId! } });
    expect(record.status).toBe('waiting_verification');
  });

  it('distinguishes a user-requested fresh authorization from an automatic retry of a failed write', async () => {
    const context = await workflow('transfer_money', { name: CONTACTS[0].name, amount: '200.00' });
    const parked = await executeGatedTool(context);
    await getTestPrisma().account.updateMany({ where: { userId: DEMO_USER_ID }, data: { balanceMinor: 0n } });
    expect((await confirmAction(parked.pendingActionId!)).ok).toBe(false);
    const original = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { taskId: context.taskId } });
    expect(original.status).toBe('failed');
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runWorkflowInvocation(context, execute)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(execute).not.toHaveBeenCalled();
    const retried = await retryTask(context.sessionId, context.taskId);
    expect(retried.status).toBe('waiting_confirmation');
    const record = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: original.id } });
    expect(record.operationKey).toBe(original.operationKey);
    expect(record.attempt).toBe(2);
    expect(await getTestPrisma().toolInvocation.count({ where: { taskId: context.taskId } })).toBe(1);
    const pending = await getTestPrisma().pendingAction.findMany({ where: { taskId: context.taskId, status: 'pending' } });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(parked.pendingActionId);
    expect(pending[0].invocationId).toBe(original.id);
    expect(await getTestPrisma().executionReceipt.count({ where: { key: original.operationKey } })).toBe(0);
  });

  it('rejects a completed write result whose committed receipt has been removed', async () => {
    const context = await workflow('reserve_budget', { name: 'Receipt verification', amount: '10.00', purpose: 'Receipt verification' });
    const initialCount = await getTestPrisma().budget.count();
    const result = await executeGatedTool(context);
    expect(result.ok).toBe(true);
    const invocation = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { taskId: context.taskId } });
    await getTestPrisma().executionReceipt.deleteMany({ where: { key: invocation.operationKey } });
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runWorkflowInvocation(context, execute)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(execute).not.toHaveBeenCalled();
    expect(await getTestPrisma().budget.count()).toBe(initialCount + 1);
  });

  it('rejects changed arguments before executing the callback', async () => {
    const context = await workflow();
    await runWorkflowInvocation(context, async () => ({ ok: true, data: {} }));
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runWorkflowInvocation({ ...context, args: { accountId: 'different' } }, execute)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a superseded executor before recording a second intent', async () => {
    const context = await workflow();
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(withWorkflowExecutionClaim({ taskId: context.taskId, nodeId: context.nodeId,
      planToken: 'superseded', nodeToken: 'superseded' }, () => runWorkflowInvocation(context, execute))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(execute).not.toHaveBeenCalled();
    expect(await getTestPrisma().toolInvocation.count()).toBe(0);
  });

  it('retries an interrupted read using the same invocation with a bounded attempt count', async () => {
    const context = await workflow();
    await runWorkflowInvocation(context, async () => ({ ok: true, data: { count: 1 } }));
    const record = await getTestPrisma().toolInvocation.findFirstOrThrow();
    await getTestPrisma().toolInvocation.update({ where: { id: record.id }, data: { status: 'interrupted', resultJson: null, finishedAt: null } });
    const result = await runWorkflowInvocation(context, async () => ({ ok: true, data: { count: 2 } }));
    expect(result.data).toEqual({ count: 2 });
    expect(await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({ attempt: 2, status: 'completed', operationKey: record.operationKey });
    expect(await getTestPrisma().toolInvocation.count()).toBe(1);
  });

  it('does not overwrite a winning executor result after takeover during a read', async () => {
    const context = await workflow();
    await expect(runWorkflowInvocation(context, async () => {
      await getTestPrisma().agentTask.update({ where: { id: context.taskId }, data: { executionToken: 'winner', generation: { increment: 1 } } });
      return { ok: true, data: { stale: true } };
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const record = await getTestPrisma().toolInvocation.findFirstOrThrow();
    expect(record.status).toBe('started');
    expect(record.resultJson).toBeNull();
  });

  it('resumes the original source graph, retains completed predecessors and records parent identities', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const admitted = await beginRun({ sessionId, userId: DEMO_USER_ID, request: { input: 'Inspect balances' } });
    const journal = new AgentRunJournal(admitted.lease!);
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'plan-call', toolName: 'submit_plan', args: {} });
    const parent = journal.invocationForCall('plan-call')!;
    const task = await createTaskGraph({ sessionId, userId: DEMO_USER_ID, goal: 'Inspect balances', status: 'running', runId: admitted.run.id, parentInvocationId: parent.id }, [
      { nodeId: 'previous', name: 'Previously completed', kind: 'tool', tool: 'get_balance', args: {}, status: 'success' },
      { nodeId: 'next', name: 'Remaining read', kind: 'tool', tool: 'get_balance', args: {}, dependencies: ['previous'], status: 'pending' },
    ]);
    await getTestPrisma().agentTask.update({ where: { id: task.id }, data: { executionToken: 'dead-owner', executionClaimedAt: new Date() } });
    const result = await resumeOriginalRunTask(admitted.run.id, parent.id, client => assertAgentRunLease(admitted.lease!, client).then(() => undefined));
    expect(result?.ok).toBe(true);
    expect((result?.data as { id: string; status: string }).id).toBe(task.id);
    expect((result?.data as { status: string }).status).toBe('success');
    expect(await getTestPrisma().agentTask.count()).toBe(1);
    const children = await getTestPrisma().toolInvocation.findMany({ where: { origin: 'workflow' } });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ runId: admitted.run.id, parentInvocationId: parent.id, taskId: task.id, nodeId: 'next', status: 'completed' });
    await journal.finish('completed');
  });

  it('creates the first graph for a persisted parent intent and never creates a second source graph', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const admitted = await beginRun({ sessionId, userId: DEMO_USER_ID, request: { input: 'Inspect balances' } });
    const journal = new AgentRunJournal(admitted.lease!);
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'plan-call', toolName: 'submit_plan', args: {
      goal: 'Inspect balances', nodes: [{ id: 'read', name: 'Read balance', kind: 'tool', tool: 'get_balance', args: {}, dependencies: [] }],
    } });
    const parent = journal.invocationForCall('plan-call')!;
    const fence = (client: Parameters<typeof assertAgentRunLease>[1]) => assertAgentRunLease(admitted.lease!, client).then(() => undefined);
    const first = await resumeOriginalRunTask(admitted.run.id, parent.id, fence);
    const second = await resumeOriginalRunTask(admitted.run.id, parent.id, fence);
    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect((first?.data as { id: string }).id).toBe((second?.data as { id: string }).id);
    expect(await getTestPrisma().agentTask.count()).toBe(1);
    expect(await getTestPrisma().toolInvocation.count({ where: { origin: 'workflow' } })).toBe(1);
    await journal.finish('completed');
  });
});

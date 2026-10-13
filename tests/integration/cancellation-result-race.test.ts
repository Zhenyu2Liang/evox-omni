import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { confirmAction, executeGatedTool, getOrCreateSession } from '@/agent';
import { cancelTask, createTaskPersistence } from '@/agent/task-control';
import { runSubmitPlan } from '@/agent/tools/planning';
import { securityGateway } from '@/security/security-gateway';
import { nodeExecutionKey } from '@/lib/ledger';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolName } from '@/lib/contracts/tools';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { toJson } from '@/lib/json';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('cancellation preserves a node that commits and settles after the control snapshot was read', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const task = await getTestPrisma().agentTask.create({ data: {
    sessionId, userId, goal: 'Cancellation result race', status: 'running', executionToken: 'plan-owner',
    nodes: { create: [{ nodeId: 'budget', name: 'Reserve budget', kind: 'tool', tool: 'reserve_budget',
      order: 0, status: 'running', executionToken: 'node-owner', dependencies: '[]',
      args: JSON.stringify({ name: 'Cancellation result budget', amount: '10' }) }] },
  } });
  const reached = deferred();
  const release = deferred();
  const revoke = actionRepo.revokePendingActionsByTask;
  let calls = 0;
  vi.spyOn(actionRepo, 'revokePendingActionsByTask').mockImplementation(async (...args) => {
    if (++calls === 1) {
      reached.resolve();
      await release.promise;
    }
    return revoke(...args);
  });
  const cancellation = cancelTask(sessionId, task.id);
  let cancelled;
  let committedResult;
  try {
    await reached.promise;
    committedResult = await executeGatedTool({
      sessionId, userId, taskId: task.id, nodeId: 'budget', toolName: 'reserve_budget',
      args: { name: 'Cancellation result budget', amount: '10' }, userRequest: 'Cancellation result race',
    });
    expect(committedResult.ok).toBe(true);
    await createTaskPersistence(task.id, { planToken: 'plan-owner', nodeToken: () => 'node-owner' }).persistNode(task.id, {
      id: 'budget', name: 'Reserve budget', tool: 'reserve_budget', status: 'success', output: committedResult.data,
    });
  } finally {
    release.resolve();
    cancelled = await cancellation;
  }
  const persistedOutput = JSON.parse(toJson(committedResult!.data));
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.results[0]).toMatchObject({ status: 'success', output: persistedOutput });
  const node = await getTestPrisma().agentTaskNode.findFirstOrThrow({ where: { taskId: task.id, nodeId: 'budget' } });
  expect(node.status).toBe('success');
  expect(JSON.parse(node.output!)).toEqual(persistedOutput);
  expect(await getTestPrisma().budget.count({ where: { userId, name: 'Cancellation result budget' } })).toBe(1);
});

it('cancellation restores a committed automatic write before its executor lands node state', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const task = await getTestPrisma().agentTask.create({ data: {
    sessionId, userId, goal: 'Committed automatic write cancellation', status: 'running', executionToken: 'plan-owner',
    nodes: { create: [{ nodeId: 'budget', name: 'Reserve budget', kind: 'tool', tool: 'reserve_budget',
      order: 0, status: 'running', executionToken: 'node-owner', dependencies: '[]',
      args: JSON.stringify({ name: 'Committed budget', amount: '10' }) }] },
  } });
  const result = await executeGatedTool({ sessionId, userId, taskId: task.id, nodeId: 'budget',
    toolName: 'reserve_budget', args: { name: 'Committed budget', amount: '10' }, userRequest: task.goal });
  expect(result.ok).toBe(true);
  expect((await getTestPrisma().agentTaskNode.findFirstOrThrow({ where: { taskId: task.id } })).status).toBe('running');
  const cancelled = await cancelTask(sessionId, task.id);
  const expected = JSON.parse(toJson(result.data));
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.results[0]).toMatchObject({ status: 'success', output: expected });
  // The late executor result must preserve the same receipt-backed terminal state.
  await createTaskPersistence(task.id, { planToken: 'plan-owner', nodeToken: () => 'node-owner' }).persistNode(task.id, {
    id: 'budget', name: 'Reserve budget', tool: 'reserve_budget', status: 'success', output: result.data,
  });
  const node = await getTestPrisma().agentTaskNode.findFirstOrThrow({ where: { taskId: task.id } });
  expect(node.status).toBe('success');
  expect(JSON.parse(node.output!)).toEqual(expected);
  expect(await getTestPrisma().budget.count({ where: { userId, name: 'Committed budget' } })).toBe(1);
});

async function transferCancellationWindow(damage?: 'corrupt' | 'missing') {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  const submitted = await runSubmitPlan(userId, { goal: 'Committed transfer cancellation', nodes: [{
    id: 'payment', name: 'Transfer payment', kind: 'tool', tool: 'transfer_money',
    args: { phone: '139****0002', amount: '200' }, dependencies: [],
  }] }, { sessionId, runTool: (toolName, args, context) => executeGatedTool({
    sessionId, userId, toolName: toolName as ToolName, args, ...context, userRequest: 'Committed transfer cancellation',
  }) });
  const plan = submitted.data as TaskPlan;
  expect(plan.status).toBe('waiting_confirmation');
  const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { taskId: plan.id } });
  expect(JSON.parse(action.argsJson)).toMatchObject({ contactId: 'contact_zhangwei', amount: '200.00' });
  expect(JSON.parse(action.argsJson).phone).toBeUndefined();
  const reached = deferred();
  const release = deferred();
  const record = securityGateway.recordActionResult.bind(securityGateway);
  vi.spyOn(securityGateway, 'recordActionResult').mockImplementation(async (...args) => {
    await record(...args);
    if (args[0] === action.id && args[1] === 'executed') {
      reached.resolve();
      await release.promise;
    }
  });
  const confirming = confirmAction(action.id, { userId, sessionId });
  let cancelled;
  let receipt;
  try {
    await reached.promise;
    receipt = await getTestPrisma().executionReceipt.findUniqueOrThrow({ where: {
      userId_key: { userId, key: nodeExecutionKey(plan.id, 'payment') },
    } });
    expect((await getTestPrisma().agentTaskNode.findFirstOrThrow({ where: { taskId: plan.id } })).status).toBe('waiting_confirmation');
    if (damage === 'missing') await getTestPrisma().executionReceipt.delete({ where: { id: receipt.id } });
    if (damage === 'corrupt') {
      const corrupted = JSON.parse(receipt.responseJson!);
      corrupted.data.amount = '999.00';
      await getTestPrisma().executionReceipt.update({ where: { id: receipt.id }, data: { responseJson: JSON.stringify(corrupted) } });
    }
    cancelled = await cancelTask(sessionId, plan.id);
  } finally {
    release.resolve();
    await confirming;
  }
  expect(cancelled.status).toBe('cancelled');
  expect(await getTestPrisma().transaction.count({ where: { userId, amountMinor: -20000n, channel: 'TRANSFER' } })).toBe(1);
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2338000n);
  return { cancelled, actionId: action.id, receipt: receipt! };
}

it('cancellation restores a committed transfer using its authorized canonical arguments before node continuation', async () => {
  const { cancelled, receipt, actionId } = await transferCancellationWindow();
  expect(cancelled.results[0]).toMatchObject({ status: 'success', output: JSON.parse(receipt.responseJson!).data });
  expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe('executed');
});

it.each(['corrupt', 'missing'] as const)('cancellation keeps %s transfer evidence in reconciliation without replaying a debit', async damage => {
  const { cancelled, actionId } = await transferCancellationWindow(damage);
  expect(cancelled.results[0]).toMatchObject({ status: 'failed', output: { ok: false, needsReconciliation: true } });
  expect(cancelled.results[0].error).toBeTruthy();
  expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe('needs_reconciliation');
});

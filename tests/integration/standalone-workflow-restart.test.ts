import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTestPrisma, useFreshDatabase as registerDatabaseReset } from '@/tests/helpers/db';
import { recoverOwnedRun } from '@/agent/durable/service';
import { listRecoverableAgentRuns } from '@/lib/db/repositories/agentRun';
import { getOrCreateSession } from '@/agent/session';
import { createTaskGraph } from '@/lib/db/repositories/task';

registerDatabaseReset();
const children = new Set<ChildProcess>();
interface ChildMessage {
  type: string;
  runId?: string;
  sessionId?: string;
  taskId?: string;
  message?: string;
  result?: { outcomes: Array<{ runId: string; status: string }> };
}

function launch(mode: string, scenario: string) {
  const child = fork(path.join(process.cwd(), 'tests/helpers/standalone-restart-process.ts'), [mode, scenario], {
    cwd: process.cwd(), execArgv: ['--import', 'tsx'],
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, LLM_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  const messages: ChildMessage[] = [];
  const notifications = new Set<() => void>();
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-6000); });
  child.stdout?.on('data', () => undefined);
  child.on('message', message => { messages.push(message as ChildMessage); for (const notify of notifications) notify(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => {
      children.delete(child);
      for (const notify of notifications) notify();
      resolve({ code, signal });
    });
  });
  return { child, exited, wait: (type: string): Promise<ChildMessage> => new Promise((resolve, reject) => {
    const finish = () => {
      const found = messages.find(message => message.type === type);
      const fatal = messages.find(message => message.type === 'fatal');
      if (!found && !fatal && child.exitCode === null && child.signalCode === null) return;
      clearTimeout(timer);
      notifications.delete(finish);
      if (found) resolve(found);
      else reject(new Error(fatal?.message ?? `Standalone child exited before ${type}: ${diagnostics}`));
    };
    const timer = setTimeout(() => {
      notifications.delete(finish);
      reject(new Error(`Standalone child did not reach ${type}: ${diagnostics}`));
    }, 15000);
    notifications.add(finish);
    finish();
  }) };
}

afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  })));
});

async function crash(scenario: string) {
  const process = launch('start', scenario);
  const barrier = await process.wait('barrier');
  if (!barrier.runId || !barrier.sessionId || !barrier.taskId) throw new Error('Missing standalone crash identities');
  const identity = { runId: barrier.runId, sessionId: barrier.sessionId, taskId: barrier.taskId };
  process.child.kill('SIGKILL');
  expect((await process.exited).signal).toBe('SIGKILL');
  await getTestPrisma().agentTask.update({ where: { id: identity.taskId }, data: { executionClaimedAt: new Date('2000-01-01T00:00:00Z') } });
  return identity;
}

async function wake(scenario: string) {
  const process = launch('worker', scenario);
  const result = await process.wait('worker_finished');
  expect((await process.exited).code, result.message).toBe(0);
  return result.result;
}

describe('Standalone workflow crash recovery', () => {
  it('rolls back graph creation when its persisted session does not establish ownership', async () => {
    await expect(createTaskGraph({ sessionId: 'missing-session', userId: 'user_liming', goal: 'Inspect ownership' },
      [{ nodeId: 'read', name: 'Read balance', kind: 'tool', tool: 'get_balance', args: {} }])).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    expect(await getTestPrisma().agentTask.count()).toBe(0);
    expect(await getTestPrisma().agentRun.count()).toBe(0);
  });

  it('resumes a saved graph after a crash before its first tool intent', async () => {
    const identity = await crash('graph');
    expect(await getTestPrisma().toolInvocation.count({ where: { runId: identity.runId } })).toBe(0);
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: identity.runId } })).status).toBe('interrupted');
    expect((await wake('graph'))?.outcomes).toEqual([{ runId: identity.runId, status: 'completed' }]);
    expect(await getTestPrisma().agentTask.count({ where: { runId: identity.runId } })).toBe(1);
    expect(await getTestPrisma().budget.count({ where: { name: 'Standalone restart budget' } })).toBe(1);
    expect(await getTestPrisma().modelRequest.count({ where: { runId: identity.runId } })).toBe(0);
  });

  it('recovers a committed predecessor without another budget, receipt or invocation', async () => {
    const identity = await crash('committed');
    const invocation = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { taskId: identity.taskId, nodeId: 'budget' } });
    const receipt = await getTestPrisma().executionReceipt.findUniqueOrThrow({ where: { userId_key: { userId: 'user_liming', key: invocation.operationKey } } });
    expect((await wake('committed'))?.outcomes).toEqual([{ runId: identity.runId, status: 'completed' }]);
    expect(await getTestPrisma().budget.count({ where: { name: 'Standalone restart budget' } })).toBe(1);
    expect((await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).attempt).toBe(1);
    expect((await getTestPrisma().executionReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).responseJson).toBe(receipt.responseJson);
    expect(await getTestPrisma().toolInvocation.count({ where: { taskId: identity.taskId } })).toBe(2);
  });

  it('retains a parked human decision after restart without a second action or debit', async () => {
    const identity = await crash('authorization');
    const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { taskId: identity.taskId } });
    expect((await wake('authorization'))?.outcomes).toEqual([{ runId: identity.runId, status: 'waiting_confirmation' }]);
    expect(await getTestPrisma().pendingAction.count({ where: { taskId: identity.taskId } })).toBe(1);
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('pending');
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });

  it.each(['paused', 'failed', 'cancelled'])('does not automatically resume a %s graph', async status => {
    const identity = await crash('graph');
    await getTestPrisma().agentTask.update({ where: { id: identity.taskId }, data: { status } });
    expect((await wake('graph'))?.outcomes).toEqual([]);
    expect(await getTestPrisma().budget.count({ where: { name: 'Standalone restart budget' } })).toBe(0);
  });

  it('stops for receipt reconciliation before a downstream query can run', async () => {
    const identity = await crash('committed');
    const invocation = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { taskId: identity.taskId } });
    await getTestPrisma().executionReceipt.deleteMany({ where: { key: invocation.operationKey } });
    await expect(recoverOwnedRun(identity.runId, { sessionId: identity.sessionId, userId: 'user_liming' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await getTestPrisma().toolInvocation.count({ where: { taskId: identity.taskId } })).toBe(1);
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: identity.runId } })).recoveryErrorCode).toBe('RECONCILIATION_REQUIRED');
    expect(await getTestPrisma().budget.count({ where: { name: 'Standalone restart budget' } })).toBe(1);
  });

  it('does not discover a live executor or a graph under manual review', async () => {
    const { sessionId } = await getOrCreateSession('user_liming');
    const task = await createTaskGraph({ sessionId, userId: 'user_liming', goal: 'Inspect executor liveness', status: 'running' },
      [{ nodeId: 'read', name: 'Read balance', kind: 'tool', tool: 'get_balance', args: {} }]);
    await getTestPrisma().agentTask.update({ where: { id: task.id }, data: { executionToken: 'live-owner', executionClaimedAt: new Date() } });
    expect((await listRecoverableAgentRuns()).map(run => run.id)).not.toContain(task.runId);
    await getTestPrisma().agentTask.update({ where: { id: task.id }, data: { executionToken: null, executionClaimedAt: null } });
    await getTestPrisma().manualReview.create({ data: { taskId: task.id, sessionId, userId: 'user_liming', activeKey: `task:${task.id}`,
      title: 'Review workflow', reason: 'Review the original operation', operatorId: 'operator_demo', operatorName: 'Demo operator', status: 'open' } });
    expect((await listRecoverableAgentRuns()).map(run => run.id)).not.toContain(task.runId);
  });
});

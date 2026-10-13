import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolInvocation } from '@prisma/client';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { confirmAction } from '@/agent';

useFreshDatabase();
const activeChildren = new Set<ChildProcess>();
const driver = path.join(process.cwd(), 'tests/helpers/restart-process.ts');

interface ProcessMessage {
  type: string;
  runId?: string;
  sessionId?: string;
  message?: string;
  modelCalls?: number;
  response?: { run: { status: string }; outcomes: unknown[] };
  result?: { outcomes: Array<{ status: string }> };
}

function launch(mode: string, scenario: string, runId = '', sessionId = '') {
  const child = fork(driver, [mode, scenario, runId, sessionId], {
    cwd: process.cwd(), execArgv: ['--import', 'tsx'],
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, LLM_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  activeChildren.add(child);
  const messages: ProcessMessage[] = [];
  const listeners = new Set<() => void>();
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8000); });
  child.stdout?.on('data', () => undefined);
  child.on('message', value => { messages.push(value as ProcessMessage); for (const notify of listeners) notify(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => {
      activeChildren.delete(child);
      for (const notify of listeners) notify();
      resolve({ code, signal });
    });
  });
  return {
    child, exited,
    wait(type: string): Promise<ProcessMessage> {
      return new Promise((resolve, reject) => {
        const finish = () => {
          const found = messages.find(message => message.type === type);
          const fatal = messages.find(message => message.type === 'fatal');
          if (!found && !fatal && child.exitCode === null && child.signalCode === null) return;
          clearTimeout(timer);
          listeners.delete(finish);
          if (found) resolve(found);
          else reject(new Error(fatal?.message ?? `Restart child exited before ${type}. ${diagnostics}`));
        };
        const timer = setTimeout(() => { listeners.delete(finish); reject(new Error(`Restart child did not reach ${type}. ${diagnostics}`)); }, 15000);
        listeners.add(finish);
        finish();
      });
    },
  };
}

afterEach(async () => {
  const remaining = [...activeChildren];
  await Promise.all(remaining.map(child => new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  })));
});

async function crash(scenario: string) {
  const running = launch('start', scenario);
  const barrier = await running.wait('barrier');
  expect(barrier.runId).toBeTruthy();
  expect(barrier.sessionId).toBeTruthy();
  if (scenario === 'partial_model') {
    await expect.poll(() => getTestPrisma().agentRunEvent.count({ where: {
      runId: barrier.runId!, channel: 'raw', eventType: 'message_update',
    } })).toBeGreaterThan(0);
  }
  running.child.kill('SIGKILL');
  expect((await running.exited).signal).toBe('SIGKILL');
  // Advance persisted expiry instead of making the regression wait for the two-minute lease TTL.
  const expired = new Date('2000-01-01T00:00:00Z');
  await getTestPrisma().agentRun.update({ where: { id: barrier.runId! }, data: { leaseExpiresAt: expired } });
  await getTestPrisma().agentSession.update({ where: { id: barrier.sessionId! }, data: { runLeaseExpiresAt: expired } });
  return { runId: barrier.runId!, sessionId: barrier.sessionId! };
}

async function resume(scenario: string, identity: { runId: string; sessionId: string }, worker = false) {
  const running = launch(worker ? 'worker' : 'recover', scenario, identity.runId, identity.sessionId);
  const message = await running.wait(worker ? 'worker_finished' : 'recovered');
  expect((await running.exited).code).toBe(0);
  return message;
}

describe('real service process crash and fresh-process recovery', () => {
  it('continues interrupted narration of an already authorized transfer without executing it again', async () => {
    const identity = await crash('authorization_narration');
    const source = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: identity.runId } });
    expect(JSON.parse(source.requestJson).kind).toBe('authorization_result');
    const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId: identity.sessionId } });
    expect(action.status).toBe('executed');
    const balance = (await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    expect(await getTestPrisma().executionReceipt.count()).toBe(1);
    const recovered = await resume('authorization_narration', identity);
    expect(recovered.response?.run.status).toBe('completed');
    expect(recovered.modelCalls).toBeGreaterThan(0);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(balance);
    expect(await getTestPrisma().executionReceipt.count()).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: identity.sessionId, toolName: 'transfer_money', status: 'success' } })).toBe(1);
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: identity.runId } })).status).toBe('completed');
  });
  it('executes a complete original model decision after crashing before any tool intent was started', async () => {
    const identity = await crash('model_result');
    const model = await getTestPrisma().modelRequest.findFirstOrThrow({ where: { runId: identity.runId } });
    expect(model.status).toBe('completed');
    expect(await getTestPrisma().toolInvocation.count({ where: { runId: identity.runId } })).toBe(0);
    const recovered = await resume('model_result', identity);
    expect(recovered.response?.run.status).toBe('completed');
    const calls = await getTestPrisma().toolInvocation.findMany({ where: { runId: identity.runId } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ callId: 'original-call', modelRequestId: model.id, status: 'completed' });
  });

  it('resumes the original DAG after a committed predecessor without recreating its graph or budget', async () => {
    const identity = await crash('dag_progress');
    const original = await getTestPrisma().agentTask.findFirstOrThrow({ where: { runId: identity.runId } });
    const child = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { taskId: original.id, nodeId: 'budget' } });
    expect(child.status).toBe('completed');
    const recovered = await resume('dag_progress', identity);
    expect(recovered.response?.run.status, recovered.message).toBe('completed');
    expect(await getTestPrisma().agentTask.count({ where: { runId: identity.runId } })).toBe(1);
    expect((await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('success');
    expect(await getTestPrisma().budget.count({ where: { name: 'Crash-safe workflow budget' } })).toBe(1);
    expect(await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({ status: 'completed', operationKey: child.operationKey, attempt: 1 });
    expect(await getTestPrisma().toolInvocation.count({ where: { taskId: original.id, nodeId: 'read', status: 'completed' } })).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: identity.sessionId, toolName: 'reserve_budget', status: 'success' } })).toBe(1);
  });
  it('regenerates an incomplete model response through a recovery worker without replaying a partial tool call', async () => {
    const identity = await crash('partial_model');
    expect(await getTestPrisma().toolInvocation.count({ where: { runId: identity.runId } })).toBe(0);
    const recovered = await resume('partial_model', identity, true);
    expect(recovered.result?.outcomes, recovered.message).toEqual([{ runId: identity.runId, status: 'completed' }]);
    expect(recovered.modelCalls).toBeGreaterThan(0);
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: identity.runId } })).status).toBe('completed');
    expect(await getTestPrisma().toolInvocation.count({ where: { runId: identity.runId, toolName: 'get_balance' } })).toBe(1);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect(await getTestPrisma().agentRun.count({ where: { requestId: 'restart:partial_model' } })).toBe(1);
  });

  it('keeps the original invocation identity when a read intent was saved before the process died', async () => {
    const identity = await crash('read_intent');
    const original = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { runId: identity.runId } });
    expect(original.status).toBe('started');
    const recovered = await resume('read_intent', identity);
    expect(recovered.response?.run.status).toBe('completed');
    expect(recovered.modelCalls).toBeGreaterThan(0);
    const calls = await getTestPrisma().toolInvocation.findMany({ where: { runId: identity.runId } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: original.id, operationKey: original.operationKey, status: 'completed' });
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  });

  it('restores a committed automatic write and continues the model without a second budget or audit', async () => {
    const identity = await crash('committed_write');
    const original = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { runId: identity.runId } });
    const receipt = await getTestPrisma().executionReceipt.findUniqueOrThrow({ where: {
      userId_key: { userId: 'user_liming', key: original.operationKey },
    } });
    const recovered = await resume('committed_write', identity);
    expect(recovered.response?.run.status).toBe('completed');
    expect(recovered.modelCalls).toBeGreaterThan(0);
    expect(await getTestPrisma().budget.count({ where: { name: 'Crash-safe budget' } })).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: identity.sessionId, toolName: 'reserve_budget', status: 'success' } })).toBe(1);
    const calls: ToolInvocation[] = await getTestPrisma().toolInvocation.findMany({ where: { runId: identity.runId } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: original.id, operationKey: original.operationKey, status: 'completed', resultJson: receipt.responseJson });
    expect((await getTestPrisma().executionReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).responseJson).toBe(receipt.responseJson);
  });

  it('retains the original human decision when a process dies after parking a transfer', async () => {
    const identity = await crash('authorization');
    const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId: identity.sessionId } });
    const recovered = await resume('authorization', identity, true);
    expect(recovered.result?.outcomes[0].status).toBe('waiting_confirmation');
    expect(recovered.modelCalls).toBe(0);
    expect(await getTestPrisma().pendingAction.count({ where: { sessionId: identity.sessionId } })).toBe(1);
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('pending');
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    const approved = await confirmAction(action.id, { sessionId: identity.sessionId, userId: 'user_liming' });
    expect(approved.events.some(event => event.type === 'error')).toBe(false);
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('executed');
    expect(await getTestPrisma().executionReceipt.count()).toBe(1);
  });
});

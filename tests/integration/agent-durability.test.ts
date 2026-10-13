import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { NextRequest } from 'next/server';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { AgentRunJournal, beginRun, readRunPresentation, recoverInvocation } from '@/agent/durable';
import { appendRuntimeEvent, restoreInvocationFromReceipt } from '@/lib/db/repositories/agentRun';
import { banking } from '@/banking-sdk';
import { createToolRegistry } from '@/agent/tools';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import type { AgentRunLease } from '@/lib/contracts/runtime';
import { GET as getRun } from '@/app/api/runs/[id]/route';
import { POST as recoverRun } from '@/app/api/runs/[id]/recover/route';
import { createPendingAction } from '@/lib/db/repositories/pendingAction';
import { settlePendingAction } from '@/agent/confirmation-recovery';
import { getOrCreateSession, runTurn } from '@/agent';
import * as executionFence from '@/agent/execution-fence';

const userId = 'user_liming';
beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectTestPrisma);

async function admit(requestId = 'request-1') {
  const session = await getTestPrisma().agentSession.create({ data: { userId, stateJson: '{}' } });
  const input = { sessionId: session.id, userId, requestId, request: { message: 'Read my balance' } };
  const admitted = await beginRun(input);
  if (!admitted.lease) throw new Error('Expected a new execution lease');
  return { input, run: admitted.run, lease: admitted.lease, journal: new AgentRunJournal(admitted.lease) };
}

async function expire(lease: AgentRunLease): Promise<void> {
  const before = new Date('2000-01-01T00:00:00Z');
  await getTestPrisma().agentRun.update({ where: { id: lease.runId }, data: { leaseExpiresAt: before } });
  await getTestPrisma().agentSession.update({ where: { id: lease.sessionId }, data: { runLeaseExpiresAt: before } });
}

describe('durable Agent runtime with real database records', () => {
  it('deduplicates input without re-execution, conflicts on changed input, and releases a failed run', async () => {
    const { input, lease, journal } = await admit();
    expect((await beginRun(input)).lease).toBeUndefined();
    await expect(beginRun({ ...input, request: { message: 'Different request' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(beginRun({ ...input, requestId: 'another-input' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await journal.finish('failed', 'TIMEOUT');
    const session = await getTestPrisma().agentSession.findUniqueOrThrow({ where: { id: lease.sessionId } });
    expect(session.activeRunId).toBeNull();
    expect((await beginRun(input)).lease).toBeUndefined();
    const recovered = await beginRun({ ...input, recover: true });
    expect(recovered.run.id).toBe(lease.runId);
    expect(recovered.lease?.token).not.toBe(lease.token);
    await new AgentRunJournal(recovered.lease!).finish('completed');
  });

  it('stores every Pi event and each model delta before a grounded listener changes the message', async () => {
    const { journal, run } = await admit();
    const transport = fauxProvider(), models = createModels();
    models.setProvider(transport.provider);
    transport.setResponses([fauxAssistantMessage('Raw model planning text')]);
    const agent = new Agent({ streamFn: models.streamSimple.bind(models), initialState: { model: transport.getModel(), tools: [] } });
    const observed: string[] = [];
    journal.subscribe(agent);
    agent.subscribe(event => {
      observed.push(event.type);
      if (event.type === 'message_end' && event.message.role === 'assistant') event.message.content = [{ type: 'text', text: 'Grounded bank result' }];
    });
    await agent.prompt('Read my balance');
    await journal.recordEvent('message_update', { thinking: 'Internal reasoning evidence' });
    await journal.recordPresentationEvent({ type: 'message_end', message: { content: 'Grounded bank result' } });
    await journal.finish('completed');
    const raw = await getTestPrisma().agentRunEvent.findMany({ where: { runId: run.id, channel: 'raw' }, orderBy: { sequence: 'asc' } });
    expect(raw.slice(0, -1).map(event => event.eventType)).toEqual(observed);
    expect(raw.filter(event => event.eventType === 'message_update').length).toBeGreaterThan(1);
    expect(raw.some(event => event.payloadJson.includes('Raw model planning text'))).toBe(true);
    const page = await readRunPresentation(run.id, userId);
    expect(page.events).toHaveLength(1);
    expect(JSON.stringify(page)).toContain('Grounded bank result');
    expect(JSON.stringify(page)).not.toContain('Internal reasoning evidence');
    await expect(readRunPresentation(run.id, 'other-owner')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps invocation and operation identities across a lease takeover and rejects the stale process', async () => {
    const { input, lease, journal } = await admit();
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'provider-call-1', toolName: 'transfer_money', args: { contactId: 'contact_zhangwei', amount: '200.00' } });
    const original = journal.invocationForCall('provider-call-1')!;
    await expire(lease);
    const reclaimed = await beginRun(input);
    expect(reclaimed.run.id).toBe(lease.runId);
    const persisted = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: original.id } });
    expect(persisted.operationKey).toBe(original.operationKey);
    expect(persisted.ordinal).toBe(original.ordinal);
    expect(persisted.status).toBe('needs_reconciliation');
    await expect(appendRuntimeEvent(lease, { channel: 'raw', eventType: 'late_event', payloadJson: '{}' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const execute = vi.fn();
    const recovered = await recoverInvocation(reclaimed.lease!, original.id, { execute, readVerifiedReceipt: async () => undefined });
    expect(recovered.action).toBe('reconciliation_required');
    expect(execute).not.toHaveBeenCalled();
    await new AgentRunJournal(reclaimed.lease!).finish('interrupted');
  });

  it('retains a parked invocation when Pi reports its blocked call as an error', async () => {
    const { journal, lease } = await admit();
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'transfer_money', args: { amount: '200.00' } });
    const invocation = journal.invocationForCall('call-1')!;
    await journal.parkInvocation('call-1', 'waiting_confirmation', 'pending-command-1');
    await journal.recordAgentEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'transfer_money', result: { content: [{ type: 'text', text: 'Awaiting confirmation' }], details: {} }, isError: true });
    const parked = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(parked.status).toBe('waiting_confirmation');
    expect(parked.operationKey).toBe('pending-command-1');
    expect(parked.finishedAt).toBeNull();
    await journal.finish('waiting_confirmation');
    expect((await getTestPrisma().agentSession.findUniqueOrThrow({ where: { id: lease.sessionId } })).activeRunId).toBeNull();
  });

  it('replays the complete committed command after interruption without another debit', async () => {
    const { input, lease, journal } = await admit();
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'transfer_money', args: { contactId: 'contact_zhangwei', amount: '200.00' } });
    const invocation = journal.invocationForCall('call-1')!;
    const original = await createToolRegistry(userId).executeDirect('transfer_money',
      { contactId: 'contact_zhangwei', amount: '200.00' },
      { sessionId: lease.sessionId, idempotencyKey: invocation.operationKey });
    expect(original.ok).toBe(true);
    const receipt = await getTestPrisma().executionReceipt.findUniqueOrThrow({ where: { userId_key: { userId, key: invocation.operationKey } } });
    expect(receipt.responseJson).toBe(JSON.stringify(original));
    expect(receipt.commandDigest).not.toBeNull();
    expect((await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).status).toBe('completed');
    await expect(restoreInvocationFromReceipt({ invocationId: invocation.id, userId, toolName: invocation.toolName, operationKey: invocation.operationKey, resultJson: '{"fabricated":true}' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expire(lease);
    const reclaimed = await beginRun(input);
    const execute = vi.fn();
    const result = await recoverInvocation(reclaimed.lease!, invocation.id, { execute, readVerifiedReceipt: async () => receipt.responseJson! });
    expect(result).toMatchObject({ action: 'replayed', resultJson: receipt.responseJson });
    expect(execute).not.toHaveBeenCalled();
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2338000n);
    expect(await getTestPrisma().transaction.count({ where: { userId, counterpartyId: 'contact_zhangwei', amountMinor: -20000n } })).toBe(1);
    expect((await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).status).toBe('completed');
    expect(await getTestPrisma().agentRunEvent.count({ where: { runId: lease.runId, eventType: 'invocation_recovered' } })).toBe(1);
    await new AgentRunJournal(reclaimed.lease!).finish('completed');
  });

  it('recovers an interrupted read through the real owned HTTP endpoint with the same invocation identity', async () => {
    const { run, lease, journal } = await admit();
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'call-read', toolName: 'get_balance', args: {} });
    const original = journal.invocationForCall('call-read')!;
    await journal.finish('interrupted');
    const context = { params: Promise.resolve({ id: run.id }) };
    expect((await getRun(new NextRequest(`http://localhost/api/runs/${run.id}`), context)).status).toBe(403);
    const response = await recoverRun(new NextRequest(`http://localhost/api/runs/${run.id}/recover`, {
      method: 'POST', headers: { cookie: `banking_session=${lease.sessionId}` }, body: '{}',
    }), context);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      run: { id: run.id, status: 'completed' }, outcomes: [{ invocationId: original.id, action: 'retried' }],
    });
    const recovered = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: original.id } });
    expect(recovered.operationKey).toBe(original.operationKey);
    expect(recovered.attempt).toBe(2);
    expect(JSON.parse(recovered.resultJson!)).toMatchObject({ ok: true, data: { totalAvailable: '73580.00' } });
    expect(await getTestPrisma().agentRun.count()).toBe(1);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect((await getTestPrisma().agentSession.findUniqueOrThrow({ where: { id: lease.sessionId } })).activeRunId).toBeNull();
  });

  it('synchronizes an authorized gated read from its durable action result and retains that fact on duplicate settlement', async () => {
    const { run, lease, journal } = await admit();
    await journal.recordAgentEvent({ type: 'tool_execution_start', toolCallId: 'call-read', toolName: 'list_subscriptions', args: {} });
    const invocation = journal.invocationForCall('call-read')!;
    const action = await createPendingAction({
      sessionId: lease.sessionId, userId, invocationId: invocation.id, toolName: 'list_subscriptions', args: {},
      status: 'confirmed', tier: 'YELLOW', requiresMfa: false,
      summary: { title: 'List subscriptions', toolName: 'list_subscriptions', tier: 'YELLOW', requiresMfa: false, fields: [] },
    });
    await journal.parkInvocation('call-read', 'waiting_confirmation', action.id);
    await journal.finish('waiting_confirmation');
    const subscriptions = await banking.subscription.listSubscriptions(userId);
    const result = { ok: true, data: subscriptions, summary: 'Subscription read completed' };
    await settlePendingAction({ actionId: action.id, status: 'executed', result, from: ['confirmed'] });
    const completed = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(completed.status).toBe('completed');
    expect(JSON.parse(completed.resultJson!)).toEqual(result);
    await settlePendingAction({ actionId: action.id, status: 'executed', result, from: ['executed'] });
    expect(await getTestPrisma().agentRunEvent.count({ where: { runId: run.id, eventType: 'invocation_settled_from_action' } })).toBe(1);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect((await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('waiting_confirmation');
  });

  it('fences an automatic plan-node bank write when its owning Agent run expires before the command transaction', async () => {
    const session = await getOrCreateSession(userId);
    const provider = fauxProvider(), models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses([fauxAssistantMessage([fauxToolCall('submit_plan', {
      goal: 'Create two budgets', nodes: [
        { id: 'first', name: 'Travel budget', kind: 'tool', tool: 'reserve_budget', args: { name: 'Expired run budget', amount: '10.00' }, dependencies: [] },
        { id: 'second', name: 'Tuition budget', kind: 'tool', tool: 'reserve_budget', args: { name: 'Dependent budget', amount: '20.00' }, dependencies: ['first'] },
      ],
    })], { stopReason: 'toolUse' })]);
    let reach!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { reach = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const capture = executionFence.buildAutomaticWriteFence;
    const barrier = vi.spyOn(executionFence, 'buildAutomaticWriteFence').mockImplementation(async (...args) => {
      const fence = await capture(...args);
      if (args[2] === 'first') { reach(); await resume; }
      return fence;
    });
    const pending = runTurn({ sessionId: session.sessionId, message: '预留10元旅行预算，然后预留20元学费预算' }, {
      provider: { model: provider.getModel(), streamFn: models.streamSimple.bind(models) },
    }).then(result => ({ result }), error => ({ error }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([reached, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Plan-node write fence was not reached')), 7000);
      })]);
      const run = await getTestPrisma().agentRun.findFirstOrThrow({ where: { sessionId: session.sessionId, status: 'running' } });
      const expired = new Date('2000-01-01T00:00:00Z');
      await getTestPrisma().agentRun.update({ where: { id: run.id }, data: { leaseExpiresAt: expired } });
      await getTestPrisma().agentSession.update({ where: { id: session.sessionId }, data: { runLeaseExpiresAt: expired } });
    } finally { clearTimeout(timeout); release(); await pending; barrier.mockRestore(); }
    expect(await getTestPrisma().budget.count({ where: { name: { in: ['Expired run budget', 'Dependent budget'] } } })).toBe(0);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect(await getTestPrisma().auditLog.count({ where: { toolName: 'reserve_budget', status: 'success' } })).toBe(0);
  });
});

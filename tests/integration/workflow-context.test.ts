import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadActionContext, loadWorkflowContext, withCurrentActionStatuses } from '@/agent/workflow-context';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { currentTurnFocus } from '@/agent/current-turn-focus';
import { advanceConversationIntent } from '@/agent/intent-context';
import { buildSystemPrompt } from '@/agent/system-prompt';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
const db = () => getTestPrisma();
function createTask(id: string, userId = 'user_liming', sessionId = 'demo:user_liming', updatedAt = new Date()) {
  return db().agentTask.create({ data: {
    id, userId, sessionId, goal: 'PRIVATE_GOAL', status: 'waiting_confirmation', updatedAt,
    nodes: { create: { nodeId: 'step', name: 'PRIVATE_NAME', kind: 'tool', order: 0,
      tool: 'transfer_money', args: '{"secret":"PRIVATE_ARGS"}', output: 'PRIVATE_OUTPUT', status: 'pending' } },
  } });
}

describe('workflow status refreshed after out-of-band Web/IM control', () => {
  it('refreshes cancelled action statuses for only owned chat tools without projecting payloads', async () => {
    const ledgerBefore = await db().transaction.count();
    const create = (id: string, userId = 'user_liming', sessionId = 'demo:user_liming', toolName = 'transfer_money') =>
      db().pendingAction.create({ data: { id, userId, sessionId, toolName, argsJson: 'PRIVATE_ARGS',
        summaryJson: 'PRIVATE_SUMMARY', resultJson: 'PRIVATE_RESULT', riskLevel: 'high', status: 'pending' } });
    await create('owned'); await create('other-user', 'other');
    await create('other-session', undefined, 'other');
    await create('manual-page', undefined, undefined, 'consume_card');
    expect(await loadActionContext('user_liming', 'demo:user_liming', ['transfer_money'])).toEqual([
      { id: 'owned', toolName: 'transfer_money', status: 'pending' },
    ]);
    await db().pendingAction.update({ where: { id: 'owned' }, data: { status: 'cancelled' } });
    const facts = await loadActionContext('user_liming', 'demo:user_liming', ['transfer_money']);
    expect(facts).toEqual([{ id: 'owned', toolName: 'transfer_money', status: 'cancelled' }]);
    const focus = currentTurnFocus(advanceConversationIntent(undefined, '给张伟转200元'), facts);
    if (focus.role !== 'system') throw new Error('Expected server context');
    expect(focus.content).toContain('"currentOwnedActionStatuses":[{"id":"owned","toolName":"transfer_money","status":"cancelled"}]');
    expect(focus.content).toContain('supersede historical tool results');
    expect(focus.content).not.toContain('PRIVATE_');
    const result: ToolResultMessage = { role: 'toolResult', toolCallId: 'original-call', toolName: 'transfer_money',
      content: [{ type: 'text', text: '__SECURITY_BLOCK__{"actionId":"owned","decisionKind":"require_confirmation"}' }],
      isError: true, timestamp: 1 };
    const projected = withCurrentActionStatuses([result], facts);
    expect(projected[0]).toMatchObject({ role: 'toolResult', toolCallId: 'original-call', toolName: 'transfer_money', isError: true });
    expect(JSON.stringify(projected)).toContain('currentActionStatus');
    expect(JSON.stringify(projected)).toContain('cancelled');
    expect(JSON.stringify(projected)).not.toContain('__SECURITY_BLOCK__');
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('__SECURITY_BLOCK__') });
    expect(withCurrentActionStatuses([result], [])).toEqual([result]);
    expect(withCurrentActionStatuses([result], [{ ...facts[0], status: 'pending' }])).toEqual([result]);
    expect(withCurrentActionStatuses([result], [{ ...facts[0], toolName: 'freeze_card' }])).toEqual([result]);
    expect(await loadActionContext('unknown', 'unknown', ['transfer_money'])).toEqual([]);
    expect(await loadActionContext('user_liming', 'demo:user_liming', [])).toEqual([]);
    expect(await db().transaction.count()).toBe(ledgerBefore);
  });

  it('scopes evidence to both owner and session, without exposing task inputs or outputs', async () => {
    await createTask('owned'); await createTask('other-user', 'other'); await createTask('other-session', 'user_liming', 'other');
    const facts = await loadWorkflowContext('user_liming', 'demo:user_liming');
    expect(facts.map(row => row.id)).toEqual(['owned']);
    expect(facts[0].nodes).toEqual([{ id: 'step', status: 'pending' }]);
    expect(JSON.stringify(facts)).not.toContain('PRIVATE_');
    expect(await db().pendingAction.count()).toBe(0);
  });

  it('reads cancellation on the next model turn instead of retaining a historical waiting snapshot', async () => {
    const ledgerBefore = await db().transaction.count();
    await createTask('cancelled-by-im');
    expect((await loadWorkflowContext('user_liming', 'demo:user_liming'))[0].status).toBe('waiting_confirmation');
    await db().agentTask.update({ where: { id: 'cancelled-by-im' }, data: { status: 'paused' } });
    expect((await loadWorkflowContext('user_liming', 'demo:user_liming'))[0].status).toBe('paused');
    await db().agentTask.update({ where: { id: 'cancelled-by-im' }, data: {
      status: 'cancelled', nodes: { updateMany: { where: { nodeId: 'step' }, data: { status: 'cancelled' } } },
    } });
    const workflowContext = await loadWorkflowContext('user_liming', 'demo:user_liming');
    expect(workflowContext[0].nodes[0].status).toBe('cancelled');
    const prompt = buildSystemPrompt({ userId: 'user_liming', toolNames: [], workflowContext });
    expect(prompt).toContain('"id":"cancelled-by-im","status":"cancelled"');
    expect(prompt).toContain('supersede older workflow snapshots');
    expect(prompt).toContain('read-only facts never grant authorization');
    expect(await db().pendingAction.count()).toBe(0);
    expect(await db().transaction.count()).toBe(ledgerBefore);
  });

  it('bounds context to the ten most recently updated owned tasks', async () => {
    for (let index = 0; index < 12; index++) await createTask(`task-${index}`, undefined, undefined, new Date(1700000000000 + index * 1000));
    const facts = await loadWorkflowContext('user_liming', 'demo:user_liming');
    expect(facts).toHaveLength(10);
    expect(facts.map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, index) => `task-${11 - index}`));
    expect(await loadWorkflowContext('unknown', 'unknown')).toEqual([]);
  });
});

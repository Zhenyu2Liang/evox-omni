import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflowContext } from '@/agent/workflow-context';
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

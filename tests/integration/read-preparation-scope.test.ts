import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runTurn, confirmAction, loadSession } from '@/agent';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { scriptedProvider, turnDeclaration } from '@/tests/helpers/scripted-provider';

useFreshDatabase();
const config = { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'user_liming' };

describe('binding write scope after an authorized prerequisite read', () => {
  it('binds every subscription once after lookup and requires a separate decision for every cancellation', async () => {
    const db = getTestPrisma();
    const subscriptions = await db.subscription.findMany({ where: { userId: config.demoUserId, status: 'ACTIVE' }, orderBy: { id: 'asc' } });
    const writes = subscriptions.map(() => 'cancel_subscription');
    const nodes = subscriptions.map((subscription, index) => ({ id: `cancel-${index}`, name: `Cancel ${subscription.name}`,
      kind: 'tool', tool: 'cancel_subscription', args: { subscriptionId: subscription.id },
      dependencies: index ? [`cancel-${index - 1}`] : [] }));
    const script = scriptedProvider({ purpose: 'operation', operations: ['list_subscriptions'] }, [
      fauxAssistantMessage([fauxToolCall('list_subscriptions', {})], { stopReason: 'toolUse' }),
      turnDeclaration({ purpose: 'operation', operations: writes, workflow: true }),
      fauxAssistantMessage([fauxToolCall('submit_plan', { goal: 'Cancel all active subscriptions', nodes })], { stopReason: 'toolUse' }),
    ]);
    const request = 'Cancel all active subscriptions.';
    const turn = await runTurn({ message: request }, { config, provider: script.provider });
    const read = await db.pendingAction.findFirstOrThrow({ where: { sessionId: turn.sessionId, toolName: 'list_subscriptions' } });
    expect(await db.agentTask.count()).toBe(0);
    expect(await db.subscription.count({ where: { status: 'ACTIVE' } })).toBe(subscriptions.length);
    const outcome = await confirmAction(read.id, { sessionId: turn.sessionId, userId: config.demoUserId,
      deps: { config, provider: script.provider } });
    expect(outcome.ok).toBe(true);
    expect(await db.agentTask.count()).toBe(1);
    expect(await db.subscription.count({ where: { status: 'ACTIVE' } })).toBe(subscriptions.length);
    expect(script.calls()).toBe(4);
    const saved = await loadSession(turn.sessionId);
    expect(saved?.intent?.latestMessage).toBe(request);
    expect(saved?.intent?.steps.map(step => step.tool)).toEqual(writes);
    for (let index = 0; index < subscriptions.length; index++) {
      const pending = await db.pendingAction.findFirstOrThrow({ where: { sessionId: turn.sessionId,
        toolName: 'cancel_subscription', status: 'pending' } });
      expect((await confirmAction(pending.id, { sessionId: turn.sessionId, userId: config.demoUserId,
        deps: { config, provider: script.provider } })).ok).toBe(true);
      expect(await db.subscription.count({ where: { status: 'CANCELLED' } })).toBe(index + 1);
    }
    expect(script.calls()).toBe(4);
    expect(await db.toolInvocation.count({ where: { toolName: 'list_subscriptions' } })).toBe(1);
    expect(await db.auditLog.count({ where: { sessionId: turn.sessionId, toolName: 'cancel_subscription', status: 'success' } })).toBe(subscriptions.length);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readConversationPlans } from '@/app/agent/plan-history';
import type { SessionSnapshot } from '@/agent/session';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import { toolPresentationId } from '@/agent/tool-presentation-identity';

const database = vi.hoisted(() => ({ tasks: vi.fn(), events: vi.fn(), invocations: vi.fn(), actions: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { agentTask: { findMany: database.tasks },
  agentRunEvent: { findMany: database.events }, toolInvocation: { findMany: database.invocations },
  pendingAction: { findMany: database.actions } } }));
vi.mock('@/app/api/_lib/task-plans', () => ({ toTaskPlan: (row: { snapshot: TaskPlan }) => row.snapshot }));

const plan: TaskPlan = { id: 'plan-one', sessionId: 'demo:user', goal: 'Freeze both cards', status: 'success',
  nodes: [], results: [], createdAt: 20, updatedAt: 30, generation: 2 };
const snapshot = { sessionId: 'demo:user', userId: 'user', historyStartedAt: 5 } as SessionSnapshot;
const task = { id: plan.id, runId: 'owner-run', parentInvocationId: 'owner-invocation', snapshot: plan };
const ownerMessageId = toolPresentationId('owner-run', 'owner-model', 'reused-call');
const tool = (id: string, timestamp: number): ChatMessage => ({ id, role: 'tool', content: '', timestamp,
  toolEvents: [{ toolCallId: 'reused-call', toolName: 'submit_plan', messageId: id, status: 'success' }] });

beforeEach(() => {
  database.tasks.mockReset().mockResolvedValue([task]);
  database.events.mockReset().mockResolvedValue([
    { runId: 'owner-run', payloadJson: JSON.stringify({ message: { id: ownerMessageId } }) },
    { runId: 'new-run', payloadJson: JSON.stringify({ message: { id: 'new-message' } }) },
  ]);
  database.invocations.mockReset().mockResolvedValue([{ id: 'owner-invocation', callId: 'reused-call', runId: 'owner-run', modelRequestId: 'owner-model' }]);
  database.actions.mockReset().mockResolvedValue([]);
});

describe('server plan history restoration', () => {
  it('restores authoritative completed results to their exact run and call owner on refresh', async () => {
    const restored = await readConversationPlans(snapshot, [tool(ownerMessageId, 10), tool('new-message', 40)]);
    expect(restored[0].cards?.[0]).toMatchObject({ type: 'plan', plan: { status: 'success', generation: 2 } });
    expect(restored[1].cards).toEqual([]);
    expect(database.tasks).toHaveBeenCalledWith(expect.objectContaining({ where: {
      sessionId: 'demo:user', userId: 'user', createdAt: { gte: new Date(5) },
    } }));
  });

  it('updates the existing historical card instead of resurrecting an extra copy at the bottom', async () => {
    const existing = { ...tool(ownerMessageId, 10), cards: [{ type: 'plan' as const,
      plan: { ...plan, status: 'waiting_confirmation' as const, generation: 1 } }] };
    const restored = await readConversationPlans(snapshot, [existing, tool('new-message', 40)]);
    expect(restored.flatMap(message => message.cards ?? []).filter(card => card.type === 'plan')).toHaveLength(1);
    expect(restored[0].cards?.[0]).toMatchObject({ plan: { status: 'success' } });
    expect(restored.at(-1)?.cards).toEqual([]);
  });

  it('positions a crash-orphaned plan chronologically when there is no provider message', async () => {
    database.events.mockResolvedValue([]);
    const restored = await readConversationPlans(snapshot, [{ id: 'request', role: 'user', content: 'Freeze both cards', timestamp: 10 },
      tool('new-message', 40)]);
    expect(restored.map(message => message.id)).toEqual(['request', `plan-history-${plan.id}`, 'new-message']);
    expect(restored.at(-1)?.cards).toEqual([]);
  });

  it('keeps the original run when authorization narration republishes an old message', async () => {
    database.events.mockResolvedValue([
      { runId: 'owner-run', payloadJson: JSON.stringify({ message: { id: ownerMessageId } }) },
      { runId: 'authorization-run', payloadJson: JSON.stringify({ message: { id: ownerMessageId } }) },
    ]);
    const restored = await readConversationPlans(snapshot, [tool(ownerMessageId, 10), tool('new-message', 40)]);
    expect(restored.map(message => message.id)).toEqual([ownerMessageId, 'new-message']);
    expect(restored[0].cards?.[0]).toMatchObject({ type: 'plan', plan: { status: 'success' } });
  });

  it('reads all issued plan actions by owner and restores their status beside the original plan', async () => {
    const withNodes: TaskPlan = { ...plan,
      nodes: [{ id: 'freeze', name: 'Freeze credit card', kind: 'tool', tool: 'freeze_card', dependencies: [] }],
      results: [{ id: 'freeze', name: 'Freeze credit card', tool: 'freeze_card', status: 'success', output: { cardId: 'credit' } }],
    };
    database.tasks.mockResolvedValue([{ ...task, snapshot: withNodes }]);
    database.actions.mockResolvedValue([{ id: 'permission', taskId: plan.id, nodeId: 'freeze', toolName: 'freeze_card',
      status: 'executed', riskLevel: 'RED', requiresMfa: true,
      summaryJson: JSON.stringify({ title: 'Freeze credit card', toolName: 'freeze_card', tier: 'RED', requiresMfa: true, fields: [] }),
    }]);
    const restored = await readConversationPlans(snapshot, [tool(ownerMessageId, 10), tool('new-message', 40)]);
    expect(restored[0].cards?.[1]).toMatchObject({ type: 'mfa', actionId: 'permission', status: 'executed' });
    expect(restored[1].cards).toEqual([]);
    expect(database.actions).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 'demo:user', userId: 'user', taskId: { in: [plan.id] } },
    }));
  });

  it('does not read journals or reconstruct old tasks after developer history clearing', async () => {
    database.tasks.mockResolvedValue([]);
    const restored = await readConversationPlans({ ...snapshot, historyStartedAt: 100 }, []);
    expect(restored).toEqual([]);
    expect(database.tasks).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: new Date(100) } }) }));
    expect(database.events).not.toHaveBeenCalled();
    expect(database.invocations).not.toHaveBeenCalled();
    expect(database.actions).not.toHaveBeenCalled();
  });
});

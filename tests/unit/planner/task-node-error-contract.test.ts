import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { Prisma } from '@/lib/db/prisma';

const update = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { agentTaskNode: { update } } }));

import { updateTaskNode } from '@/lib/db/repositories/task';
import { isMissingNodeError } from '@/agent/task-fencing';

describe('task node error contract', () => {
  it('maps a structured Prisma missing-record error to the node resource', async () => {
    update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Localized database message', {
      code: 'P2025', clientVersion: '7.10.0',
    }));
    const error = await updateTaskNode('task', 'node', { status: 'failed' }).catch(value => value);
    expect(error).toMatchObject({ code: 'NOT_FOUND', detail: { resource: 'AgentTaskNode', taskId: 'task', nodeId: 'node' } });
    expect(isMissingNodeError(error)).toBe(true);
  });

  it('does not suppress errors whose prose resembles a missing-node message', () => {
    expect(isMissingNodeError(new Error('AgentTaskNode not found: misleading text'))).toBe(false);
    expect(isMissingNodeError(new AppError('INTERNAL', 'AgentTaskNode not found'))).toBe(false);
    expect(isMissingNodeError(new AppError('NOT_FOUND', 'Missing account', { resource: 'Account' }))).toBe(false);
  });

  it('retains database failures that are not missing records', async () => {
    const original = new Error('Connection unavailable');
    update.mockRejectedValueOnce(original);
    await expect(updateTaskNode('task', 'node', { status: 'failed' })).rejects.toBe(original);
  });
});

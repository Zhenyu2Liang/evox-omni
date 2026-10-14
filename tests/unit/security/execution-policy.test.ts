import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/db/client';
import { assertSessionMayWrite } from '@/security/execution-policy';

const ports = vi.hoisted(() => ({ findSession: vi.fn(), locked: vi.fn(), fallback: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ dbClient: ports.fallback }));
vi.mock('@/security/circuit-breaker', () => ({ isLocked: ports.locked }));
const transaction = { agentSession: { findUnique: ports.findSession } } as unknown as DbClient;

beforeEach(() => {
  vi.clearAllMocks();
  ports.findSession.mockResolvedValue({ userId: 'original-owner', status: 'active' });
  ports.locked.mockResolvedValue(false);
  ports.fallback.mockReturnValue(transaction);
});

describe('mutation session policy', () => {
  it('uses the supplied transaction for ownership and breaker checks instead of falling back to another connection', async () => {
    await assertSessionMayWrite('original-session', transaction, 'original-owner');
    expect(ports.findSession).toHaveBeenCalledWith({ where: { id: 'original-session' }, select: { userId: true, status: true } });
    expect(ports.locked).toHaveBeenCalledWith('original-session', transaction);
    expect(ports.fallback).not.toHaveBeenCalled();
  });
  it.each([null, { userId: 'original-owner', status: 'closed' }, { userId: 'replacement', status: 'active' }])('fails closed for a missing, inactive or changed-owner session: %j', async session => {
    ports.findSession.mockResolvedValue(session);
    await expect(assertSessionMayWrite('original-session', transaction, 'original-owner')).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    expect(ports.locked).not.toHaveBeenCalled();
  });
  it('still denies an active owned session whose breaker has locked', async () => {
    ports.locked.mockResolvedValue(true);
    await expect(assertSessionMayWrite('original-session', transaction, 'original-owner')).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  });
});

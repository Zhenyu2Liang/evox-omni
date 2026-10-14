import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getDemoSession, executeGatedTool } from '@/agent';
import { createToolRegistry } from '@/agent/tools';
import { runSubmitPlan } from '@/agent/tools/planning';
import { proposeCardChange, verifyCardChange, cancelCardChange, listCardChanges, addDemoCardSchema } from '@/security/manual-card-management';
import { POST as addPost } from '@/app/api/cards/route';
import { DELETE as deleteCard } from '@/app/api/cards/[id]/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { auditStore } from '@/audit/audit-logger';
import { MFA_CODE } from '@/lib/constants';
import { resetDemoSession } from '@/security/circuit-breaker';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, getJson, idCtx, postJson } from './harness';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
async function identity() {
  const session = await getDemoSession(DEMO_USER_ID);
  return { userId: session.userId, sessionId: session.sessionId };
}
async function add(type: 'DEBIT' | 'CREDIT' | 'VIRTUAL' = 'DEBIT') {
  return proposeCardChange(await identity(), { requestId: randomUUID(), type, ...(type === 'CREDIT' ? { creditLimit: '200.00' } : {}) });
}

describe('manual-only demo card management', () => {
  it.each(['DEBIT', 'CREDIT', 'VIRTUAL'] as const)('creates a %s demo record only after its own verification', async type => {
    const database = getTestPrisma();
    const initial = await database.card.count();
    const proposal = await add(type);
    expect(await database.card.count()).toBe(initial);
    const denied = await verifyCardChange(await identity(), proposal.change.id, '000000');
    expect(denied.ok).toBe(false);
    expect(await database.card.count()).toBe(initial);
    const result = await verifyCardChange(await identity(), proposal.change.id, MFA_CODE);
    expect(result).toMatchObject({ ok: true, change: { status: 'executed', card: { type, status: 'ACTIVE' } } });
    expect(result.change.card?.numberMasked).toMatch(/^\*{4}\d{4}$/);
    const row = await database.card.findUniqueOrThrow({ where: { id: result.change.card!.id } });
    if (type === 'CREDIT') expect(row.creditLimitMinor).toBe(20000n);
    expect(await database.card.count()).toBe(initial + 1);
    const audit = await database.auditLog.findFirstOrThrow({ where: { toolName: 'manual_add_card', status: 'success' } });
    expect(audit).toMatchObject({ userId: DEMO_USER_ID, riskLevel: 'RED', confirmed: true, mfaRequired: true, mfaResult: 'success' });
    expect(await database.executionReceipt.count({ where: { toolName: 'manual_add_card' } })).toBe(1);
  });

  it('replays proposals and committed results without duplicate cards, audits or verification attempts', async () => {
    const owner = await identity();
    const input = { requestId: randomUUID(), type: 'VIRTUAL' as const, monthlyLimit: '200.00' };
    const first = await proposeCardChange(owner, input);
    expect((await proposeCardChange(owner, input)).change.id).toBe(first.change.id);
    const committed = await verifyCardChange(owner, first.change.id, MFA_CODE);
    const repeated = await verifyCardChange(owner, first.change.id, '000000');
    expect(repeated.change.card).toEqual(committed.change.card);
    expect((await proposeCardChange(owner, input)).change.status).toBe('executed');
    expect(await getTestPrisma().card.count({ where: { type: 'VIRTUAL' } })).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { toolName: 'manual_add_card', status: 'success' } })).toBe(1);
    await expect(proposeCardChange(owner, { ...input, monthlyLimit: '201.00' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('requires a separate challenge for every proposal', async () => {
    const first = await add(); const second = await add();
    await verifyCardChange(await identity(), first.change.id, MFA_CODE);
    expect((await getTestPrisma().mfaChallenge.findUniqueOrThrow({ where: { actionId: second.change.id } })).status).toBe('pending');
    expect((await listCardChanges(await identity())).map(row => row.id)).toEqual([second.change.id]);
  });

  it('restores the owner-wide lock on refresh and renews pending challenges only after a developer reset', async () => {
    const first = await add(); const second = await add(); const owner = await identity();
    await verifyCardChange(owner, first.change.id, '000000');
    await verifyCardChange(owner, first.change.id, '000000');
    expect((await verifyCardChange(owner, first.change.id, '000000')).locked).toBe(true);
    expect((await listCardChanges(owner)).every(change => change.status === 'locked')).toBe(true);
    await expect(verifyCardChange(owner, second.change.id, MFA_CODE)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    await resetDemoSession(owner.sessionId);
    expect((await listCardChanges(owner)).every(change => change.status === 'pending')).toBe(true);
    expect((await verifyCardChange(owner, first.change.id, MFA_CODE)).ok).toBe(true);
  });

  it('rejects a foreign workspace and leaves the original challenge untouched', async () => {
    const proposal = await add(); const owner = await identity();
    await expect(verifyCardChange({ ...owner, sessionId: 'other-workspace' }, proposal.change.id, MFA_CODE)).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    await expect(cancelCardChange({ ...owner, userId: 'other-user' }, proposal.change.id)).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    expect((await getTestPrisma().mfaChallenge.findUniqueOrThrow({ where: { actionId: proposal.change.id } })).status).toBe('pending');
  });

  it('deletes a debt-free demo record but keeps committed receipts and audit history', async () => {
    const owner = await identity();
    const first = await add('CREDIT');
    const created = await verifyCardChange(owner, first.change.id, MFA_CODE);
    const proposal = await proposeCardChange(owner, { requestId: randomUUID(), cardId: created.change.card!.id });
    const deleted = await verifyCardChange(owner, proposal.change.id, MFA_CODE);
    expect(deleted.change.card).toEqual(created.change.card);
    expect(await getTestPrisma().card.findUnique({ where: { id: created.change.card!.id } })).toBeNull();
    expect((await verifyCardChange(owner, proposal.change.id, '000000')).change.card).toEqual(created.change.card);
    expect(await getTestPrisma().executionReceipt.count()).toBe(2);
    expect(await getTestPrisma().auditLog.count({ where: { status: 'success', toolName: { in: ['manual_add_card', 'manual_delete_card'] } } })).toBe(2);
  });

  it('rejects deletion with credit debt and does not consume authorization on rollback', async () => {
    const owner = await identity();
    const proposal = await proposeCardChange(owner, { requestId: randomUUID(), cardId: 'card_credit' });
    await getTestPrisma().card.update({ where: { id: 'card_credit' }, data: { availableLimitMinor: 0n } });
    const card = await getTestPrisma().card.findUniqueOrThrow({ where: { id: 'card_credit' } });
    expect(card.creditLimitMinor).not.toBe(card.availableLimitMinor);
    await expect(verifyCardChange(owner, proposal.change.id, MFA_CODE)).rejects.toMatchObject({ code: 'CONFLICT' });
    const pending = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: proposal.change.id }, include: { mfa: true } });
    expect(pending.status).toBe('awaiting_mfa');
    expect(pending.mfa?.consumedAt).toBeNull();
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  });

  it('rejects deletion while an unresolved card operation exists', async () => {
    const owner = await identity();
    await executeGatedTool({ ...owner, toolName: 'freeze_card', args: { cardId: 'card_debit' }, userRequest: 'Freeze debit card' });
    await expect(proposeCardChange(owner, { requestId: randomUUID(), cardId: 'card_debit' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await getTestPrisma().card.findUnique({ where: { id: 'card_debit' } })).not.toBeNull();
  });

  it('rejects known credit debt before creating a proposal or issuing a challenge', async () => {
    await getTestPrisma().card.update({ where: { id: 'card_credit' }, data: { availableLimitMinor: 0n } });
    await expect(proposeCardChange(await identity(), { requestId: randomUUID(), cardId: 'card_credit' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().mfaChallenge.count()).toBe(0);
  });

  it('cancels durably and cannot execute a cancelled proposal', async () => {
    const proposal = await add(); const owner = await identity();
    expect((await cancelCardChange(owner, proposal.change.id)).change.status).toBe('cancelled');
    expect((await cancelCardChange(owner, proposal.change.id)).change.status).toBe('cancelled');
    await expect(verifyCardChange(owner, proposal.change.id, MFA_CODE)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await listCardChanges(owner)).toEqual([]);
  });

  it('rolls card, challenge consumption, action result and receipt back on strict audit failure', async () => {
    const proposal = await add(); const database = getTestPrisma();
    const initial = await database.card.count();
    const spy = vi.spyOn(auditStore, 'insertAuditLog').mockRejectedValueOnce(new Error('Audit store unavailable'));
    try { await expect(verifyCardChange(await identity(), proposal.change.id, MFA_CODE)).rejects.toThrow('Audit store unavailable'); }
    finally { spy.mockRestore(); }
    expect(await database.card.count()).toBe(initial);
    expect(await database.executionReceipt.count()).toBe(0);
    const pending = await database.pendingAction.findUniqueOrThrow({ where: { id: proposal.change.id }, include: { mfa: true } });
    expect(pending.status).toBe('awaiting_mfa');
    expect(pending.resultJson).toBeNull();
    expect(pending.mfa?.consumedAt).toBeNull();
  });

  it.each([confirmPost, verifyPost, cancelPost, recoverPost])('rejects manual proposals through generic agent decision handlers', async handler => {
    const proposal = await add();
    const result = await postJson(handler, actionUrl(proposal.change.id, 'verify'), { code: MFA_CODE }, { ctx: idCtx(proposal.change.id) });
    expect(result.status).toBe(403);
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: proposal.change.id } })).status).toBe('awaiting_mfa');
    expect((await getTestPrisma().mfaChallenge.findUniqueOrThrow({ where: { actionId: proposal.change.id } })).status).toBe('pending');
  });

  it('does not surface manual proposals in agent actions', async () => {
    await add();
    expect((await getJson<{ data: unknown[] }>(actionsGet, '/api/actions')).data?.data).toEqual([]);
  });

  it('blocks card issuance through the agent tool map, direct runner, gateway and submitted workflow', async () => {
    const owner = await identity(); const registry = createToolRegistry(owner.userId);
    expect(registry.list().map(tool => tool.name)).not.toContain('apply_virtual_card');
    expect(() => registry.get('apply_virtual_card')).toThrow();
    await expect(registry.tools.apply_virtual_card.execute('attempt', {})).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    expect((await registry.executeDirect('apply_virtual_card', {})).errorCode).toBe('SECURITY_DENIED');
    expect((await executeGatedTool({ ...owner, toolName: 'apply_virtual_card', args: {}, userRequest: 'Create a virtual card' })).errorCode).toBe('SECURITY_DENIED');
    const plan = await runSubmitPlan(owner.userId, { goal: 'Create a virtual card', nodes: [{ id: 'issue', name: 'Issue card', kind: 'tool', tool: 'apply_virtual_card', args: {}, dependencies: [] }] },
      { sessionId: owner.sessionId, runTool: (toolName, args) => executeGatedTool({ ...owner, toolName, args, userRequest: 'Create a virtual card' }) });
    expect(plan.ok).toBe(false);
    expect(await getTestPrisma().card.count({ where: { type: 'VIRTUAL' } })).toBe(0);
    expect(await getTestPrisma().pendingAction.count({ where: { toolName: 'apply_virtual_card' } })).toBe(0);
  });

  it('validates exact decimal amounts, forbids body ownership and accepts DELETE proposals', async () => {
    expect(addDemoCardSchema.safeParse({ requestId: randomUUID(), type: 'CREDIT', creditLimit: 200 }).success).toBe(false);
    expect(addDemoCardSchema.safeParse({ requestId: randomUUID(), type: 'CREDIT', creditLimit: '0.00' }).success).toBe(false);
    expect(addDemoCardSchema.safeParse({ requestId: randomUUID(), type: 'DEBIT', creditLimit: '200.00' }).success).toBe(false);
    expect((await postJson(addPost, '/api/cards', { requestId: randomUUID(), type: 'DEBIT', userId: 'other' })).status).toBe(400);
    const request = new NextRequest('http://localhost/api/cards/card_debit', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID() }) });
    expect((await deleteCard(request, idCtx('card_debit'))).status).toBe(200);
  });
});

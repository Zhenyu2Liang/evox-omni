import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executeGatedTool, getDemoSession } from '@/agent';
import { banking } from '@/banking-sdk';
import { auditStore } from '@/audit/audit-logger';
import { recovery } from '@/security';
import { getState, recordFailure, resetSession } from '@/security/circuit-breaker';
import { MFA_CODE } from '@/lib/constants';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { recoverAction as clientRecover } from '@/components/chat/actions';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { POST as resetPost } from '@/app/api/security/reset/route';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { centsToMoney, moneyToCents, subtractMoney } from '@/lib/money';
import * as executionFence from '@/agent/execution-fence';

// Route + SDK + SQLite integration; only scheduling barriers and explicit faults are injected.
const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => disconnectTestPrisma());
type Route = typeof confirmPost;
function request(id: string, _sessionId: string, body: object = {}) {
  return new NextRequest(`http://localhost/api/actions/${id}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function call(handler: Route, id: string, sessionId: string, body: object = {}) {
  const response = await handler(request(id, sessionId, body), { params: Promise.resolve({ id }) });
  return { http: response.status, body: await response.json() };
}
const balance = async () => centsToMoney((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(new Error('repair barrier timeout')), 7000))]); }
  finally { clearTimeout(timer); }
}
async function lock(sessionId: string) {
  for (let i = 0; i < 3; i++) await recordFailure(sessionId);
  expect((await getState(sessionId)).locked).toBe(true);
}
async function park(amount = '200') {
  const sessionId = (await getDemoSession(userId)).sessionId;
  const action = await executeGatedTool({ userId, sessionId, toolName: 'transfer_money',
    args: { name: '张伟', amount }, userRequest: '确认边界回归' });
  expect(action.pendingActionId).toBeTruthy();
  return { id: action.pendingActionId!, sessionId };
}
async function rolledBackTransfer() {
  const action = await park(); const insert = auditStore.insertAuditLog;
  const fault = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey === `exec:${action.id}`) throw new Error('required audit rollback');
    return insert(entry, opts);
  });
  expect((await call(confirmPost, action.id, action.sessionId)).http).toBe(500);
  fault.mockRestore(); expect(await balance()).toBe('23580.00');
  return action;
}

it.each(['200', '2000'])('a write-time breaker denial of %s stays recoverable and requires an audited unlock', async amount => {
  const p = getTestPrisma(); const action = await park(amount);
  const reached = deferred(), release = deferred(); const capture = executionFence.buildConfirmFence;
  const barrier = vi.spyOn(executionFence, 'buildConfirmFence').mockImplementation(async (...input) => {
    const fence = await capture(...input);
    reached.resolve(); await release.promise; return fence;
  });
  const requiresMfa = moneyToCents(amount) > 100000n;
  const running = call(requiresMfa ? verifyPost : confirmPost, action.id, action.sessionId,
    requiresMfa ? { code: '123456' } : {});
  let blocked: Awaited<ReturnType<typeof call>>;
  try { await bounded(reached.promise); await lock(action.sessionId); }
  finally { release.resolve(); blocked = await running; barrier.mockRestore(); }
  expect(blocked!.http).toBe(423); expect(blocked!.body.error.code).toBe('CIRCUIT_OPEN');
  expect(await balance()).toBe('23580.00');
  expect(await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
    status: 'confirmed', resultJson: null, executionLeaseOwner: null, executionLeaseExpiresAt: null,
  });
  expect(await p.executionReceipt.count()).toBe(0);
  expect(await p.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } })).toBe(0);
  expect((await call(recoverPost, action.id, action.sessionId)).http).toBe(423);
  // Entering the shared demo is not enough to unlock: verification or cooldown is required,
  // so the code-less route path throws CIRCUIT_OPEN and writes NO reset event.
  const refused = await resetPost(request('reset', action.sessionId));
  expect(refused.status).toBe(423);
  expect((await refused.json()).error.code).toBe('CIRCUIT_OPEN');
  expect(await p.securityEvent.count({ where: { sessionId: action.sessionId, kind: 'SECURITY_RESET' } })).toBe(0);
  // The deliberate, AUDITED security-center unlock (mock strong-verification code) clears the lock.
  await resetSession(action.sessionId, { actor: 'user', reason: '确认边界回归解除熔断', verificationCode: MFA_CODE });
  expect(await p.securityEvent.count({ where: { sessionId: action.sessionId, kind: 'SECURITY_RESET' } })).toBe(1);
  expect((await call(recoverPost, action.id, action.sessionId)).body.data).toMatchObject({ ok: true, status: 'executed' });
  await call(confirmPost, action.id, action.sessionId);
  expect(await balance()).toBe(subtractMoney('23580.00', amount));
  expect(await p.transaction.count({ where: { userId, amountMinor: -moneyToCents(amount), channel: 'TRANSFER' } })).toBe(1);
  expect(await p.executionReceipt.count()).toBe(1);
  expect(await p.auditLog.count({ where: { dedupeKey: `exec:${action.id}` } })).toBe(1);
});

it('the same write fence protects a non-transfer card mutation after confirmation', async () => {
  const p = getTestPrisma(); const sessionId = (await getDemoSession(userId)).sessionId;
  const action = await executeGatedTool({ userId, sessionId, toolName: 'set_card_limit',
    args: { cardId: 'card_credit', category: '娱乐', amount: '1500' }, userRequest: '限额确认' });
  const before = await p.cardLimit.findMany({ where: { cardId: 'card_credit' } });
  const reached = deferred(), release = deferred(); const capture = executionFence.buildConfirmFence;
  vi.spyOn(executionFence, 'buildConfirmFence').mockImplementation(async (...input) => {
    const fence = await capture(...input);
    reached.resolve(); await release.promise; return fence;
  });
  const running = call(confirmPost, action.pendingActionId!, sessionId);
  let response: Awaited<ReturnType<typeof call>>;
  try { await bounded(reached.promise); await lock(sessionId); }
  finally { release.resolve(); response = await running; }
  expect(response!.http).toBe(423);
  expect(await p.cardLimit.findMany({ where: { cardId: 'card_credit' } })).toEqual(before);
  expect(await p.pendingAction.findUniqueOrThrow({ where: { id: action.pendingActionId! } })).toMatchObject({ status: 'confirmed', resultJson: null });
});

it.each(['CONFLICT', 'CIRCUIT_OPEN'] as const)('a stale recovery uses the committed RED decision in the %s receipt fallback', async denial => {
  const p = getTestPrisma(); const action = await rolledBackTransfer();
  await banking.transfer.createTransfer({ userId, name: '张伟', amount: '900', idempotencyKey: 'boundary:other-channel' });
  const reached = deferred(), release = deferred(); const authorize = recovery.authorizeRecoveryAction;
  let authorizations = 0;
  vi.spyOn(recovery, 'authorizeRecoveryAction').mockImplementation(async (...args) => {
    if (++authorizations === 1) { reached.resolve(); await release.promise; }
    return authorize(...args);
  });
  const stale = call(recoverPost, action.id, action.sessionId);
  let result: Awaited<ReturnType<typeof call>>; let auditBefore: unknown;
  try {
    await bounded(reached.promise);
    expect((await call(recoverPost, action.id, action.sessionId)).body.data).toMatchObject({ status: 'awaiting_mfa', tier: 'RED' });
    expect((await call(verifyPost, action.id, action.sessionId, { code: '123456' })).body.data).toMatchObject({ ok: true, status: 'executed', tier: 'RED' });
    auditBefore = await p.auditLog.findUniqueOrThrow({ where: { dedupeKey: `exec:${action.id}` } });
    if (denial === 'CIRCUIT_OPEN') await lock(action.sessionId);
  } finally { release.resolve(); result = await stale; }
  expect(result!.http).toBe(200);
  expect(result!.body.data).toMatchObject({ ok: true, status: 'executed', tier: 'RED', requiresMfa: true });
  expect(await balance()).toBe('22480.00');
  expect(await p.transaction.count({ where: { userId, amountMinor: -20000n, channel: 'TRANSFER' } })).toBe(1);
  expect(await p.auditLog.findUniqueOrThrow({ where: { dedupeKey: `exec:${action.id}` } })).toEqual(auditBefore);
});

it('recovery still rejects a duplicate audit with a different business result', async () => {
  const p = getTestPrisma(); const action = await park('2000');
  const fault = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('landing unavailable'));
  expect((await call(verifyPost, action.id, action.sessionId, { code: '123456' })).http).toBe(500);
  fault.mockRestore();
  const audit = await p.auditLog.findUniqueOrThrow({ where: { dedupeKey: `exec:${action.id}` } });
  const wrong = JSON.parse(audit.toolResult!); wrong.data.amount = 999;
  await p.auditLog.update({ where: { id: audit.id }, data: { toolResult: JSON.stringify(wrong) } });
  expect((await call(recoverPost, action.id, action.sessionId)).http).toBe(500);
  expect(await balance()).toBe('21580.00');
  expect(await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: 'confirmed', resultJson: null });
  expect(await p.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).toMatchObject({ toolResult: JSON.stringify(wrong) });
});

function mockResponse(status: string | undefined, extra: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: {
    ok: false, actionId: 'action', sessionId: 'session', status, tier: 'RED', requiresMfa: true,
    mfaResult: 'not_required', message: '需人工核对或已结束', events: [], ...extra,
  } })));
}
it.each(['needs_reconciliation', 'failed', 'cancelled', 'locked'])('the client keeps %s terminal even with a stale MFA event', async status => {
  mockResponse(status, { events: [{ type: 'mfa_required', actionId: 'action' }] });
  const response = await clientRecover('action');
  expect(response.events.some(event => event.type === 'mfa_required')).toBe(false);
  expect(response.events).toContainEqual({ type: 'error', message: '需人工核对或已结束' });
});
it.each(['pending', 'awaiting_mfa'])('the client still prompts for explicit %s MFA decisions', async status => {
  mockResponse(status);
  expect((await clientRecover('action')).events).toEqual([{ type: 'mfa_required', actionId: 'action' }]);
});
it('a wrong MFA code remains an error rather than a fresh verification decision', async () => {
  mockResponse('awaiting_mfa', { mfaResult: 'failed', message: '验证码错误' });
  expect((await clientRecover('action')).events).toEqual([{ type: 'error', message: '验证码错误' }]);
});
it('a terminal result preserves a verification event for a different next plan action', async () => {
  mockResponse('executed', { ok: true, events: [{ type: 'mfa_required', actionId: 'next-action' }] });
  const events = (await clientRecover('action')).events;
  // The verification event belongs to a DIFFERENT next plan action and must survive a terminal settle.
  expect(events).toContainEqual({ type: 'mfa_required', actionId: 'next-action' });
  // The merged client normalizer additionally surfaces the terminal settlement (additive, intended).
  expect(events).toContainEqual({ type: 'action_settled', actionId: 'action', status: 'executed', message: '需人工核对或已结束' });
});

it.each(['needs_reconciliation', 'failed', 'cancelled', 'locked'])('the real confirm route does not request MFA for RED %s', async status => {
  const p = getTestPrisma(); const action = await park('2000');
  await p.pendingAction.update({ where: { id: action.id }, data: { status } });
  const response = await call(confirmPost, action.id, action.sessionId);
  expect(response.http).toBe(200);
  expect(response.body.data).toMatchObject({ ok: false, status, tier: 'RED', requiresMfa: true });
  expect(response.body.data.events.some((event: { type: string }) => event.type === 'mfa_required')).toBe(false);
  expect(await balance()).toBe('23580.00');
});

it('a locked RED decision retains its historical MFA requirement without requesting another code', async () => {
  const action = await park('2000'); await lock(action.sessionId);
  const response = await call(confirmPost, action.id, action.sessionId);
  expect(response.http).toBe(200);
  expect(response.body.data).toMatchObject({ ok: false, status: 'locked', tier: 'RED', requiresMfa: true });
  expect(response.body.data.events.some((event: { type: string }) => event.type === 'mfa_required')).toBe(false);
  expect(await balance()).toBe('23580.00');
});

import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { banking } from '@/banking-sdk';
import { auditStore } from '@/audit/audit-logger';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { getState } from '@/security/circuit-breaker';
import { recovery } from '@/security';
import { recoverAction as clientRecover } from '@/components/chat/actions';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => disconnectTestPrisma());
type Route = typeof confirmPost;
function request(id: string, sessionId: string, body: object = {}) {
  return new NextRequest(`http://localhost/api/actions/${id}`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` }, body: JSON.stringify(body) });
}
async function call(handler: Route, id: string, sessionId: string, body: object = {}) {
  const response = await handler(request(id, sessionId, body), { params: Promise.resolve({ id }) });
  return { http: response.status, body: await response.json() };
}
const balance = async () => (await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balance;
async function park(amount: number, sessionId?: string) {
  sessionId ??= (await getOrCreateSession(userId)).sessionId;
  const action = await executeGatedTool({ userId, sessionId, toolName: 'transfer_money', args: { name: '张伟', amount }, userRequest: 'e819d6e复查' });
  expect(action.pendingActionId).toBeTruthy(); return { id: action.pendingActionId!, sessionId };
}
async function rolledBackTransfer() {
  const action = await park(200); const original = auditStore.insertAuditLog;
  const fault = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey === `exec:${action.id}`) throw new Error('review: critical audit rollback');
    return original(entry, opts);
  });
  expect((await call(confirmPost, action.id, action.sessionId)).http).toBe(500); fault.mockRestore();
  expect(await balance()).toBe(23580); return action;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000))]); }
  finally { clearTimeout(timer); }
}

it.each([200, 2000])('a normal %s transfer must recheck the breaker before its first SDK write', async amount => {
  const p = getTestPrisma(); const first = await park(amount); const blocker = await park(5000, first.sessionId);
  const reached = deferred(), release = deferred(); const original = banking.transfer.createTransfer;
  vi.spyOn(banking.transfer, 'createTransfer').mockImplementation(async input => {
    if (input.idempotencyKey === first.id) { reached.resolve(); await release.promise; }
    return original(input);
  });
  const running = call(amount > 1000 ? verifyPost : confirmPost, first.id, first.sessionId, amount > 1000 ? { code: '123456' } : {});
  let result: Awaited<ReturnType<typeof call>>;
  try {
    await bounded(reached.promise);
    for (let i = 0; i < 3; i++) {
      const rejected = await call(verifyPost, blocker.id, first.sessionId, { code: '000000' });
      expect(rejected.body.data.ok).toBe(false);
    }
    expect(getState(first.sessionId).locked).toBe(true); expect(await balance()).toBe(23580);
  } finally { release.resolve(); result = await running; }
  const debits = await p.transaction.count({ where: { userId, amount: -amount, channel: 'TRANSFER' } });
  console.log('REVIEW_NORMAL_CONFIRM_BREAKER', JSON.stringify({ amount, locked: getState(first.sessionId).locked, http: result!.http, ok: result!.body.data?.ok, status: result!.body.data?.status, balance: await balance(), debits }));
  expect(await balance()).toBe(23580); expect(debits).toBe(0);
});

it('a RED manual-review recovery must not be normalised into a fresh MFA prompt', async () => {
  const p = getTestPrisma(); const sessionId = (await getOrCreateSession(userId)).sessionId;
  const submitted = await runSubmitPlan(userId, { goal: 'RED人工核对', nodes: [{ id: 'transfer', name: '转账', kind: 'tool', tool: 'transfer_money', args: { name: '张伟', amount: 2000 }, dependencies: [] }] }, {
    sessionId, runTool: (toolName, args, ctx) => executeGatedTool({ userId, sessionId, toolName: toolName as 'transfer_money', args, userRequest: 'RED人工核对', taskId: ctx.taskId, nodeId: ctx.nodeId }),
  });
  const planId = (submitted.data as { id: string }).id;
  const action = await p.pendingAction.findFirstOrThrow({ where: { taskId: planId } });
  const fault = vi.spyOn(actionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('review: status unavailable'));
  expect((await call(verifyPost, action.id, sessionId, { code: '123456' })).http).toBe(500); expect(fault).toHaveBeenCalledTimes(1); fault.mockRestore();
  const receipt = await p.executionReceipt.findFirstOrThrow({ where: { key: `nxe:${planId}:transfer` } });
  await p.executionReceipt.update({ where: { id: receipt.id }, data: { resultJson: JSON.stringify({ ...JSON.parse(receipt.resultJson), amount: 999 }) } });
  let routePayload: unknown;
  vi.stubGlobal('fetch', vi.fn(async () => {
    const response = await recoverPost(request(action.id, sessionId), { params: Promise.resolve({ id: action.id }) });
    routePayload = await response.clone().json(); return response;
  }));
  const client = await clientRecover(action.id);
  const status = (await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status;
  console.log('REVIEW_RED_MANUAL_AS_MFA', JSON.stringify({ status, routePayload, clientEvents: client.events, balance: await balance() }));
  expect(status).toBe('needs_reconciliation');
  expect(client.events.some(event => event.type === 'mfa_required')).toBe(false);
  expect(client.events.some(event => event.type === 'error')).toBe(true);
});

it('a concurrent MFA upgrade must not let a stale recovery land the committed RED audit as YELLOW', async () => {
  const p = getTestPrisma(); const action = await rolledBackTransfer();
  await banking.transfer.createTransfer({ userId, name: '张伟', amount: 900, idempotencyKey: 'review:other-channel' });
  const auditConflicts: unknown[] = []; const originalAudit = auditStore.insertAuditLog;
  vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    try { return await originalAudit(entry, opts); }
    catch (error) {
      if (opts?.dedupeKey === `exec:${action.id}`) auditConflicts.push({ code: (error as { code?: string }).code, tier: entry.riskLevel, requiresMfa: entry.mfaRequired });
      throw error;
    }
  });
  const readReached = deferred(), releaseRead = deferred(), commitReached = deferred(), releaseCommit = deferred();
  const originalRead = actionRepo.getPendingAction; let heldRead = false;
  const originalAuthorization = recovery.authorizeRecoveryAction; let authorizations = 0; let watchFirstAuthorization = false;
  vi.spyOn(recovery, 'authorizeRecoveryAction').mockImplementation(async (...args) => {
    if (++authorizations === 1) {
      watchFirstAuthorization = true;
      try { return await originalAuthorization(...args); }
      finally { watchFirstAuthorization = false; }
    }
    return originalAuthorization(...args);
  });
  vi.spyOn(actionRepo, 'getPendingAction').mockImplementation(async id => {
    const row = await originalRead(id);
    if (id === action.id && !heldRead && watchFirstAuthorization) {
      heldRead = true; readReached.resolve(); await releaseRead.promise;
    }
    return row;
  });
  const originalTransfer = banking.transfer.createTransfer; let heldCommit = false;
  vi.spyOn(banking.transfer, 'createTransfer').mockImplementation(async input => {
    const result = await originalTransfer(input);
    if (input.idempotencyKey === action.id && !heldCommit) { heldCommit = true; commitReached.resolve(); await releaseCommit.promise; }
    return result;
  });
  const stale = call(recoverPost, action.id, action.sessionId);
  let verify: Promise<Awaited<ReturnType<typeof call>>> | undefined;
  let recovered: Awaited<ReturnType<typeof call>> | undefined;
  try {
    await bounded(readReached.promise);
    const escalated = await call(recoverPost, action.id, action.sessionId);
    expect(escalated.body.data).toMatchObject({ status: 'awaiting_mfa', tier: 'RED' });
    verify = call(verifyPost, action.id, action.sessionId, { code: '123456' });
    await bounded(commitReached.promise);
    expect(await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({ status: 'confirmed', riskLevel: 'RED', requiresMfa: true });
    releaseRead.resolve(); recovered = await stale;
  } finally { releaseRead.resolve(); releaseCommit.resolve(); await stale; if (verify) await verify; }
  const stored = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  const storedAudit = await p.auditLog.findUniqueOrThrow({ where: { dedupeKey: `exec:${action.id}` } });
  console.log('REVIEW_STALE_RECOVERY_RISK', JSON.stringify({ http: recovered?.http, body: recovered?.body, status: stored.status, risk: stored.riskLevel, balance: await balance(), debits: await p.transaction.count({ where: { userId, amount: -200, channel: 'TRANSFER' } }), auditConflicts, storedAudit: { tier: storedAudit.riskLevel, requiresMfa: storedAudit.mfaRequired } }));
  expect(recovered?.http).toBe(200);
  expect(recovered?.body.data).toMatchObject({ ok: true, status: 'executed', tier: 'RED', requiresMfa: true });
});

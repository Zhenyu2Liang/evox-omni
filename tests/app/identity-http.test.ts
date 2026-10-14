import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as cancelPost } from '@/app/api/actions/[id]/cancel/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { GET as taskGet, POST as taskPost } from '@/app/api/tasks/[id]/route';
import { GET as tasksGet } from '@/app/api/tasks/route';
import { POST as resetPost } from '@/app/api/security/reset/route';
import { executeGatedTool, getOrCreateSession } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import { MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, chatUrl, getJson, idCtx, postJson, taskUrl } from './harness';

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message: string } }
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

async function parkedTransfer(amount = '200') {
  const response = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
    message: `给张伟转${amount}元`,
  });
  expect(response.status).toBe(200);
  const sessionId = response.data!.data!.sessionId;
  return getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId, toolName: 'transfer_money' } });
}

async function seedPlan(sessionId: string): Promise<TaskPlan> {
  const result = await runSubmitPlan(DEMO_USER_ID, {
    goal: 'Read the balance and transfer money',
    nodes: [{ id: 'transfer', name: 'Transfer money', dependencies: [], kind: 'tool',
      tool: 'transfer_money', args: { name: '张伟', amount: '200' } }],
  }, {
    sessionId,
    runTool: (toolName, args, context) => executeGatedTool({
      sessionId, userId: DEMO_USER_ID, toolName: toolName as Parameters<typeof executeGatedTool>[0]['toolName'],
      args, userRequest: 'Read the balance and transfer money', ...context,
    }),
  });
  expect(result.ok).toBe(true);
  return result.data as TaskPlan;
}

describe('single-user demo HTTP identity', () => {
  it('creates one canonical session atomically and preserves existing state', async () => {
    const snapshots = await Promise.all(Array.from({ length: 6 }, () => getDemoSession(DEMO_USER_ID)));
    expect(new Set(snapshots.map(snapshot => snapshot.sessionId))).toEqual(new Set([`demo:${DEMO_USER_ID}`]));
    expect(await getTestPrisma().agentSession.count()).toBe(1);
    const initial = await getTestPrisma().agentSession.findUniqueOrThrow({ where: { id: snapshots[0].sessionId } });
    await getDemoSession(DEMO_USER_ID);
    const reloaded = await getTestPrisma().agentSession.findUniqueOrThrow({ where: { id: initial.id } });
    expect(reloaded.stateJson).toBe(initial.stateJson);
    expect(reloaded.revision).toBe(initial.revision);
    expect(reloaded.updatedAt).toEqual(initial.updatedAt);
  });

  it('restores pending actions and plans without a login or session cookie', async () => {
    const action = await parkedTransfer();
    const plan = await seedPlan(action.sessionId);
    const actions = await getJson<Envelope<Array<{ id: string }>>>(actionsGet, '/api/actions');
    expect(actions.status).toBe(200);
    expect(actions.data!.data!.map(item => item.id)).toContain(action.id);
    const tasks = await getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, '/api/tasks');
    expect(tasks.status).toBe(200);
    expect(tasks.data!.data!.plans.map(item => item.id)).toContain(plan.id);
    const read = await getJson<Envelope<TaskPlan>>(taskGet, taskUrl(plan.id), { ctx: idCtx(plan.id) });
    expect(read.data!.data!.id).toBe(plan.id);
    const pause = await postJson(taskPost, taskUrl(plan.id), { action: 'pause' }, { ctx: idCtx(plan.id) });
    expect(pause.status).toBe(200);
  });

  it('confirms a demo action once without a cookie and ignores browser identity hints', async () => {
    const action = await parkedTransfer();
    const balance = (await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    const foreign = await getOrCreateSession(DEMO_USER_ID);
    const path = `${actionUrl(action.id, 'confirm')}?sessionId=${foreign.sessionId}&userId=foreign`;
    expect((await postJson(confirmPost, path, {}, { ctx: idCtx(action.id), sessionId: foreign.sessionId })).status).toBe(200);
    expect((await postJson(confirmPost, path, {}, { ctx: idCtx(action.id) })).status).toBe(200);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(balance - 20_000n);
    expect(await getTestPrisma().transaction.count({ where: { counterpartyId: 'contact_zhangwei', amountMinor: -20_000n } })).toBe(1);
  });

  it('retains MFA even though entering the demo needs no login', async () => {
    const action = await parkedTransfer('5000');
    const balance = (await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    const confirm = await postJson<Envelope<{ status: string }>>(confirmPost, actionUrl(action.id, 'confirm'), {}, { ctx: idCtx(action.id) });
    expect(confirm.status).toBe(200);
    expect(confirm.data!.data!.status).toBe('awaiting_mfa');
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(balance);
    expect((await postJson(verifyPost, actionUrl(action.id, 'verify'), { code: MFA_CODE }, { ctx: idCtx(action.id) })).status).toBe(200);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(balance - 500_000n);
  });

  it('denies foreign resources even when cookie and query name their owner', async () => {
    const foreign = await getOrCreateSession(DEMO_USER_ID);
    const plan = await seedPlan(foreign.sessionId);
    const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId: foreign.sessionId } });
    for (const [handler, verb, body] of [
      [confirmPost, 'confirm', {}], [verifyPost, 'verify', { code: MFA_CODE }], [cancelPost, 'cancel', {}],
    ] as const) {
      const response = await postJson<Envelope<unknown>>(handler,
        `${actionUrl(action.id, verb)}?sessionId=${foreign.sessionId}&userId=${DEMO_USER_ID}`, body,
        { ctx: idCtx(action.id), sessionId: foreign.sessionId });
      expect(response.status).toBe(403);
      expect(response.data!.error!.code).toBe('SECURITY_DENIED');
    }
    expect((await getJson(taskGet, taskUrl(plan.id), { ctx: idCtx(plan.id), sessionId: foreign.sessionId })).status).toBe(403);
    expect((await postJson(taskPost, taskUrl(plan.id), { action: 'cancel' }, { ctx: idCtx(plan.id), sessionId: foreign.sessionId })).status).toBe(403);
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('pending');
    expect((await getJson<Envelope<unknown[]>>(actionsGet, '/api/actions')).data!.data).toEqual([]);
    expect((await getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, '/api/tasks')).data!.data!.plans).toEqual([]);
  });

  it('returns normal missing-resource errors without requiring a login', async () => {
    expect((await postJson(confirmPost, actionUrl('missing', 'confirm'), {}, { ctx: idCtx('missing') })).status).toBe(404);
    expect((await getJson(taskGet, taskUrl('missing'), { ctx: idCtx('missing') })).status).toBe(404);
    expect((await postJson(resetPost, '/api/security/reset', {})).status).toBe(200);
  });
});

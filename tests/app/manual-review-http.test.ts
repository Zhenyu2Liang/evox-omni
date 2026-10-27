/** [integration] Real routes + DB + executor. Human notes never replace banking evidence. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as inboxGet, POST as openPost } from '@/app/api/manual-reviews/route';
import { POST as resolvePost } from '@/app/api/manual-reviews/[id]/route';
import { POST as controlPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { executeGatedTool, getDemoSession, getOrCreateSession } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { auditStore } from '@/audit/audit-logger';
import { claimTaskExecution, claimTaskStatus } from '@/lib/db/repositories/task';
import { MFA_CODE } from '@/lib/constants';
import { createTranslator } from '@/lib/i18n/shared';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import * as executionFences from '@/agent/execution-fence';
import { DEVELOPER_MODE_COOKIE, DEVELOPER_MODE_ENABLED } from '@/lib/developer-mode/shared';

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const p = getTestPrisma;
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

async function call(handler: Handler, sessionId?: string, body?: object, id = 'unused', developerMode: string | null = DEVELOPER_MODE_ENABLED) {
  const cookies = [sessionId ? `banking_session=${sessionId}` : '',
    developerMode === null ? '' : `${DEVELOPER_MODE_COOKIE}=${developerMode}`].filter(Boolean).join('; ');
  const response = await handler(new NextRequest(`http://localhost/api/manual-reviews/${id}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json',
      ...(cookies ? { cookie: cookies } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), { params: Promise.resolve({ id }) });
  return { http: response.status, body: await response.json() };
}

async function failedPlan(amount = '200') {
  const { sessionId } = await getDemoSession(DEMO_USER_ID);
  await runSubmitPlan(DEMO_USER_ID, { goal: '异常查询后转账', nodes: [
    { id: 'before', name: '查询卡片', kind: 'tool', tool: 'get_cards', args: {}, dependencies: [] },
    { id: 'read', name: '查询余额', kind: 'tool', tool: 'get_balance', args: {}, dependencies: ['before'] },
    { id: 'pay', name: '转账给张伟', kind: 'tool', tool: 'transfer_money', args: { name: '张伟', amount }, dependencies: ['read'] },
  ] }, { sessionId, runTool: (toolName, args, ctx) => toolName === 'get_balance'
    ? Promise.resolve({ ok: false, error: '查询服务暂不可用' })
    : executeGatedTool({ sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: '异常任务', taskId: ctx.taskId, nodeId: ctx.nodeId }) });
  const task = await p().agentTask.findFirstOrThrow({ where: { sessionId }, include: { nodes: true } });
  expect(task.status).toBe('failed');
  return { sessionId, taskId: task.id };
}

async function open(sessionId: string, target: { taskId?: string; actionId?: string }) {
  const response = await call(openPost, sessionId, { ...target, reason: '用户请求人工核对异常' });
  expect(response.http, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { id: string; mayRetry: boolean };
}

async function money() {
  return { balance: (await p().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor,
    ledger: await p().transaction.findMany({ where: { userId: DEMO_USER_ID, channel: 'TRANSFER' }, orderBy: { id: 'asc' } }) };
}

describe('[integration] manual handoff', () => {
  it.each([null, '0', 'true'])('refuses manual routes without an explicit developer preference (%s)', async preference => {
    const { sessionId, taskId } = await failedPlan();
    const reviewsBefore = await p().manualReview.count();
    const auditsBefore = await p().auditLog.count();
    const inbox = await call(inboxGet, sessionId, undefined, 'unused', preference);
    const opened = await call(openPost, sessionId, { taskId, reason: 'Check uncertain results' }, 'unused', preference);
    const resolved = await call(resolvePost, sessionId, { resolution: 'stop', notes: 'Stop automatic execution' }, 'unused', preference);
    for (const response of [inbox, opened, resolved]) {
      expect(response.http).toBe(403);
      expect(response.body).toMatchObject({ ok: false, error: { code: 'SECURITY_DENIED' } });
      expect(response.body.data).toBeUndefined();
    }
    expect(await p().manualReview.count()).toBe(reviewsBefore);
    expect(await p().auditLog.count()).toBe(auditsBefore);
    expect((await p().agentTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('failed');
  });

  it('does not resolve an existing case after developer mode is disabled', async () => {
    const { sessionId, taskId } = await failedPlan();
    const review = await open(sessionId, { taskId });
    const auditsBefore = await p().auditLog.count();
    expect((await call(resolvePost, sessionId, { resolution: 'stop', notes: 'Stop after disabling developer mode' }, review.id, '0')).http).toBe(403);
    expect((await p().manualReview.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('open');
    expect(await p().auditLog.count()).toBe(auditsBefore);
  });

  it('persists an owned case and prevents direct/DB resume and retry while it is open', async () => {
    const { sessionId, taskId } = await failedPlan();
    const review = await open(sessionId, { taskId });
    expect(review.mayRetry).toBe(true);
    expect((await call(inboxGet, sessionId)).body.data.reviews[0].operatorName).toContain('李明');
    for (const action of ['resume', 'retry']) {
      expect((await call(controlPost, sessionId, { action }, taskId)).http).toBe(409);
    }
    expect(await claimTaskStatus(taskId, ['failed'], 'running')).toBe(false);
    expect(await claimTaskExecution(taskId, 'unauthorized-executor')).toBe(false);
    expect(await p().pendingAction.count({ where: { taskId } })).toBe(0);
    expect((await p().agentTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('failed');
  });

  it.each(['200', '2000'])('manual continue for %s still parks for original confirmation/MFA and preserves prior successes', async (amount) => {
    const { sessionId, taskId } = await failedPlan(amount);
    const before = await money();
    const previous = await p().agentTaskNode.findFirstOrThrow({ where: { taskId, nodeId: 'before' } });
    const review = await open(sessionId, { taskId });
    const resolved = await call(resolvePost, sessionId, { resolution: 'retry', notes: '已核对查询失败，可以重新查询并请用户确认' }, review.id);
    expect(resolved.http, JSON.stringify(resolved.body)).toBe(200);
    expect(await money()).toEqual(before);
    const resumed = await call(controlPost, sessionId, { action: 'retry' }, taskId);
    expect(resumed.http).toBe(200);
    expect(resumed.body.data.status).toBe('waiting_confirmation');
    const approval = await p().pendingAction.findFirstOrThrow({ where: { taskId } });
    expect(approval.requiresMfa).toBe(amount === '2000');
    expect(await money()).toEqual(before);
    const after = await p().agentTaskNode.findFirstOrThrow({ where: { taskId, nodeId: 'before' } });
    expect(after.startedAt).toEqual(previous.startedAt);
    expect(after.output).toEqual(previous.output);
    if (amount === '2000') {
      const confirmed = await call(confirmPost, sessionId, {}, approval.id);
      expect(confirmed.body.data.requiresMfa).toBe(true);
      expect(await money()).toEqual(before);
      expect((await call(verifyPost, sessionId, { code: MFA_CODE }, approval.id)).body.data.ok).toBe(true);
    } else expect((await call(confirmPost, sessionId, {}, approval.id)).body.data.ok).toBe(true);
    expect((await money()).balance).toBe(before.balance - BigInt(amount) * 100n);
    expect((await p().agentTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('success');
    expect(await p().auditLog.count({ where: { dedupeKey: { startsWith: `manual:${review.id}:` } } })).toBe(2);
  });

  it('stopping a failed plan preserves a previously posted debit and its executed action', async () => {
    const { sessionId, taskId } = await failedPlan();
    const outcome = await executeGatedTool({ sessionId, userId: DEMO_USER_ID, toolName: 'transfer_money',
      args: { name: '张伟', amount: '100' }, userRequest: '已完成的转账' });
    expect((await call(confirmPost, sessionId, {}, outcome.pendingActionId!)).body.data.ok).toBe(true);
    await p().pendingAction.update({ where: { id: outcome.pendingActionId! }, data: { taskId, nodeId: 'before' } });
    const before = await money();
    const review = await open(sessionId, { taskId });
    const resolved = await call(resolvePost, sessionId, { resolution: 'stop', notes: '已核对入账流水，保留交易并停止后续步骤' }, review.id);
    expect(resolved.http).toBe(200);
    expect(await money()).toEqual(before);
    expect((await p().pendingAction.findUniqueOrThrow({ where: { id: outcome.pendingActionId! } })).status).toBe('executed');
    expect((await p().agentTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('cancelled');
    await call(controlPost, sessionId, { action: 'retry' }, taskId);
    expect(await money()).toEqual(before);
  });

  it('unknown standalone results can be annotated/stopped but never declared successful or retried', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const outcome = await executeGatedTool({ sessionId, userId: DEMO_USER_ID, toolName: 'freeze_card', args: { cardId: 'card_credit' }, userRequest: '冻结信用卡' });
    await p().pendingAction.update({ where: { id: outcome.pendingActionId! }, data: { status: 'needs_reconciliation', resultJson: null } });
    const review = await open(sessionId, { actionId: outcome.pendingActionId! });
    expect(review.mayRetry).toBe(false);
    expect((await call(resolvePost, sessionId, { resolution: 'retry', notes: '尝试重新执行这笔操作' }, review.id)).http).toBe(409);
    const before = await money();
    expect((await call(resolvePost, sessionId, { resolution: 'stop', notes: '执行证据不足，结束自动流程并保留待核对标记' }, review.id)).http).toBe(200);
    const action = await p().pendingAction.findUniqueOrThrow({ where: { id: outcome.pendingActionId! } });
    expect(action.status).toBe('needs_reconciliation'); expect(action.resultJson).toBeNull();
    expect((await p().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status).toBe('ACTIVE');
    expect(await money()).toEqual(before);
  });

  it('rejects retry when a plan contains unknown execution evidence', async () => {
    const { sessionId, taskId } = await failedPlan();
    await p().pendingAction.create({ data: { sessionId, userId: DEMO_USER_ID, taskId, nodeId: 'read',
      toolName: 'set_card_limit', argsJson: '{}', summaryJson: '{}', riskLevel: 'YELLOW', status: 'needs_reconciliation' } });
    const review = await open(sessionId, { taskId });
    expect(review.mayRetry).toBe(false);
    expect((await call(resolvePost, sessionId, { resolution: 'retry', notes: '结果未知时尝试重试' }, review.id)).http).toBe(409);
    expect((await p().manualReview.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('open');
  });

  it('a real insufficient-funds transfer is reachable in the manual inbox and can be stopped without changing funds', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const before = await money();
    const parked = await executeGatedTool({ sessionId, userId: DEMO_USER_ID, toolName: 'transfer_money',
      args: { name: '张伟', amount: '30000' }, userRequest: '给张伟转30000元' });
    const failed = await call(verifyPost, sessionId, { code: MFA_CODE }, parked.pendingActionId!);
    expect(failed.body.data.ok).toBe(false);
    expect(failed.body.data.status).toBe('failed');
    expect((await call(inboxGet, sessionId)).body.data.candidates.map((v: { actionId?: string }) => v.actionId)).toContain(parked.pendingActionId);
    const review = await open(sessionId, { actionId: parked.pendingActionId! });
    expect(review.mayRetry).toBe(false);
    expect((await call(resolvePost, sessionId, { resolution: 'stop', notes: '核对为余额不足，结束流程后由用户重新提出需求' }, review.id)).http).toBe(200);
    expect(await money()).toEqual(before);
    expect((await p().pendingAction.findUniqueOrThrow({ where: { id: parked.pendingActionId! } })).status).toBe('failed');
  });

  it('uses shared demo ownership without login, ignores cookie identities and requires valid operator notes', async () => {
    const { sessionId, taskId } = await failedPlan();
    const other = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
    const target = { taskId, reason: '请求人工核对异常' };
    expect((await call(openPost, undefined, target)).http).toBe(200);
    expect((await call(openPost, other, target)).http).toBe(200);
    expect((await call(openPost, sessionId, { ...target, operatorName: '管理员' })).http).toBe(400);
    const review = await open(sessionId, { taskId });
    expect((await call(inboxGet, other)).body.data.reviews.map((entry: { id: string }) => entry.id)).toContain(review.id);
    await p().agentTask.update({ where: { id: taskId }, data: { sessionId: other } });
    await p().manualReview.update({ where: { id: review.id }, data: { sessionId: other } });
    expect((await call(resolvePost, other, { resolution: 'stop', notes: 'Reject non-demo workflow ownership' }, review.id)).http).toBe(403);
    await p().agentTask.update({ where: { id: taskId }, data: { sessionId } });
    await p().manualReview.update({ where: { id: review.id }, data: { sessionId } });
    expect((await call(resolvePost, sessionId, { resolution: 'stop', notes: ' ' }, review.id)).http).toBe(400);
    expect((await p().manualReview.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('open');
  });

  it('concurrent handoffs/decisions produce one active case and one resolution audit', async () => {
    const { sessionId, taskId } = await failedPlan();
    const opened = await Promise.all([open(sessionId, { taskId }), open(sessionId, { taskId })]);
    expect(opened[0].id).toBe(opened[1].id);
    const results = await Promise.all(['第一次核对后停止执行', '第二次核对后停止执行'].map(notes =>
      call(resolvePost, sessionId, { resolution: 'stop', notes }, opened[0].id)));
    expect(results.map(r => r.http).sort()).toEqual([200, 409]);
    expect(await p().manualReview.count({ where: { taskId } })).toBe(1);
    expect(await p().auditLog.count({ where: { dedupeKey: { startsWith: `manual:${opened[0].id}:` } } })).toBe(2);
  });

  it('audit failures roll back handoff and resolution with the task state', async () => {
    const { sessionId, taskId } = await failedPlan();
    const spy = vi.spyOn(auditStore, 'insertAuditLog').mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await call(openPost, sessionId, { taskId, reason: '请求人工核对失败任务' })).http).toBe(500);
    expect(await p().manualReview.count()).toBe(0);
    spy.mockRestore();
    const review = await open(sessionId, { taskId });
    vi.spyOn(auditStore, 'insertAuditLog').mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await call(resolvePost, sessionId, { resolution: 'stop', notes: '核对完成后结束自动处理' }, review.id)).http).toBe(500);
    expect((await p().manualReview.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('open');
    expect((await p().agentTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('failed');
  });

  it('refuses handoff of terminal plans', async () => {
    const { sessionId, taskId } = await failedPlan();
    for (const status of ['success', 'cancelled']) {
      await p().agentTask.update({ where: { id: taskId }, data: { status } });
      expect((await call(openPost, sessionId, { taskId, reason: '尝试接管当前任务' })).http).toBe(409);
    }
    expect(await p().manualReview.count()).toBe(0);
  });

  it('requests control of a running workflow without rotating its live claim', async () => {
    const { sessionId, taskId } = await failedPlan();
    await p().agentTaskNode.updateMany({ where: { taskId }, data: { status: 'pending', error: null } });
    await p().agentTaskNode.updateMany({ where: { taskId, nodeId: 'read' }, data: { status: 'running' } });
    await p().agentTask.update({ where: { id: taskId }, data: {
      status: 'running', executionToken: 'live-executor', executionClaimedAt: new Date(),
    } });
    const before = await money();
    const review = await open(sessionId, { taskId });
    const stored = await p().agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(stored.status).toBe('paused');
    expect(stored.executionToken).toBe('live-executor');
    const state = (await call(inboxGet, sessionId)).body.data.reviews[0];
    expect(state.handoffStatus).toBe('human_review_requested');
    expect(state.mayStop).toBe(false);
    expect(state.mayResume).toBe(false);
    expect((await call(resolvePost, sessionId, { resolution: 'resume', notes: 'Release workflow after inspection' }, review.id)).http).toBe(409);
    expect(await money()).toEqual(before);
  });

  it('releases a parked workflow with its original approval identity intact', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const result = await runSubmitPlan(DEMO_USER_ID, { goal: 'Review before transfer', nodes: [
      { id: 'pay', name: 'Transfer', kind: 'tool', tool: 'transfer_money',
        args: { name: '\u5f20\u4f1f', amount: '200.00' }, dependencies: [] },
    ] }, { sessionId, runTool: (toolName, args, ctx) => executeGatedTool({
      sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: 'Review before transfer', ...ctx,
    }) });
    expect(result.ok).toBe(true);
    const task = await p().agentTask.findFirstOrThrow({ where: { sessionId } });
    const approval = await p().pendingAction.findFirstOrThrow({ where: { taskId: task.id } });
    const before = await money();
    const review = await open(sessionId, { taskId: task.id });
    expect((await call(inboxGet, sessionId)).body.data.reviews[0].mayResume).toBe(true);
    const blocked = await call(confirmPost, sessionId, {}, approval.id);
    expect(blocked.http).toBe(200);
    expect(blocked.body.data.ok).toBe(false);
    expect(blocked.body.data.status).toBe('pending');
    expect(blocked.body.data.message).toContain('manual review');
    // A manual-review hold is its OWN structured refusal, not the generic "state changed" one.
    const chinese = createTranslator('zh-CN');
    expect(blocked.body.data.code).toBe('MANUAL_REVIEW_HOLD');
    expect(blocked.body.data.code).not.toBe('CONFLICT');
    expect(blocked.body.data.failure).toMatchObject({
      code: 'MANUAL_REVIEW_HOLD', reason: 'manual_review_hold', actionId: approval.id,
    });
    expect(blocked.body.data.failure.reason).not.toBe('denied');
    expect(blocked.body.data.message).toBe(chinese('chat.error.manualReviewHold'));
    expect(blocked.body.data.message).not.toBe(chinese('chat.error.stateChanged'));
    for (const absent of ['刷新', '__SECURITY_BLOCK__', 'decisionKind', 'Error:', ' at ']) {
      expect(blocked.body.data.message).not.toContain(absent);
    }
    // Nothing internal leaks through the whole envelope, and the typed facts alone are enough for a
    // client to render the refusal without matching any copy.
    const wire = JSON.stringify(blocked.body);
    for (const leak of ['__SECURITY_BLOCK__', 'decisionKind', 'at Object.', 'node_modules']) {
      expect(wire).not.toContain(leak);
    }
    expect({
      status: blocked.body.data.status, code: blocked.body.data.code, reason: blocked.body.data.failure.reason,
    }).toEqual({ status: 'pending', code: 'MANUAL_REVIEW_HOLD', reason: 'manual_review_hold' });
    expect(await money()).toEqual(before);
    const resolved = await call(resolvePost, sessionId, { resolution: 'resume', notes: 'Continue with original user authorization' }, review.id);
    expect(resolved.http).toBe(200);
    expect(resolved.body.data.workflowStatus).toBe('waiting_confirmation');
    expect(await p().pendingAction.count({ where: { taskId: task.id } })).toBe(1);
    expect((await p().pendingAction.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('pending');
    expect(await money()).toEqual(before);
    expect((await call(confirmPost, sessionId, {}, approval.id)).body.data.ok).toBe(true);
    expect((await money()).balance).toBe(before.balance - 20_000n);
  });

  it('lets an already-started automatic command finish and pauses before the next step', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    let entered!: () => void;
    const atFence = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const buildFence = executionFences.buildAutomaticWriteFence;
    vi.spyOn(executionFences, 'buildAutomaticWriteFence').mockImplementationOnce(async (...args) => {
      const fence = await buildFence(...args);
      entered();
      await barrier;
      return fence;
    });
    const running = runSubmitPlan(DEMO_USER_ID, { goal: 'Operator checkpoint after budget', nodes: [
      { id: 'budget', name: 'Create budget', kind: 'tool', tool: 'reserve_budget', dependencies: [],
        args: { name: 'operator-checkpoint', amount: '12.34' } },
      { id: 'balance', name: 'Read balance', kind: 'tool', tool: 'get_balance', args: {}, dependencies: ['budget'] },
    ] }, { sessionId, runTool: (toolName, args, ctx) => executeGatedTool({
      sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: 'Operator checkpoint after budget', ...ctx,
    }) });
    await atFence;
    const task = await p().agentTask.findFirstOrThrow({ where: { sessionId } });
    const review = await open(sessionId, { taskId: task.id });
    expect((await p().agentTask.findUniqueOrThrow({ where: { id: task.id } })).executionToken).toBe(task.executionToken);
    release();
    const result = await running;
    expect(result.ok).toBe(true);
    const stopped = await p().agentTask.findUniqueOrThrow({ where: { id: task.id }, include: { nodes: true } });
    expect(stopped.status).toBe('paused');
    expect(stopped.nodes.find(node => node.nodeId === 'budget')?.status).toBe('success');
    expect(stopped.nodes.find(node => node.nodeId === 'balance')?.status).toBe('pending');
    expect(await p().budget.count({ where: { name: 'operator-checkpoint', amountMinor: 1234n } })).toBe(1);
    expect((await call(inboxGet, sessionId)).body.data.reviews[0].handoffStatus).toBe('operator_controlled');
    expect((await call(resolvePost, sessionId, { resolution: 'resume', notes: 'Continue after the safe checkpoint' }, review.id)).http).toBe(200);
    expect((await call(controlPost, sessionId, { action: 'resume' }, task.id)).body.data.status).toBe('success');
    expect(await p().budget.count({ where: { name: 'operator-checkpoint' } })).toBe(1);
  });

  it('retains an already-confirmed debit while an operator request blocks future authorization', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    await runSubmitPlan(DEMO_USER_ID, { goal: 'Retain confirmed debit', nodes: [
      { id: 'pay', name: 'Transfer', kind: 'tool', tool: 'transfer_money', dependencies: [],
        args: { name: '\u5f20\u4f1f', amount: '200.00' } },
    ] }, { sessionId, runTool: (toolName, args, ctx) => executeGatedTool({
      sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: 'Retain confirmed debit', ...ctx,
    }) });
    const task = await p().agentTask.findFirstOrThrow({ where: { sessionId } });
    const approval = await p().pendingAction.findFirstOrThrow({ where: { taskId: task.id } });
    let entered!: () => void;
    const atFence = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const buildFence = executionFences.buildConfirmFence;
    vi.spyOn(executionFences, 'buildConfirmFence').mockImplementationOnce(async (...args) => {
      const fence = await buildFence(...args);
      entered();
      await barrier;
      return fence;
    });
    const before = await money();
    const confirming = call(confirmPost, sessionId, {}, approval.id);
    await atFence;
    const review = await open(sessionId, { taskId: task.id });
    expect((await call(inboxGet, sessionId)).body.data.reviews[0].handoffStatus).toBe('human_review_requested');
    release();
    expect((await confirming).body.data.ok).toBe(true);
    expect((await money()).balance).toBe(before.balance - 20_000n);
    expect((await p().pendingAction.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('executed');
    expect((await p().agentTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('paused');
    expect((await call(resolvePost, sessionId, { resolution: 'stop', notes: 'Keep the committed debit and stop automatic work' }, review.id)).http).toBe(200);
    expect((await money()).balance).toBe(before.balance - 20_000n);
  });
});

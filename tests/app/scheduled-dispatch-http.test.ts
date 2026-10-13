import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { banking } from '@/banking-sdk';
import { withBankingExecution } from '@/banking-sdk/execution-context';
import { cancelTask, confirmAction, getOrCreateSession, tickScheduledTasks, verifyAction } from '@/agent';
import { getScheduleInbox, synchronizeScheduledWorkflow } from '@/agent/scheduled-dispatcher';
import { GET as inboxGet } from '@/app/api/schedules/route';
import { POST as tickPost } from '@/app/api/schedules/tick/route';
import { auditStore } from '@/audit/audit-logger';
import { MFA_CODE, SESSION_COOKIE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

const NOW = Date.parse('2099-01-02T09:00:00+08:00');
const db = getTestPrisma;
beforeEach(async () => {
  await resetDatabase();
  // This suite owns its due intents; unrelated demo schedules would also be due after clock fast-forward.
  await db().scheduledTask.deleteMany();
});
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectTestPrisma);

async function schedule(kind: 'REMINDER' | 'TRANSFER' | 'PAYMENT', payload: Record<string, unknown>) {
  const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
  const task = await withBankingExecution({ sessionId }, () => banking.task.createScheduledTask({
    userId: DEMO_USER_ID, name: 'Due scheduled operation', kind, runAt: NOW - 1,
    payload, requiresConfirmation: false,
  }));
  return { task, identity: { sessionId, userId: DEMO_USER_ID } };
}

describe('durable scheduled dispatch', () => {
  it('delivers a reminder once with its audit, including concurrent scheduler ticks', async () => {
    const { task, identity } = await schedule('REMINDER', { note: 'Prepare the birthday gift' });
    const balance = (await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    await Promise.all([tickScheduledTasks(identity, { now: NOW }), tickScheduledTasks(identity, { now: NOW })]);
    expect((await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('DONE');
    expect(await db().scheduledNotification.count({ where: { scheduledTaskId: task.id } })).toBe(1);
    expect(await db().auditLog.count({ where: { dedupeKey: `schedule:${task.id}:delivery` } })).toBe(1);
    const inbox = await getScheduleInbox(identity);
    expect(inbox.notifications.find(notification => notification.scheduledTaskId === task.id)?.message).toBe('Prepare the birthday gift');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(balance);
  });

  it('reassesses due payments and keeps MFA mandatory even when the stored flag is false', async () => {
    const { task, identity } = await schedule('TRANSFER', { contactId: 'contact_zhangwei', amount: '2000.01' });
    const before = (await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    const first = await tickScheduledTasks(identity, { now: NOW });
    const dispatch = first.dispatches.find(item => item.scheduledTaskId === task.id)!;
    expect(dispatch.status).toBe('AWAITING_CONFIRMATION');
    const approval = await db().pendingAction.findUniqueOrThrow({ where: { id: dispatch.pendingActionId } });
    expect(approval.requiresMfa).toBe(true);
    expect(approval.status).toBe('awaiting_mfa');
    expect(JSON.parse(approval.argsJson).amount).toBe('2000.01');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(before);
    await tickScheduledTasks(identity, { now: NOW });
    expect(await db().pendingAction.count({ where: { taskId: dispatch.workflowId } })).toBe(1);
    expect((await verifyAction(approval.id, MFA_CODE, identity)).ok).toBe(true);
    await synchronizeScheduledWorkflow(dispatch.workflowId!);
    expect((await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('DONE');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(before - 200_001n);
    await tickScheduledTasks(identity, { now: NOW });
    expect(await db().transaction.count({ where: { counterpartyId: 'contact_zhangwei', amountMinor: -200_001n } })).toBe(1);
  });

  it('does not dispatch another session scheduled intent or accept a client-supplied clock', async () => {
    const { task } = await schedule('TRANSFER', { contactId: 'contact_zhangwei', amount: '200.00' });
    const other = (await getOrCreateSession(DEMO_USER_ID)).sessionId;
    const result = await tickScheduledTasks({ userId: DEMO_USER_ID, sessionId: other }, { now: NOW });
    expect(result.dispatches.map(dispatch => dispatch.scheduledTaskId)).not.toContain(task.id);
    expect((await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('SCHEDULED');
    const rejected = await tickPost(new NextRequest('http://localhost/api/schedules/tick', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${other}` }, body: JSON.stringify({ now: NOW }) }));
    expect(rejected.status).toBe(400);
    expect(await db().pendingAction.count()).toBe(0);
    expect((await inboxGet(new NextRequest('http://localhost/api/schedules'))).status).toBe(403);
  });

  it('rolls back reminder delivery on audit failure and safely retries the same intent', async () => {
    const { task, identity } = await schedule('REMINDER', { note: 'Audited reminder' });
    const fault = vi.spyOn(auditStore, 'insertAuditLog').mockRejectedValueOnce(new Error('Audit unavailable'));
    await tickScheduledTasks(identity, { now: NOW });
    expect(fault).toHaveBeenCalledOnce();
    expect(fault.mock.calls[0][0].toolName).toBe('scheduled_reminder_delivery');
    expect(fault.mock.calls[0][1]).toMatchObject({ strict: true, dedupeKey: `schedule:${task.id}:delivery` });
    expect((await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('SCHEDULED');
    expect(await db().scheduledNotification.count({ where: { scheduledTaskId: task.id } })).toBe(0);
    fault.mockRestore();
    await tickScheduledTasks(identity, { now: NOW });
    expect(await db().scheduledNotification.count({ where: { scheduledTaskId: task.id } })).toBe(1);
    expect((await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('DONE');
  });

  it('rejects unsupported executable payloads before creating a banking workflow', async () => {
    const { task, identity } = await schedule('TRANSFER', { contactId: 'contact_zhangwei', amount: '200.00', toolName: 'change_password' });
    const result = await tickScheduledTasks(identity, { now: NOW });
    expect(result.dispatches.find(dispatch => dispatch.scheduledTaskId === task.id)?.status).toBe('FAILED');
    expect(await db().agentTask.count({ where: { sessionId: identity.sessionId } })).toBe(0);
    expect(await db().pendingAction.count()).toBe(0);
  });

  it('does not let parked approvals starve newly due reminders', async () => {
    const { task, identity } = await schedule('REMINDER', { note: 'Deliver after parked payments' });
    await db().scheduledTask.createMany({ data: Array.from({ length: 25 }, (_, index) => ({
      id: `parked-payment-${index}`, ...identity, name: 'Waiting payment', kind: 'TRANSFER',
      runAt: new Date(NOW - 100), status: 'AWAITING_CONFIRMATION',
    })) });
    await tickScheduledTasks(identity, { now: NOW, limit: 25 });
    expect((await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('DONE');
    expect(await db().scheduledNotification.count({ where: { scheduledTaskId: task.id } })).toBe(1);
    expect(await db().pendingAction.count()).toBe(0);
  });

  it('requires fenced workflow cancellation after dispatch instead of marking a live payment cancelled', async () => {
    const { task, identity } = await schedule('TRANSFER', { contactId: 'contact_zhangwei', amount: '200.00' });
    const before = (await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    const dispatched = (await tickScheduledTasks(identity, { now: NOW })).dispatches[0];
    await expect(banking.task.cancelScheduledTask(task.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('AWAITING_CONFIRMATION');
    expect((await db().pendingAction.findUniqueOrThrow({ where: { id: dispatched.pendingActionId } })).status).toBe('pending');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(before);
    expect(await db().transaction.count({ where: { counterpartyId: 'contact_zhangwei', amountMinor: -20_000n } })).toBe(0);
    await cancelTask(identity.sessionId, dispatched.workflowId!);
    expect((await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('CANCELLED');
    await expect(confirmAction(dispatched.pendingActionId!, identity)).resolves.toMatchObject({ ok: false, status: 'cancelled' });
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(before);
    expect(await db().transaction.count({ where: { counterpartyId: 'contact_zhangwei', amountMinor: -20_000n } })).toBe(0);
  });

  it('cancels an undispatched intent idempotently without producing authorization or reminders', async () => {
    const { task, identity } = await schedule('REMINDER', { note: 'Cancelled reminder' });
    expect((await banking.task.cancelScheduledTask(task.id)).status).toBe('CANCELLED');
    expect((await banking.task.cancelScheduledTask(task.id)).status).toBe('CANCELLED');
    await tickScheduledTasks(identity, { now: NOW });
    expect(await db().scheduledNotification.count()).toBe(0);
    expect(await db().pendingAction.count()).toBe(0);
    expect(await db().agentTask.count()).toBe(0);
  });

  it('does not expose the winner workflow when two sessions claim one unassigned demo intent', async () => {
    const { task, identity } = await schedule('TRANSFER', { contactId: 'contact_zhangwei', amount: '200.00' });
    await db().scheduledTask.update({ where: { id: task.id }, data: { sessionId: null } });
    const other = { userId: DEMO_USER_ID, sessionId: (await getOrCreateSession(DEMO_USER_ID)).sessionId };
    const findMany = db().scheduledTask.findMany.bind(db().scheduledTask);
    let readers = 0;
    let release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    const readTogether = async (args: Parameters<typeof findMany>[0]) => {
      const rows = await findMany(args);
      readers += 1;
      if (readers === 2) release();
      await bothRead;
      return rows;
    };
    // This awaited query seam preserves rows while adding a barrier; it is not used in a batch transaction.
    vi.spyOn(db().scheduledTask, 'findMany').mockImplementation(readTogether as unknown as typeof findMany);
    const results = await Promise.all([tickScheduledTasks(identity, { now: NOW }), tickScheduledTasks(other, { now: NOW })]);
    const current = await db().scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.dispatchTaskId).toBeTruthy();
    const losing = results[current.sessionId === identity.sessionId ? 1 : 0];
    expect(losing.dispatches).toHaveLength(1);
    expect(losing.dispatches[0].error).toContain('does not belong to this session');
    expect(losing.dispatches[0].workflowId).toBeUndefined();
    expect(losing.dispatches[0].pendingActionId).toBeUndefined();
    expect(await db().agentTask.count()).toBe(1);
    expect(await db().pendingAction.count()).toBe(1);
    expect(await db().transaction.count({ where: { counterpartyId: 'contact_zhangwei', amountMinor: -20_000n } })).toBe(0);
  });
});

import type { Prisma, ScheduledTask } from '@/lib/db/prisma';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { safeParse, toJson } from '@/lib/json';
import { newId } from '@/lib/ids';
import type { ReminderNotification, ScheduleInbox, ScheduledDispatchSummary, ScheduleTickResult } from '@/lib/contracts/schedule';
import type { ToolName } from '@/lib/contracts/tools';
import type { ScheduledTaskStatus, ScheduledTaskView } from '@/banking-sdk/types';
import { recordAudit } from '@/audit/audit-logger';
import { executeGatedTool } from './confirmation';
import { resumeTask } from './task-control';
import { scheduledTransferArgs } from '@/lib/contracts/scheduled-command';
import { CLAIMABLE_ACTION_STATUSES } from './action-status';
import { isInternalDiagnostic } from '@/lib/public-text';
import { demoNow } from '@/lib/clock';

export interface ScheduleIdentity { userId: string; sessionId: string; }
export interface ScheduleTickOptions { now?: number; limit?: number; }
export type { ScheduleInbox } from '@/lib/contracts/schedule';

// Human decisions do not consume dispatch capacity or block later due intents.
const ACTIVE_DISPATCH_STATUSES = ['SCHEDULED', 'DISPATCHING'];

/** `dispatchError` is displayed on the schedules page, so an internal diagnostic (a raw
 * payload, a JSON fragment, a stack trace) must never become visible text; a hand-authored
 * failure reason is kept verbatim. */
const DISPATCH_FAILURE_NOTICE = 'The scheduled task could not be dispatched; inspect its workflow before retrying.';
function publicDispatchError(message: string | null | undefined): string | undefined {
  if (!message) return undefined;
  return isInternalDiagnostic(message) ? DISPATCH_FAILURE_NOTICE : message;
}

async function assertIdentity(identity: ScheduleIdentity): Promise<void> {
  const session = await prisma.agentSession.findUnique({ where: { id: identity.sessionId } });
  if (!session || session.userId !== identity.userId) {
    throw new AppError('SECURITY_DENIED', 'The scheduler session does not belong to this user.');
  }
}

function ownedScope(identity: ScheduleIdentity) {
  return { userId: identity.userId, OR: [{ sessionId: identity.sessionId }, { sessionId: null }] };
}

function notificationView(row: { id: string; scheduledTaskId: string; message: string; createdAt: Date }): ReminderNotification {
  return { id: row.id, scheduledTaskId: row.scheduledTaskId, message: row.message, createdAt: row.createdAt.getTime() };
}

/** The delivery itself and its required audit commit together. */
async function deliverReminder(client: Prisma.TransactionClient, row: ScheduledTask, identity: ScheduleIdentity,
  now: number): Promise<ScheduledTask> {
  const payload = safeParse<Record<string, unknown>>(row.payload, {});
  const notification = await client.scheduledNotification.create({ data: {
    scheduledTaskId: row.id, userId: row.userId, sessionId: identity.sessionId,
    message: typeof payload.note === 'string' && payload.note.trim() ? payload.note : row.name,
    createdAt: new Date(now),
  } });
  await recordAudit({ timestamp: now, ...identity, userRequest: row.name,
    intent: 'scheduled_reminder', toolName: 'scheduled_reminder_delivery', riskLevel: 'GREEN',
    confirmationRequired: false, confirmed: false, mfaRequired: false, status: 'success',
    detail: 'The previously scheduled reminder was delivered to the notification inbox.',
    toolResult: { scheduledTaskId: row.id, notificationId: notification.id, deliveredAt: now },
  }, { client, strict: true, dedupeKey: `schedule:${row.id}:delivery` });
  return client.scheduledTask.update({ where: { id: row.id }, data: {
    status: 'DONE', sessionId: identity.sessionId, deliveredAt: new Date(now), dispatchError: null,
  } });
}

/** Atomically claim the due intent and save its entire executable workflow definition. */
async function claimDueTask(id: string, identity: ScheduleIdentity, now: number): Promise<ScheduledTask> {
  return prisma.$transaction(async client => {
    const session = await client.agentSession.updateMany({ where: { id: identity.sessionId, userId: identity.userId }, data: { id: identity.sessionId } });
    if (session.count !== 1) throw new AppError('SECURITY_DENIED', 'The scheduler session no longer exists.');
    const row = await client.scheduledTask.findFirst({ where: { id, ...ownedScope(identity) } });
    if (!row) throw new AppError('SECURITY_DENIED', 'The scheduled intent does not belong to this session.');
    if (row.status !== 'SCHEDULED' || row.runAt.getTime() > now) return row;
    if (row.kind === 'REMINDER') return deliverReminder(client, row, identity, now);
    const args = scheduledTransferArgs(row.kind, safeParse<Record<string, unknown>>(row.payload, {}));
    const workflow = await client.agentTask.create({ data: {
      id: newId('scheduled-workflow'), userId: identity.userId, sessionId: identity.sessionId,
      goal: `Scheduled payment: ${row.name}`, status: 'pending',
      nodes: { create: [{ nodeId: 'payment', name: 'Execute scheduled payment', kind: 'tool', order: 0,
        tool: 'transfer_money', args: toJson(args), dependencies: toJson([]), status: 'pending' }] },
    } });
    return client.scheduledTask.update({ where: { id: row.id }, data: {
      sessionId: identity.sessionId, status: 'DISPATCHING', dispatchTaskId: workflow.id, dispatchError: null,
    } });
  }, { maxWait: 10000, timeout: 20000 });
}

/** A scheduled status follows committed workflow facts; authorization flags never bypass the gateway. */
export async function synchronizeScheduledWorkflow(workflowId: string): Promise<void> {
  const schedule = await prisma.scheduledTask.findUnique({ where: { dispatchTaskId: workflowId } });
  if (!schedule || schedule.status === 'CANCELLED') return;
  const workflow = await prisma.agentTask.findUnique({ where: { id: workflowId }, include: { nodes: true } });
  if (!workflow || workflow.userId !== schedule.userId || workflow.sessionId !== schedule.sessionId) {
    throw new AppError('SECURITY_DENIED', 'The scheduled workflow identity is inconsistent.');
  }
  const status = workflow.status === 'success' ? 'DONE'
    : workflow.status === 'failed' ? 'FAILED'
      : workflow.status === 'cancelled' ? 'CANCELLED'
        : workflow.status === 'waiting_confirmation' ? 'AWAITING_CONFIRMATION' : 'DISPATCHING';
  const error = workflow.nodes.find(node => node.status === 'failed')?.error ?? null;
  await prisma.scheduledTask.updateMany({ where: { id: schedule.id,
    status: status === 'DONE' ? { not: 'CANCELLED' } : { notIn: ['DONE', 'CANCELLED'] } }, data: {
    status, dispatchError: error,
    ...(status === 'DONE' ? { deliveredAt: workflow.updatedAt } : {}),
  } });
}

async function dispatchWorkflow(row: ScheduledTask, identity: ScheduleIdentity): Promise<ScheduledDispatchSummary> {
  if (row.dispatchTaskId && ACTIVE_DISPATCH_STATUSES.includes(row.status)) {
    const workflow = await prisma.agentTask.findUniqueOrThrow({ where: { id: row.dispatchTaskId } });
    if (workflow.userId !== identity.userId || workflow.sessionId !== identity.sessionId) {
      throw new AppError('SECURITY_DENIED', 'The scheduled workflow belongs to a different session.');
    }
    // Parked or operator-paused work is advanced only by its existing human decision/control route.
    if (['pending', 'running'].includes(workflow.status)) {
      await resumeTask(identity.sessionId, workflow.id, { runTool: (toolName, args, context) => executeGatedTool({
        ...identity, toolName: toolName as ToolName, args, userRequest: `Scheduled payment: ${row.name}`, ...context,
      }) });
    }
    await synchronizeScheduledWorkflow(workflow.id);
  }
  const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: row.id } });
  const action = current.dispatchTaskId ? await prisma.pendingAction.findFirst({
    where: { taskId: current.dispatchTaskId, status: { in: [...CLAIMABLE_ACTION_STATUSES] } }, orderBy: { createdAt: 'desc' },
  }) : null;
  const notification = await prisma.scheduledNotification.findUnique({ where: { scheduledTaskId: row.id } });
  return { scheduledTaskId: row.id, status: current.status as ScheduledTaskStatus, workflowId: current.dispatchTaskId ?? undefined,
    pendingActionId: action?.id, notificationId: notification?.id, error: publicDispatchError(current.dispatchError) };
}

/** Creation and dispatch use the same business clock; an explicit server-side simulation can advance it. */
export async function tickScheduledTasks(identity: ScheduleIdentity, options: ScheduleTickOptions = {}): Promise<ScheduleTickResult> {
  await assertIdentity(identity);
  const now = demoNow(options.now);
  if (!Number.isFinite(now)) throw new AppError('VALIDATION', 'The scheduler clock is invalid.');
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const due = await prisma.scheduledTask.findMany({ where: {
    ...ownedScope(identity), runAt: { lte: new Date(now) }, status: { in: ACTIVE_DISPATCH_STATUSES },
  }, orderBy: { runAt: 'asc' }, take: limit });
  const dispatches: ScheduledDispatchSummary[] = [];
  for (const row of due) {
    try {
      const claimed = await claimDueTask(row.id, identity, now);
      dispatches.push(await dispatchWorkflow(claimed, identity));
    } catch (error) {
      const issue = AppError.from(error);
      // A failed preflight has not created a workflow or moved money. An in-flight workflow retains its facts.
      const permanentFailure = ['VALIDATION', 'SECURITY_DENIED', 'NOT_FOUND'].includes(issue.code);
      await prisma.scheduledTask.updateMany({ where: { id: row.id, ...ownedScope(identity), status: 'SCHEDULED' },
        data: { ...(permanentFailure ? { status: 'FAILED' } : {}), dispatchError: publicDispatchError(issue.message) } });
      const current = await prisma.scheduledTask.findFirst({ where: { id: row.id, ...ownedScope(identity) } });
      // A competing session may have bound the intent. Never expose its workflow or state.
      dispatches.push({ scheduledTaskId: row.id, status: (current?.status ?? row.status) as ScheduledTaskStatus,
        workflowId: current?.dispatchTaskId ?? undefined, error: publicDispatchError(issue.message) });
    }
  }
  return { evaluatedAt: now, dispatches };
}

export async function getScheduleInbox(identity: ScheduleIdentity): Promise<ScheduleInbox> {
  await assertIdentity(identity);
  const [rows, notifications] = await Promise.all([
    prisma.scheduledTask.findMany({ where: ownedScope(identity), orderBy: { runAt: 'asc' } }),
    prisma.scheduledNotification.findMany({ where: identity, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  return { tasks: rows.map(row => ({ id: row.id, name: row.name, kind: row.kind as ScheduledTaskView['kind'],
    payload: safeParse<Record<string, unknown> | undefined>(row.payload, undefined), runAt: row.runAt.getTime(),
    status: row.status as ScheduledTaskView['status'], requiresConfirmation: row.requiresConfirmation,
    createdAt: row.createdAt.getTime(), dispatchTaskId: row.dispatchTaskId ?? undefined,
    deliveredAt: row.deliveredAt?.getTime(), dispatchError: publicDispatchError(row.dispatchError) })),
  notifications: notifications.map(notificationView) };
}

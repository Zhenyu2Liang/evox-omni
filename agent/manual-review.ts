/** Minimal Demo handoff: durable operator decisions, never human-invented banking results. */
import type { AgentTaskNode, ManualReview, PendingAction, Prisma } from '@/lib/db/prisma';
import { recordAudit } from '@/audit/audit-logger';
import { prisma } from '@/lib/db/client';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import type { ManualResolution, ManualReviewInbox, ManualReviewRecord } from '@/lib/contracts/manual-review';
import type { ToolName } from '@/lib/contracts/tools';
import { getToolPolicy } from '@/security/permission-engine';
import { committedExecutionResult } from './execution-evidence';
import { reviewControlState, type ReviewControlState } from './manual-review-policy';
import { CLAIMABLE_ACTION_STATUSES, OPEN_ACTION_STATUSES, isClaimableActionStatus } from './action-status';

type Identity = { sessionId: string; userId: string };
type Target = { taskId?: string; actionId?: string };
type Task = { status: string; executionToken: string | null; nodes: AgentTaskNode[] };

function standaloneReviewable(action: PendingAction): boolean {
  return action.taskId === null && (action.status === 'needs_reconciliation' ||
    (action.status === 'failed' && safeParse<{ ok?: boolean }>(action.resultJson, {}).ok === false));
}

function own(row: Identity, identity: Identity): void {
  if (row.sessionId !== identity.sessionId || row.userId !== identity.userId) {
    throw new AppError('SECURITY_DENIED', '无权处理该任务或操作。');
  }
}

async function operator(identity: Identity): Promise<string> {
  const session = await prisma.agentSession.findUnique({ where: { id: identity.sessionId } });
  if (!session || session.userId !== identity.userId) throw new AppError('SECURITY_DENIED', '会话身份无效。');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: identity.userId } });
  return user.name;
}

/** A failed write may be retried only with an explicit failed result and no committed evidence.
 * Unknown results, live/parked approvals and automatic writes without such proof fail closed. */
async function mayRetry(task: Task | null, actions: PendingAction[]): Promise<boolean> {
  if (!task || task.status !== 'failed' || task.executionToken !== null) return false;
  if (actions.some((a) => isClaimableActionStatus(a.status) || a.status === 'needs_reconciliation')) return false;
  const failed = task.nodes.filter((node) => node.status === 'failed');
  if (failed.length === 0 || task.nodes.some((node) => node.status === 'running')) return false;
  for (const node of failed) {
    if (node.kind !== 'tool') continue;
    const policy = getToolPolicy(node.tool as ToolName);
    if (policy.tier === 'GREEN' && node.tool !== 'reserve_budget' && node.tool !== 'submit_plan') continue;
    const attempts = actions.filter((a) => a.nodeId === node.nodeId);
    if (attempts.length === 0) return false;
    for (const action of attempts) {
      const result = safeParse<{ ok?: boolean }>(action.resultJson, {});
      if (action.status !== 'failed' || result.ok !== false) return false;
      try {
        if (await committedExecutionResult(action)) return false;
      } catch (error) {
        if (error instanceof AppError && error.code === 'CONFLICT') return false;
        throw error;
      }
    }
  }
  return true;
}

function record(row: ManualReview, retry: boolean, controls?: ReviewControlState): ManualReviewRecord {
  return {
    id: row.id, taskId: row.taskId ?? undefined, actionId: row.actionId ?? undefined,
    title: row.title, reason: row.reason, status: row.status as 'open' | 'closed',
    operatorName: row.operatorName, notes: row.notes ?? undefined,
    resolution: (row.resolution as ManualResolution | null) ?? undefined,
    createdAt: row.createdAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString(), mayRetry: retry,
    ...controls,
  };
}

async function audit(tx: Prisma.TransactionClient, row: ManualReview, phase: 'open' | 'close'): Promise<void> {
  const task = row.taskId ? await tx.agentTask.findUnique({ where: { id: row.taskId }, include: { nodes: true } }) : null;
  const actions = row.taskId ? await tx.pendingAction.findMany({ where: { taskId: row.taskId } }) : [];
  const controls = reviewControlState(row.status as 'open' | 'closed', task, actions);
  await recordAudit({
    timestamp: demoNow(), sessionId: row.sessionId, userId: row.userId, userRequest: row.reason,
    intent: 'manual_review', toolName: 'manual_review', riskLevel: 'YELLOW',
    confirmationRequired: false, confirmed: false, mfaRequired: false,
    status: phase === 'open' ? 'blocked' : row.resolution === 'retry' || row.resolution === 'resume' ? 'allowed' : 'cancelled',
    detail: `${row.operatorName}: ${phase === 'open' ? 'control_requested'
      : row.resolution === 'retry' ? 'failed_work_retry_permitted'
      : row.resolution === 'resume' ? 'operator_control_released' : 'automatic_work_stopped'}; ${row.notes ?? row.reason}`,
    toolResult: { reviewId: row.id, taskId: row.taskId, actionId: row.actionId,
      operatorId: row.operatorId, operatorName: row.operatorName, resolution: row.resolution, notes: row.notes,
      handoffStatus: controls.handoffStatus, workflowStatus: controls.workflowStatus },
  }, { client: tx, strict: true, dedupeKey: `manual:${row.id}:${phase}` });
}

export async function getManualReviewInbox(identity: Identity): Promise<ManualReviewInbox> {
  const operatorName = await operator(identity);
  const [reviews, tasks, actions] = await Promise.all([
    prisma.manualReview.findMany({ where: identity, orderBy: { createdAt: 'desc' } }),
    prisma.agentTask.findMany({ where: identity, include: { nodes: true } }),
    prisma.pendingAction.findMany({ where: identity }),
  ]);
  const active = new Set(reviews.filter((r) => r.status === 'open').map((r) => r.activeKey));
  const candidates: ManualReviewInbox['candidates'] = [];
  for (const task of tasks) {
    if (!['failed', 'running', 'paused', 'waiting_confirmation', 'pending'].includes(task.status)
      || active.has(`task:${task.id}`)) continue;
    const taskActions = actions.filter(action => action.taskId === task.id);
    if (task.status === 'failed' && (task.executionToken !== null
      || taskActions.some(action => isClaimableActionStatus(action.status)))) continue;
    candidates.push({ taskId: task.id, title: task.goal,
      error: task.status === 'failed' ? task.nodes.filter(node => node.status === 'failed').map(node => node.error ?? `${node.name} failed`).join('; ')
        : 'Request operator control at the next safe workflow checkpoint.',
      mayRetry: await mayRetry(task, taskActions),
      mayResume: reviewControlState('open', task, taskActions).mayResume, workflowStatus: task.status });
  }
  for (const action of actions) {
    if (!standaloneReviewable(action) || active.has(`action:${action.id}`)) continue;
    if (reviews.some((r) => r.actionId === action.id && r.status === 'closed' && r.resolution === 'stop')) continue;
    candidates.push({ actionId: action.id, title: action.userRequest ?? action.toolName,
      error: action.status === 'failed' ? '操作已失败，可登记核对说明；修改需求后请重新发起请求。'
        : '执行结果不明，禁止重跑；可登记核对说明并结束自动处理。', mayRetry: false });
  }
  return { operatorName, candidates, reviews: await Promise.all(reviews.map(async row => {
    const task = tasks.find(candidate => candidate.id === row.taskId) ?? null;
    const taskActions = row.taskId ? actions.filter(action => action.taskId === row.taskId)
      : actions.filter(action => action.id === row.actionId);
    return record(row, row.taskId !== null && await mayRetry(task, taskActions),
      reviewControlState(row.status as 'open' | 'closed', task, taskActions));
  })) };
}

export async function openManualReview(identity: Identity, target: Target, reason: string): Promise<ManualReviewRecord> {
  const operatorName = await operator(identity);
  const row = await prisma.$transaction(async (tx) => {
    // First statement takes the SQLite writer slot. Session and target ownership are still checked.
    await tx.agentSession.updateMany({ where: { id: identity.sessionId, userId: identity.userId }, data: { id: identity.sessionId } });
    let title: string;
    const key = target.taskId ? `task:${target.taskId}` : `action:${target.actionId}`;
    const existing = await tx.manualReview.findUnique({ where: { activeKey: key } });
    if (existing) { own(existing, identity); return existing; }
    if (target.taskId) {
      const task = await tx.agentTask.findUnique({ where: { id: target.taskId } });
      if (!task) throw new AppError('NOT_FOUND', '任务不存在。');
      own(task, identity);
      if (!['failed', 'running', 'paused', 'waiting_confirmation', 'pending'].includes(task.status)) {
        throw new AppError('CONFLICT', 'A terminal workflow cannot be handed to an operator.');
      }
      if (task.status === 'failed') {
        const activeActions = await tx.pendingAction.count({ where: { taskId: task.id, status: { in: [...CLAIMABLE_ACTION_STATUSES] } } });
        if (task.executionToken !== null || activeActions) {
          throw new AppError('CONFLICT', 'The failed workflow still has unresolved execution or authorization.');
        }
      } else {
        // Pause the walk without revoking the already-started command's claim or result authority.
        await tx.agentTask.update({ where: { id: task.id }, data: { status: 'paused' } });
      }
      title = task.goal;
    } else {
      const action = await tx.pendingAction.findUnique({ where: { id: target.actionId! } });
      if (!action) throw new AppError('NOT_FOUND', '操作不存在。');
      own(action, identity);
      if (!standaloneReviewable(action)) throw new AppError('CONFLICT', '请先核对恢复结果；计划内操作请从失败任务转人工。');
      title = action.userRequest ?? action.toolName;
    }
    const created = await tx.manualReview.create({ data: { ...identity, ...target, activeKey: key,
      title, reason, operatorId: identity.userId, operatorName, createdAt: new Date(demoNow()) } });
    await audit(tx, created, 'open');
    return created;
  });
  // The inbox computes retry eligibility using the same rules as final resolution.
  return (await getManualReviewInbox(identity)).reviews.find((r) => r.id === row.id)!;
}

export async function resolveManualReview(identity: Identity, id: string, resolution: ManualResolution, notes: string): Promise<ManualReviewRecord> {
  const operatorName = await operator(identity);
  // Validate retry evidence before the transaction; task/action state is rechecked under its writer lock.
  const prior = await prisma.manualReview.findUnique({ where: { id } });
  if (!prior) throw new AppError('NOT_FOUND', '人工处理记录不存在。');
  own(prior, identity);
  const task = prior.taskId ? await prisma.agentTask.findUnique({ where: { id: prior.taskId }, include: { nodes: { orderBy: { id: 'asc' } } } }) : null;
  const attempts = prior.taskId ? await prisma.pendingAction.findMany({ where: { taskId: prior.taskId }, orderBy: { id: 'asc' } }) : [];
  if (resolution === 'retry' && !(await mayRetry(task, attempts))) {
    throw new AppError('CONFLICT', '执行结果不明或任务不可重试，请记录核对说明并结束自动处理。');
  }
  if (resolution === 'resume' && !reviewControlState('open', task, attempts).mayResume) {
    throw new AppError('CONFLICT', 'The workflow has not reached a resumable operator checkpoint.');
  }
  const row = await prisma.$transaction(async (tx) => {
    const won = await tx.manualReview.updateMany({ where: { id, ...identity, status: 'open' },
      data: { status: 'closed', activeKey: null, resolution, notes, operatorId: identity.userId, operatorName, resolvedAt: new Date(demoNow()) } });
    if (won.count !== 1) throw new AppError('CONFLICT', '该记录已处理，请刷新查看结论。');
    if (prior.taskId) {
      const current = await tx.agentTask.findUniqueOrThrow({ where: { id: prior.taskId }, include: { nodes: { orderBy: { id: 'asc' } } } });
      const currentActions = await tx.pendingAction.findMany({ where: { taskId: prior.taskId }, orderBy: { id: 'asc' } });
      if (resolution === 'retry') {
        // The open review prevented all executor claims; reject any out-of-band state change.
        if (current.status !== 'failed' || current.executionToken !== null ||
            JSON.stringify(current.nodes) !== JSON.stringify(task?.nodes) || JSON.stringify(currentActions) !== JSON.stringify(attempts)) {
          throw new AppError('CONFLICT', '任务状态已变化，请刷新后重新核对。');
        }
      } else if (resolution === 'resume') {
        if (!reviewControlState('open', current, currentActions).mayResume) {
          throw new AppError('CONFLICT', 'The workflow changed before control could be released.');
        }
        const awaitsAuthorization = current.nodes.some(node => ['waiting_confirmation', 'waiting_verification'].includes(node.status));
        await tx.agentTask.update({ where: { id: prior.taskId }, data: { status: awaitsAuthorization ? 'waiting_confirmation' : 'paused' } });
      } else {
        if (!reviewControlState('open', current, currentActions).mayStop
          || !['failed', 'cancelled', 'paused', 'waiting_confirmation', 'pending'].includes(current.status)) {
          throw new AppError('CONFLICT', 'Wait until the current command reaches a safe checkpoint.');
        }
        await tx.pendingAction.updateMany({ where: { taskId: prior.taskId, status: { in: [...OPEN_ACTION_STATUSES] } }, data: { status: 'cancelled' } });
        await tx.agentTask.update({ where: { id: prior.taskId }, data: { status: 'cancelled', generation: { increment: 1 } } });
        await tx.agentTaskNode.updateMany({ where: { taskId: prior.taskId, status: { in: ['pending', 'running', 'waiting_confirmation', 'waiting_verification'] } }, data: { status: 'cancelled', endedAt: new Date(demoNow()) } });
        await tx.scheduledTask.updateMany({ where: { dispatchTaskId: prior.taskId, ...identity,
          status: { notIn: ['DONE', 'CANCELLED'] } }, data: { status: 'CANCELLED' } });
      }
    }
    const resolved = await tx.manualReview.findUniqueOrThrow({ where: { id } });
    await audit(tx, resolved, 'close');
    return resolved;
  });
  const resolvedTask = row.taskId ? await prisma.agentTask.findUnique({ where: { id: row.taskId }, include: { nodes: true } }) : null;
  const resolvedActions = row.taskId ? await prisma.pendingAction.findMany({ where: { taskId: row.taskId } }) : [];
  return record(row, resolution === 'retry', reviewControlState('closed', resolvedTask, resolvedActions));
}

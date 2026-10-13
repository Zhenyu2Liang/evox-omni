import type { PendingActionStatus } from '@/lib/contracts/security';
import type { GatewayContext } from '@/security/security-gateway';
import { security } from '@/security';
import { getPendingAction, listPendingActionsByTask } from '@/lib/db/repositories/pendingAction';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { nodeExecutionKey } from '@/lib/ledger';
import { createToolRegistry } from '../tools';
import { buildAutomaticWriteFence } from '../execution-fence';
import { settlePendingAction } from '../confirmation-recovery';
import { buildRecoveryAudit, convergenceAuditKey, decideConvergence } from '../execution-convergence';
import type { GatedToolOutcome } from './contracts';
import { runWorkflowInvocation } from '../durable/workflow-invocations';

const gateway = security.gateway.securityGateway;
const inFlightExecutions = new Map<string, Promise<GatedToolOutcome>>();
const representedStatuses: readonly PendingActionStatus[] = [
  'pending', 'awaiting_mfa', 'confirmed', 'executed', 'needs_reconciliation',
];
type PendingActionRow = Awaited<ReturnType<typeof listPendingActionsByTask>>[number];

async function findRepresentedAction(taskId: string, nodeId: string): Promise<PendingActionRow | undefined> {
  const rows = await listPendingActionsByTask(taskId, { statuses: [...representedStatuses] });
  return rows.find(row => row.nodeId === nodeId);
}

/** Recover saved evidence without reapplying a completed side effect. */
function recoverExecutedPlanAction(action: PendingActionRow): GatedToolOutcome {
  const stored = safeParse<Partial<GatedToolOutcome> | null>(action.resultJson, null);
  if (stored !== null && typeof stored.ok === 'boolean') {
    return { ok: stored.ok, data: stored.data, summary: stored.summary, error: stored.error };
  }
  return { ok: false, error: '该节点此前已执行但未留存结果，需人工核对（不会重新执行）。' };
}

async function executeGatedToolOnce(ctx: GatewayContext): Promise<GatedToolOutcome> {
  try {
    if (ctx.taskId !== undefined && ctx.nodeId !== undefined) {
      const existing = await findRepresentedAction(ctx.taskId, ctx.nodeId);
      if (existing !== undefined) {
        if (existing.status === 'executed' || existing.status === 'needs_reconciliation') {
          return recoverExecutedPlanAction(existing);
        }
        const decision = await decideConvergence(existing);
        if (decision.write && existing.status === 'confirmed') {
          const won = await settlePendingAction({
            actionId: existing.id, status: decision.status, result: decision.result,
            from: ['confirmed'], audit: buildRecoveryAudit(existing, decision),
            dedupeKey: convergenceAuditKey(existing.id, decision.status),
          });
          if (won) return recoverExecutedPlanAction((await getPendingAction(existing.id)) ?? existing);
        }
        return {
          ok: false, requiresConfirmation: true, pendingActionId: existing.id,
          error: '该计划节点已在等待人工确认，未重复受理。',
        };
      }
    }
    const auth = await gateway.handleToolCall(ctx);
    if (auth.evaluation.blocked) {
      return {
        ok: false, requiresConfirmation: auth.action !== undefined,
        pendingActionId: auth.action?.id, error: auth.blockReason ?? auth.decision.message,
      };
    }
    const registry = createToolRegistry(ctx.userId);
    const policyFence = await buildAutomaticWriteFence(ctx.sessionId, ctx.taskId, ctx.nodeId);
    const result = await registry.executeDirect(ctx.toolName, ctx.args, {
      ...(ctx.taskId !== undefined && ctx.nodeId !== undefined
        ? { idempotencyKey: nodeExecutionKey(ctx.taskId, ctx.nodeId) } : {}),
      fence: async client => { await ctx.runtimeFence?.(client); await policyFence(client); },
      sessionId: ctx.sessionId,
      userRequest: ctx.userRequest,
      ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
      ...(ctx.nodeId !== undefined ? { nodeId: ctx.nodeId } : {}),
    });
    return { ok: result.ok, data: result.data, summary: result.summary, error: result.error, errorCode: result.errorCode };
  } catch (error) {
    const failure = AppError.from(error);
    return { ok: false, error: failure.message, errorCode: failure.code };
  }
}

/** Coalesce concurrent execution of one node; durable evidence remains authoritative. */
export async function executeGatedTool(ctx: GatewayContext): Promise<GatedToolOutcome> {
  const key = ctx.taskId !== undefined && ctx.nodeId !== undefined
    ? nodeExecutionKey(ctx.taskId, ctx.nodeId) : undefined;
  if (key === undefined) return executeGatedToolOnce(ctx);
  const inFlight = inFlightExecutions.get(key);
  if (inFlight !== undefined) {
    const shared = await inFlight;
    if (shared.requiresConfirmation !== true && shared.pendingActionId === undefined) return shared;
    return runWorkflowInvocation(ctx, executeGatedToolOnce);
  }
  const run = runWorkflowInvocation(ctx, executeGatedToolOnce);
  inFlightExecutions.set(key, run);
  try { return await run; }
  finally { if (inFlightExecutions.get(key) === run) inFlightExecutions.delete(key); }
}

import type { PendingActionStatus } from '@/lib/contracts/security';
import type { GatewayContext, ToolCallAuthorization } from '@/security/security-gateway';
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
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { isManualCardCommand } from '@/lib/contracts/card-management';
import { safePublicText, securityNotice } from '@/lib/public-text';
import { createTranslator, DEFAULT_LOCALE } from '@/lib/i18n/shared';
import { ALL_ACTION_STATUSES } from '../action-status';

const gateway = security.gateway.securityGateway;
const t = createTranslator(DEFAULT_LOCALE);
const inFlightExecutions = new Map<string, Promise<GatedToolOutcome>>();
/** Every status a persisted plan-node action may hold — the SHARED vocabulary, never a local literal. */
const representedStatuses: readonly PendingActionStatus[] = ALL_ACTION_STATUSES;
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

/**
 * A gateway refusal as a TYPED outcome. uth.blockReason is the gateway's INTERNAL envelope
 * (`__SECURITY_BLOCK__…`) or a model-facing diagnostic: it stays in the Pi tool result
 * (anking-agent.ts#beforeToolCall) and is NEVER rendered as user-visible text. Only the structured
 * failure facts — or, when the gateway sent no structured failure, a closed-catalog sentence from
 * lib/public-text.ts — are published, so a raw payload, a JSON fragment or a status literal can
 * never reach a node error or a summary.
 */
function blockedOutcome(auth: ToolCallAuthorization): GatedToolOutcome {
  const failure = security.gateway.securityGateway.parseBlockReason(auth.blockReason ?? '')?.failure;
  return {
    ok: false,
    requiresConfirmation: auth.action !== undefined,
    pendingActionId: auth.action?.id,
    errorCode: failure?.code,
    error: failure !== undefined
      ? securityNotice(failure, t)
      : safePublicText(auth.blockReason, t, 'chat.error.operationNotStarted'),
  };
}

async function executeGatedToolOnce(ctx: GatewayContext): Promise<GatedToolOutcome> {
  try {
    if (isManualCardCommand(ctx.toolName) || catalogEntry(ctx.toolName)?.agentEnabled === false) throw new AppError('SECURITY_DENIED', 'Card creation and deletion require the card management page.');
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
    if (auth.evaluation.blocked) return blockedOutcome(auth);
    const registry = createToolRegistry(ctx.userId);
    const policyFence = await buildAutomaticWriteFence(ctx.sessionId, ctx.taskId, ctx.nodeId, ctx.userId);
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

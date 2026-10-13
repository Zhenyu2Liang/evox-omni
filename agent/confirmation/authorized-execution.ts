import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { AuthorizationResult } from '@/security/security-gateway';
import { security } from '@/security';
import { getSession } from '@/lib/db/repositories/session';
import { getPendingAction, getPendingActionPlanLink } from '@/lib/db/repositories/pendingAction';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { ledgerKeyForAction } from '@/lib/ledger';
import { createToolRegistry, type ToolExecutionResult } from '../tools';
import { buildConfirmFence, guardExecutionFence } from '../execution-fence';
import { settlePendingAction } from '../confirmation-recovery';
import { convergenceAuditKey, decideConvergence } from '../execution-convergence';
import { transferExecutionAudit } from '../execution-audit';
import { resumeTurn } from '../run-turn';
import type { ConfirmOptions, ConfirmationOutcome, TrustedIdentity } from './contracts';
import { effectiveTier, emitAll } from './outcomes';
import { resumeOwningPlan } from './plan-continuation';

const gateway = security.gateway.securityGateway;

/** Execute original authorized arguments, then land evidence before continuing the model. */
export async function executeAuthorizedAction(
  actionId: string, view: AuthorizationResult, identity: TrustedIdentity, opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  const action = view.action;
  if (action === undefined) throw new AppError('INTERNAL', `安全网关已授权但未返回待处理操作: ${actionId}`);
  const tier = effectiveTier(view);
  const requiresMfa = view.requiresMfa;
  const session = await getSession(identity.sessionId);
  if (session?.userId === undefined || session.userId === '') {
    await gateway.recordActionResult(actionId, 'failed');
    throw new AppError('SECURITY_DENIED', `无法解析待处理操作的所有者会话: ${identity.sessionId}`);
  }
  const registry = createToolRegistry(identity.userId);
  const link = await getPendingActionPlanLink(actionId);
  const idempotencyKey = ledgerKeyForAction({ id: actionId, taskId: link?.taskId, nodeId: link?.nodeId });
  let result: ToolExecutionResult;
  let sideEffectCommitted = false;
  const guarded = guardExecutionFence(await buildConfirmFence(link?.taskId, link?.nodeId, actionId));
  const executionAudit = transferExecutionAudit(actionId, {
    sessionId: action.sessionId, userRequest: action.userRequest ?? '', intent: action.intent,
    toolName: action.toolName, riskLevel: tier, confirmationRequired: true, confirmed: true,
    mfaRequired: requiresMfa, mfaResult: view.mfaResult,
  });
  try {
    result = await registry.executeDirect(action.toolName, action.args, {
      idempotencyKey, fence: guarded.fence, onTransferCommit: executionAudit.onTransferCommit,
      onCommandCommit: executionAudit.onCommandCommit,
      onTransactionCommitted: () => { sideEffectCommitted = true; },
    });
  } catch (error) { result = { ok: false, error: AppError.from(error).message }; }
  guarded.assertPolicyAllowed();
  executionAudit.assertSucceeded();
  const current = await getPendingAction(actionId);
  if (current === null) throw new AppError('NOT_FOUND', '执行操作不存在');
  const decision = await decideConvergence(current, { completion: result, sideEffectCommitted });
  result = decision.result ?? result;
  await settlePendingAction({
    actionId, status: decision.status, result,
    audit: {
      timestamp: demoNow(), sessionId: action.sessionId, userRequest: action.userRequest ?? '',
      intent: action.intent, toolName: action.toolName, riskLevel: tier,
      confirmationRequired: true, confirmed: true, mfaRequired: requiresMfa,
      mfaResult: view.mfaResult, toolResult: result,
      status: decision.status === 'needs_reconciliation' ? 'blocked' : result.ok ? 'success' : 'failed',
    },
    dedupeKey: convergenceAuditKey(actionId, decision.status),
  });
  try {
    if (decision.status === 'executed' || decision.status === 'failed') {
      await gateway.recordActionResult(actionId, decision.status);
    }
  } catch {
    // Atomic settlement remains authoritative if the gateway notification fails.
  }
  const planEvents = await resumeOwningPlan(action, result, identity.userId, opts);
  const { events } = await resumeTurn({
    sessionId: action.sessionId, toolResult: result,
    toolName: link?.taskId ? 'submit_plan' : action.toolName,
    resultToolName: action.toolName,
    ...(typeof action.args.sourceAccountId === 'string' ? { sourceAccountId: action.args.sourceAccountId } : {}),
    actionId,
    ...(typeof link?.taskId === 'string' ? { taskId: link.taskId } : {}),
    ...(typeof link?.nodeId === 'string' ? { nodeId: link.nodeId } : {}),
  }, opts?.deps);
  emitAll(events, opts);
  const narrationError = events.find(
    (event): event is Extract<AgentStreamEvent, { type: 'error' }> => event.type === 'error',
  );
  const businessMessage = decision.status === 'needs_reconciliation'
    ? '操作结果尚无法核实，已进入人工核对，请勿重复执行。'
    : result.ok ? '操作已执行。' : (result.error ?? '操作执行失败。');
  return {
    ok: result.ok, actionId, status: decision.status, tier, requiresMfa,
    message: narrationError === undefined ? businessMessage
      : `${businessMessage}（结果播报失败：${narrationError.message}）`,
    result, events: [...planEvents, ...events],
  };
}

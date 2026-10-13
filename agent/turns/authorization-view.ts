import type { PendingActionSummary } from '@/lib/contracts/security';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { ToolName } from '@/lib/contracts/tools';
import type { TaskPlan } from '@/lib/contracts/task';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { safeParse } from '@/lib/json';
import { withActionPolicy } from '@/lib/action-summary';
import { readPendingActionId } from '../workflows/contracts';
import { confirmationCard, mfaCard } from '../card-emitter';
import type { TurnBuffer, PlanRelay } from './contracts';
import { emitCard } from './buffer';
import { safeToString } from './message-utils';

export const MFA_HINT = 'Enter the six-digit SMS verification code.';

export async function loadPendingSummary(actionId: string, toolName: string): Promise<PendingActionSummary> {
  const fallback: PendingActionSummary = { title: 'Pending operation', toolName: toolName as ToolName, tier: 'YELLOW', fields: [], requiresMfa: false };
  const row = await getPendingAction(actionId);
  if (!row) return fallback;
  return withActionPolicy(safeParse<PendingActionSummary>(row.summaryJson, { ...fallback, toolName: row.toolName as ToolName,
    tier: row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa }), { actionId, tier: row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa });
}

/** Relay the graph without deriving its permissions from node labels or model content. */
export function relayPlanSnapshot(buffer: TurnBuffer, relay: PlanRelay, plan: TaskPlan): void {
  try {
    buffer.events.push({ type: 'plan_update', plan });
    const parked = plan.results.map(node => ({ node, actionId: readPendingActionId(node.output) }))
      .find(item => ['waiting_confirmation', 'waiting_verification'].includes(item.node.status) && item.actionId !== undefined);
    relay.parkedActionId = parked?.actionId;
    if (parked) relay.parkedToolName = parked.node.tool ?? '';
  } catch (error) { buffer.events.push({ type: 'error', message: safeToString(error) }); }
}

export async function flushParkedDecision(buffer: TurnBuffer, relay: PlanRelay): Promise<void> {
  try {
    const actionId = relay.parkedActionId;
    if (!actionId) return;
    relay.parkedActionId = undefined;
    const summary = await loadPendingSummary(actionId, relay.parkedToolName ?? 'submit_plan');
    if (summary.tier === 'RED' || summary.requiresMfa) {
      buffer.events.push({ type: 'mfa_required', actionId, hint: MFA_HINT, action: summary });
      emitCard(buffer, mfaCard(actionId, MFA_HINT, summary));
    } else {
      buffer.events.push({ type: 'confirmation_required', actionId, action: summary });
      emitCard(buffer, confirmationCard(summary));
    }
  } catch (error) { buffer.events.push({ type: 'error', message: safeToString(error) }); }
}

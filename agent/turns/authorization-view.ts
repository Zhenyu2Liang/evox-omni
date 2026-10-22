import type { AgentStreamEvent, ChatMessage } from '@/lib/contracts/agent';
import type { PendingActionSummary, PendingActionStatus } from '@/lib/contracts/security';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { ToolName } from '@/lib/contracts/tools';
import type { TaskPlan } from '@/lib/contracts/task';
import { getPendingAction, type PendingActionWithMfa } from '@/lib/db/repositories/pendingAction';
import { safeParse } from '@/lib/json';
import { withActionPolicy } from '@/lib/action-summary';
import { mayPromptForDecision } from '../action-status';
import { readPendingActionId } from '../workflows/contracts';
import { confirmationCard, mfaCard } from '../card-emitter';
import type { TurnBuffer, PlanRelay } from './contracts';
import { activePlanMessage, emitCard, publishToolMessage } from './buffer';
import { safeToString } from './message-utils';

export const MFA_HINT = 'Enter the six-digit SMS verification code.';

/**
 * The PERSISTED state of a parked operation: the `PendingAction` row's OWN status and summary.
 * Only this persisted row decides whether a decision may still be presented — never the plan node
 * label, the block payload or model prose.
 */
export interface ParkedDecision {
  status: PendingActionStatus;
  summary: PendingActionSummary;
  /** The persisted `MfaChallenge` is `locked`, i.e. the row's lock is an exhausted-verification lock. */
  mfaLocked: boolean;
}

function fallbackSummary(toolName: string): PendingActionSummary {
  return { title: 'Pending operation', toolName: toolName as ToolName, tier: 'YELLOW', fields: [], requiresMfa: false };
}

/** Display metadata is re-derived from the CURRENT row policy (tier / strong-verification need). */
function summaryOf(row: PendingActionWithMfa, toolName: string): PendingActionSummary {
  const tier = row.riskLevel as RiskLevel;
  const requiresMfa = row.requiresMfa;
  return withActionPolicy(
    safeParse<PendingActionSummary>(row.summaryJson, { ...fallbackSummary(toolName), toolName: row.toolName as ToolName,
      tier, requiresMfa }),
    { actionId: row.id, tier, requiresMfa });
}

/**
 * Read the persisted decision state of `actionId`; `null` when no such `PendingAction` row exists.
 * A missing row proves nothing is decidable, so no caller may invent a prompt from it.
 */
export async function loadParkedDecision(actionId: string, toolName: string): Promise<ParkedDecision | null> {
  const row = await getPendingAction(actionId);
  if (!row) return null;
  return { status: row.status as PendingActionStatus, summary: summaryOf(row, toolName), mfaLocked: row.mfa?.status === 'locked' };
}

/**
 * The public signal of a SETTLED decision — typed fields only, rendered by `lib/public-text.ts`
 * `securityNotice`. `locked` is TERMINAL (exhausted verification or an open circuit), so it is
 * reported as a lock notice instead of a decision prompt; every other terminal status
 * (`executed` / `failed` / `cancelled` / `needs_reconciliation`) is already carried by its own
 * execution evidence and yields no signal at all.
 */
export function settledDecisionSignal(actionId: string, decision: ParkedDecision): Extract<AgentStreamEvent, { type: 'security_event' }> | null {
  if (decision.status !== 'locked') return null;
  return { type: 'security_event', kind: 'locked', actionId,
    ...(decision.mfaLocked
      ? { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted' }
      : { code: 'CIRCUIT_OPEN', reason: 'circuit_open' }) };
}

/**
 * How a decision-prompt attempt ended. A settled row is never re-presented: `signalled` means the
 * typed lock notice for a terminal `locked` action was published instead, and `skipped` means the
 * row is missing or settled to a non-locked terminal status, so nothing at all was published.
 */
export type DecisionPromptOutcome = 'prompted' | 'signalled' | 'skipped';

/**
 * Publish a decision prompt (`mfa_required` / `confirmation_required` + its card) for `actionId`
 * ONLY while the persisted row is still open (`mayPromptForDecision`). A `locked` row (like every
 * other terminal status) is never re-presented as a decision: a locked verification must not be
 * re-activated, so the prompt is skipped and, for `locked`, the typed lock signal is published
 * instead. Returns `'prompted'` iff a prompt was published, `'signalled'` when only the typed lock
 * notice was published, and `'skipped'` when nothing was published at all.
 */
export async function publishPendingDecision(buffer: TurnBuffer, actionId: string, toolName: string,
  prompt: 'mfa' | 'confirmation', owner: ChatMessage | null): Promise<DecisionPromptOutcome> {
  const decision = await loadParkedDecision(actionId, toolName);
  if (!decision) return 'skipped';
  if (!mayPromptForDecision(decision.status)) {
    const signal = settledDecisionSignal(actionId, decision);
    if (!signal) return 'skipped';
    buffer.events.push(signal);
    return 'signalled';
  }
  const summary = decision.summary;
  if (prompt === 'mfa') {
    buffer.events.push({ type: 'mfa_required', actionId, hint: MFA_HINT, action: summary });
    emitCard(buffer, mfaCard(actionId, MFA_HINT, summary), owner);
  } else {
    buffer.events.push({ type: 'confirmation_required', actionId, action: summary });
    emitCard(buffer, confirmationCard(summary), owner);
  }
  return 'prompted';
}

/** Relay the graph without deriving its permissions from node labels or model content. */
export function relayPlanSnapshot(buffer: TurnBuffer, relay: PlanRelay, plan: TaskPlan): void {
  try {
    const owner = activePlanMessage(buffer);
    buffer.events.push({ type: 'plan_update', plan, ...(owner ? { messageId: owner.id } : {}) });
    const parked = plan.results.map(node => ({ node, actionId: readPendingActionId(node.output) }))
      .find(item => ['waiting_confirmation', 'waiting_verification'].includes(item.node.status) && item.actionId !== undefined);
    relay.parkedActionId = parked?.actionId;
    if (parked) relay.parkedToolName = parked.node.tool ?? '';
  } catch (error) { buffer.events.push({ type: 'error', message: safeToString(error) }); }
}

export async function flushParkedDecision(buffer: TurnBuffer, relay: PlanRelay): Promise<void> {
  try {
    const actionId = relay.parkedActionId;
    const toolName = relay.parkedToolName ?? 'submit_plan';
    relay.parkedActionId = undefined;
    relay.parkedToolName = undefined;
    if (!actionId) return;
    const owner = activePlanMessage(buffer) ?? null;
    const decision = await loadParkedDecision(actionId, toolName);
    // Only the persisted row can say whether this operation is still decidable. The prompt kind
    // follows the row's effective policy: an escalated/RED or strong-verification action needs MFA.
    const prompt = decision && (decision.summary.tier === 'RED' || decision.summary.requiresMfa) ? 'mfa' : 'confirmation';
    const outcome = await publishPendingDecision(buffer, actionId, toolName, prompt, owner);
    if (outcome === 'prompted' && owner) publishToolMessage(buffer, owner);
  } catch (error) { buffer.events.push({ type: 'error', message: safeToString(error) }); }
}

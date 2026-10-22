/**
 * `parked-actions.ts` — the TERMINAL-state fence over a plan's parked human decisions.
 *
 * A DAG node waiting for a human decision is persisted as `waiting_confirmation` /
 * `waiting_verification` with `{ pendingActionId }` inside `AgentTaskNode.output` (there is no
 * `pendingActionId` column), so the plan snapshot ALONE cannot tell an OPEN decision
 * (`pending` / `awaiting_mfa`) from an already-settled one. The security gateway settles an
 * operation terminally on its own — above all `locked`: the MFA attempt limit was exhausted and the
 * `PendingAction` was CAS-ed away from `pending`/`awaiting_mfa`. `locked` is a settled refusal; it
 * must never be re-presented, re-prompted, re-authorized, resumed, retried or executed again.
 *
 * The control paths (`./controls.ts` resume/retry) therefore ask THIS module, BEFORE they claim any
 * plan or node status, whether the plan still waits on an action that is already terminal. If it
 * does, the control is refused with a STRUCTURED `AppError`, so:
 *  - the persisted plan status is left exactly as it was (no `running` flip, no executor walk, no
 *    re-driving of the settled node);
 *  - the refusal's public `message` is catalog business text (`chat.error.*`) and never a status
 *    literal, a security payload, an id or a stack trace;
 *  - the implementation facts (task id / action id / status) live in `detail` only, for diagnostics.
 *
 * Invariants:
 *  - READ-ONLY: no status write, no claim, no execution, no replay, no new authorization;
 *  - the status vocabulary is the shared `../action-status` predicates (`isTerminalActionStatus` /
 *    `isOpenActionStatus`), never a private set of literals;
 *  - missing evidence proves nothing: an absent action row, and any status that is neither OPEN nor
 *    TERMINAL (`confirmed` — an authorized continuation still in flight), keep the caller's existing
 *    behavior; the gateway and the executor remain the only authority.
 */
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { getPendingActionOwnership } from '@/lib/db/repositories/pendingAction';
import { AppError } from '@/lib/errors';
import { DEFAULT_LOCALE, createTranslator } from '@/lib/i18n/shared';
import { isTerminalActionStatus } from '../action-status';
import { readPendingActionId } from './contracts';

/** Node statuses meaning "this node is parked on a human decision". */
const PARKED_NODE_STATUSES: readonly TaskNodeStatus[] = ['waiting_confirmation', 'waiting_verification'];

const t = createTranslator(DEFAULT_LOCALE);

/**
 * Every DISTINCT `PendingAction` id the plan's parked nodes wait on, in node order.
 *
 * Reuses `readPendingActionId` (the one reader of the persisted `{ pendingActionId }` output shape)
 * instead of parsing the node output again.
 */
export function parkedActionIds(plan: TaskPlan): string[] {
  const ids = new Set<string>();
  for (const node of plan.results) {
    if (!PARKED_NODE_STATUSES.includes(node.status)) continue;
    const actionId = readPendingActionId(node.output);
    if (actionId !== undefined) ids.add(actionId);
  }
  return [...ids];
}

/**
 * Refuse a control whose plan waits on a TERMINAL parked action (a settled operation).
 *
 * Throws BEFORE anything is claimed or executed, so the plan keeps its persisted status. `locked`
 * keeps its own structured code; an unknown outcome and every other settled status are a `CONFLICT`.
 */
export async function assertParkedActionsNotTerminal(plan: TaskPlan): Promise<void> {
  for (const actionId of parkedActionIds(plan)) {
    const action = await getPendingActionOwnership(actionId);
    if (action === null || !isTerminalActionStatus(action.status)) continue;
    throw refusal(plan.id, actionId, action.status);
  }
}

/** Structured refusal: catalog sentence in `message`, internal diagnostics in `detail` only. */
function refusal(taskId: string, actionId: string, status: string): AppError {
  const detail = { taskId, actionId, status };
  if (status === 'locked') return new AppError('MFA_LOCKED', t('chat.error.actionLocked'), detail);
  if (status === 'needs_reconciliation') return new AppError('CONFLICT', t('chat.error.unknownOutcome'), detail);
  return new AppError('CONFLICT', t('chat.error.stateChanged'), detail);
}

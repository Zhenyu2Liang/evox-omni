/**
 * `parked-actions.ts` — the TERMINAL-state contract over a plan's parked human decisions.
 *
 * A DAG node waiting for a human decision is persisted as `waiting_confirmation` /
 * `waiting_verification` with `{ pendingActionId }` inside `AgentTaskNode.output` (there is no
 * `pendingActionId` column), so the plan snapshot ALONE cannot tell an OPEN decision
 * (`pending` / `awaiting_mfa`) from an already-settled one. The security gateway settles an
 * operation terminally on its own — above all `locked`: the MFA attempt limit was exhausted and the
 * `PendingAction` was CAS-ed away from `pending`/`awaiting_mfa`. `locked` is a settled refusal; it
 * must never be re-presented, re-prompted, re-authorized, resumed, retried or executed again.
 *
 * Two readers, one vocabulary:
 *  - `sealedParkedNodes` is the READ-ONLY query `./controls.ts` #resumeTask uses to SEAL such a node:
 *    the node is recorded terminal (never driven, never surfaced as a pending decision), while the
 *    rest of the plan keeps advancing. A plan whose every node is sealed simply has nothing left to
 *    advance — that is a normal return, not an exception.
 *  - `assertParkedActionsNotTerminal` is the RETRY fence: an explicit retry must stay a STRUCTURED
 *    refusal (`AppError` with catalog text), because a retry of a settled decision would otherwise
 *    reset the node and re-drive the very operation that is terminally locked.
 *
 * Invariants:
 *  - READ-ONLY: no status write, no claim, no execution, no replay, no new authorization;
 *  - the status vocabulary is the shared `../action-status` predicates (`isTerminalActionStatus`) and
 *    the plan layer's ONE seal contract (`@/planner` `sealReason`), never a private set of literals;
 *  - the public sentences are catalog business text (`chat.error.*`), never a status literal, a
 *    security payload, an id or a stack trace; implementation facts stay in `detail` (diagnostics);
 *  - missing evidence proves nothing: an absent action row, and any status that is neither OPEN nor
 *    TERMINAL (`confirmed` — an authorized continuation still in flight), keep the caller's existing
 *    behavior; the gateway and the executor remain the only authority.
 */
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { getPendingActionOwnership } from '@/lib/db/repositories/pendingAction';
import { AppError } from '@/lib/errors';
import { DEFAULT_LOCALE, createTranslator } from '@/lib/i18n/shared';
import { sealReason, type SealReason } from '@/planner';
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

/** One parked node whose decision is already settled, and therefore must stay sealed. */
export interface SealedParkedNode {
  nodeId: string;
  actionId: string;
  /** The persisted, TERMINAL status of that action. */
  actionStatus: PendingActionStatus;
  /** Why the node must not be driven again — the plan layer's own seal reason. */
  reason: SealReason;
  /** Catalog sentence a sealed node records as its public `error`. */
  error: string;
}

/**
 * The parked nodes whose action is TERMINAL, in node order. Pure read: no write, no claim.
 *
 * A node counts as sealed only when the action row exists AND its status is terminal; the seal reason
 * itself comes from the plan layer (`sealReason`), so the executor and the control path agree on what
 * "settled" means.
 */
export async function sealedParkedNodes(plan: TaskPlan): Promise<SealedParkedNode[]> {
  const sealed: SealedParkedNode[] = [];
  for (const node of plan.results) {
    if (!PARKED_NODE_STATUSES.includes(node.status)) continue;
    const actionId = readPendingActionId(node.output);
    if (actionId === undefined) continue;
    const action = await getPendingActionOwnership(actionId);
    if (action === null || !isTerminalActionStatus(action.status)) continue;
    const actionStatus = action.status as PendingActionStatus;
    const reason = sealReason({ ...node, actionStatus });
    if (reason === undefined) continue;
    sealed.push({ nodeId: node.id, actionId, actionStatus, reason, error: publicSentence(actionStatus) });
  }
  return sealed;
}

/**
 * Refuse a control whose plan still waits on a TERMINAL parked action (a settled operation).
 *
 * Throws BEFORE anything is claimed or executed, so the plan keeps its persisted status. `locked`
 * keeps its own structured code; an unknown outcome and every other settled status are a `CONFLICT`.
 */
export async function assertParkedActionsNotTerminal(plan: TaskPlan): Promise<void> {
  const [sealed] = await sealedParkedNodes(plan);
  if (sealed === undefined) return;
  throw refusal(plan.id, sealed.actionId, sealed.actionStatus);
}

/** The catalog sentence a settled status is reported with — the ONLY public wording. */
function publicSentence(status: PendingActionStatus): string {
  if (status === 'locked') return t('chat.error.actionLocked');
  if (status === 'needs_reconciliation') return t('chat.error.unknownOutcome');
  return t('chat.error.stateChanged');
}

/** Structured refusal: catalog sentence in `message`, internal diagnostics in `detail` only. */
function refusal(taskId: string, actionId: string, status: PendingActionStatus): AppError {
  const detail = { taskId, actionId, status };
  if (status === 'locked') return new AppError('MFA_LOCKED', publicSentence(status), detail);
  return new AppError('CONFLICT', publicSentence(status), detail);
}

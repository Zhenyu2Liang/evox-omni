/**
 * `outcomes.ts` — the agent-side projections of a refusal around a human decision.
 *
 * Every refusal built here carries TYPED facts (`code`, plus `failure` for a security refusal) and a
 * message rendered by the ONE public-text funnel (`lib/public-text.ts`). Gateway sentences, internal
 * status literals (`locked`, `cancelled`, …), action/session ids and `__SECURITY_BLOCK__` payloads
 * never become user-visible text: structured facts stay on their typed fields.
 */
import type { MessageKey } from '@/lib/i18n/shared';
import { createTranslator, DEFAULT_LOCALE } from '@/lib/i18n/shared';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus, SecurityFailure, SecurityFailureReason } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { AuthorizationResult } from '@/security/security-gateway';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { getTask } from '@/lib/db/repositories/task';
import type { ErrorCode } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import { safePublicText, securityNotice } from '@/lib/public-text';
import { publicToolError } from '@/lib/tool-feedback';
import { mayPromptForDecision } from '../action-status';
import { findTaskByPendingAction } from '../task-control';
import { recoverStandaloneWedge } from '../confirmation-recovery';
import type { ConfirmOptions, ConfirmationOutcome } from './contracts';

/** One translator for this layer: refusals are server-authored in the default locale. */
const t = createTranslator(DEFAULT_LOCALE);

/**
 * The public sentence of a cancelled owning plan — a business fact only. It carries no task id, no
 * action id and no status literal; those stay in the persisted plan/action rows and diagnostics.
 */
const CANCELLED_PLAN_REFUSAL = '该操作所属的任务计划已取消，已拒绝执行。';

export function emitAll(events: readonly AgentStreamEvent[], opts?: ConfirmOptions): void {
  for (const event of events) opts?.onEvent?.(event);
}

export function effectiveTier(view: AuthorizationResult): RiskLevel {
  return view.requiresMfa ? 'RED' : view.tier;
}

/** Map a public error code onto the typed refusal reason, so every refusal carries BOTH. */
function failureReasonFor(code: ErrorCode): SecurityFailureReason {
  if (code === 'MFA_FAILED') return 'mfa_code_invalid';
  if (code === 'MFA_LOCKED') return 'mfa_attempts_exhausted';
  if (code === 'CIRCUIT_OPEN') return 'circuit_open';
  // A manual-review hold is NOT a denial: the operation is intact and unexecuted, only held.
  if (code === 'MANUAL_REVIEW_HOLD') return 'manual_review_hold';
  return 'denied';
}

/** The structured facts of a plain refusal: the code, its derived reason and the owning action. */
function refusalFacts(code: ErrorCode, actionId: string): SecurityFailure {
  return { code, reason: failureReasonFor(code), actionId };
}

/**
 * The public sentence of ONE refusal — the single place a refusal message is produced:
 *  - complete typed facts (`failure`) → `securityNotice` (reason, remaining attempts);
 *  - a known code only → the funnel's code rendering (`publicToolError` with `code`), so the
 *    sentence still comes from the message catalog;
 *  - otherwise → `safePublicText`: the allow-listed business text, else `fallback`.
 * Internal diagnostics (`__SECURITY_BLOCK__…`, JSON fragments, stack traces, `undefined`) always
 * resolve to a catalog sentence and never reach the user.
 */
export function publicRefusalMessage(
  text: string | undefined,
  refusal: { code?: ErrorCode; failure?: SecurityFailure },
  fallback: MessageKey = 'chat.error.securityDenied',
): string {
  if (refusal.failure !== undefined) return securityNotice(refusal.failure, t);
  if (refusal.code !== undefined) return publicToolError(text, t, fallback, refusal.code);
  return safePublicText(text, t, fallback);
}

/** A cancelled workflow cannot authorize a late decision. */
export async function cancelledPlanOutcome(
  actionId: string,
  sessionId: string,
): Promise<ConfirmationOutcome | undefined> {
  const located = await findTaskByPendingAction(sessionId, actionId);
  if (located === undefined) return undefined;
  const task = await getTask(located.taskId);
  if (task === null || task.status !== 'cancelled') return undefined;
  const row = await getPendingAction(actionId);
  const code: ErrorCode = 'SECURITY_DENIED';
  return {
    ok: false,
    actionId,
    status: (row?.status as PendingActionStatus | undefined) ?? 'cancelled',
    tier: (row?.riskLevel as RiskLevel | undefined) ?? 'YELLOW',
    requiresMfa: row?.requiresMfa === true,
    code,
    failure: refusalFacts(code, actionId),
    message: CANCELLED_PLAN_REFUSAL,
    events: [],
  };
}

/**
 * Converge a standalone wedge before reporting a refused decision.
 *
 * Projects the refusal the gateway raised into a DOMAIN outcome: `ok: false` plus the PERSISTED
 * status and the typed `code`/`failure`. The historical name is kept because `CONFLICT` is still its
 * main caller; the code and the public sentence always come from the error handed in, so a
 * `MANUAL_REVIEW_HOLD` renders its own hold copy instead of the generic "state changed" fallback.
 */
export async function conflictOutcome(actionId: string, error: AppError): Promise<ConfirmationOutcome> {
  const recovered = await recoverStandaloneWedge(actionId, { selfHoldsLiveMarker: true });
  if (recovered !== undefined) {
    // A wedge settlement is forwarded as-is. It carries no code of its own, so a `!ok` settlement is
    // typed with the CONFLICT that reached this function — without a fabricated `failure`
    // (`reason: 'denied'` would misdescribe an unknown-outcome settlement).
    const carried = (recovered as Partial<ConfirmationOutcome>).code;
    return recovered.ok || carried !== undefined ? recovered : { ...recovered, code: 'CONFLICT' };
  }
  const row = await getPendingAction(actionId);
  return {
    ok: false,
    actionId,
    status: (row?.status as PendingActionStatus | undefined) ?? 'cancelled',
    tier: (row?.riskLevel as RiskLevel | undefined) ?? 'YELLOW',
    requiresMfa: row?.requiresMfa === true,
    code: error.code,
    failure: refusalFacts(error.code, actionId),
    // The gateway's own sentence interpolates the raw status literal, so it is funnelled.
    message: publicRefusalMessage(error.message, { code: error.code }, 'chat.error.stateChanged'),
    events: [],
  };
}

/**
 * A cancel that did NOT settle: the row never reached `cancelled`, so success must not be claimed
 * and no `cancelled` audit is written. The persisted status is reported as a typed field.
 */
export function unappliedCancelOutcome(
  actionId: string,
  status: PendingActionStatus,
  tier: RiskLevel,
  requiresMfa: boolean,
): ConfirmationOutcome {
  const code: ErrorCode = 'CONFLICT';
  return {
    ok: false,
    actionId,
    status,
    tier,
    requiresMfa,
    code,
    failure: refusalFacts(code, actionId),
    message: publicRefusalMessage(undefined, { code }, 'chat.error.stateChanged'),
    events: [],
  };
}

/** Emit MFA only for an undecided action; terminal refusals cannot request another code. */
export function blockedOutcome(
  actionId: string,
  view: AuthorizationResult,
  opts?: ConfirmOptions,
): ConfirmationOutcome {
  // Only an OPEN decision may ask for a code: a terminal status (including `locked`) requests none.
  const events: AgentStreamEvent[] = view.requiresMfa && mayPromptForDecision(view.status)
    ? [{ type: 'mfa_required', actionId, action: view.action?.summary }] : [];
  emitAll(events, opts);
  const code = view.code ?? view.failure?.code;
  const facts: { code?: ErrorCode; failure?: SecurityFailure } = {
    ...(code !== undefined ? { code } : {}),
    ...(view.failure !== undefined ? { failure: view.failure } : {}),
  };
  return {
    ok: false,
    actionId,
    status: view.status,
    tier: effectiveTier(view),
    requiresMfa: view.requiresMfa,
    ...facts,
    // A typed refusal renders from its facts; the undecided "code issued" branch keeps its human
    // prompt only while that prompt is an allow-listed, non-diagnostic sentence.
    message: facts.code === undefined && facts.failure === undefined
      ? safePublicText(view.message, t, 'chat.display.safetyHint')
      : publicRefusalMessage(view.message, facts),
    events,
  };
}

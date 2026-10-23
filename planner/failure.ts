/**
 * planner/failure.ts — the plan layer's ONE structured-failure / node-drive contract.
 *
 * A refusal reported by the injected `runTool` port is TYPED (`SecurityFailure` in
 * `lib/contracts/security`): an `ErrorCode`, an optional `SecurityFailureReason` and the numbers a
 * renderer needs. The plan layer carries those facts unchanged as `PlanFailure` — never a serialized
 * gateway payload — because `error` / `summary` / `output` are RENDERABLE node fields: they only ever
 * hold text `lib/public-text` would publish. `publicFailureText` is the projection used on the way in.
 *
 * This module also answers the ONE question every re-drive path asks: may this node's tool run
 * again? A locked refusal (`mfa_attempts_exhausted` / `mfa_session_locked` / `circuit_open`) and an
 * action that is no longer OPEN (see `agent/action-status.ts`) are SETTLED refusals — re-driving them
 * would mint a fresh `pending` action and re-prompt a decision that no longer exists.
 */
import type { PendingActionStatus, SecurityFailure, SecurityFailureReason } from '@/lib/contracts/security';
import type { TaskNodeResult } from '@/lib/contracts/task';
import type { ErrorCode } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import { isOpenActionStatus } from '@/agent/action-status';
import { isInternalDiagnostic } from '@/lib/public-text';
import { isTerminalStatus } from './executor';

/**
 * The structured refusal a plan node carries. Shape-aligned with `SecurityFailure` (which is
 * assignable to it), with `reason` optional because a non-security failure only has a `code`.
 * It never carries the raw gateway payload.
 */
export interface PlanFailure {
  code: ErrorCode;
  reason?: SecurityFailureReason;
  actionId?: string;
  attemptsUsed?: number;
  attemptsLeft?: number;
  maxAttempts?: number;
}

/**
 * A node result as the plan layer records it: the frozen `TaskNodeResult` plus the parked-node facts
 * (`summary` / `pendingActionId`) and the two structured refusal fields. Every port (`persistNode`,
 * `onNodeUpdate`, plan snapshots) carries these fields through untouched.
 */
export interface PlanNodeResult extends TaskNodeResult {
  /** Human-readable summary of a successful tool call (already projected, never a diagnostic). */
  summary?: string;
  /** The gated action this node waits on — an opaque id, never re-minted by the executor. */
  pendingActionId?: string;
  /** Structured refusal facts (error code + renderable parameters); never a raw payload. */
  failure?: PlanFailure;
  /** Persisted `PendingAction` status the result was derived from; `undefined` when unknown. */
  actionStatus?: PendingActionStatus;
}

/** Reasons that make a refusal a SETTLED lock (terminal: never re-driven, never re-prompted). */
const LOCKED_REASONS: ReadonlySet<SecurityFailureReason> = new Set<SecurityFailureReason>([
  'mfa_attempts_exhausted',
  'mfa_session_locked',
  'circuit_open',
]);

/** Error codes that mean the same thing when the reason is not carried. */
const LOCKED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['MFA_LOCKED', 'CIRCUIT_OPEN']);

/**
 * Normalize any refusal source into `PlanFailure`, copying only the TYPED fields that are present.
 * `undefined`/`null` (no structured failure was reported) stays `undefined`.
 */
export function toPlanFailure(
  source: SecurityFailure | PlanFailure | AppError | undefined | null,
): PlanFailure | undefined {
  if (source === undefined || source === null) return undefined;
  if (source instanceof AppError) return { code: source.code };
  const failure: PlanFailure = { code: source.code };
  if (source.reason !== undefined) failure.reason = source.reason;
  if (source.actionId !== undefined) failure.actionId = source.actionId;
  if (source.attemptsUsed !== undefined) failure.attemptsUsed = source.attemptsUsed;
  if (source.attemptsLeft !== undefined) failure.attemptsLeft = source.attemptsLeft;
  if (source.maxAttempts !== undefined) failure.maxAttempts = source.maxAttempts;
  return failure;
}

/**
 * Is this refusal a LOCK — an exhausted verification, a locked MFA session or an open circuit?
 * Decided from the TYPED `reason` / `code` only, never from message text.
 */
export function isLockedRefusal(failure?: PlanFailure | null): boolean {
  if (!failure) return false;
  if (failure.reason !== undefined && LOCKED_REASONS.has(failure.reason)) return true;
  return LOCKED_CODES.has(failure.code);
}

/**
 * Project text bound for a RENDERABLE field: internal diagnostics (`__SECURITY_BLOCK__…` payloads,
 * serialized JSON, stack frames, `undefined`/`[object Object]`) are dropped, public business text is
 * kept verbatim. Rendering (i18n, catalog fallbacks) stays in `lib/public-text`.
 */
export function publicFailureText(text?: string): string | undefined {
  if (typeof text !== 'string') return undefined;
  if (text.trim() === '') return undefined;
  return isInternalDiagnostic(text) ? undefined : text;
}

/** Why a recorded node must not be driven again. */
export type SealReason = 'locked_refusal' | 'action_not_open';

/**
 * Why is this node SEALED (its gated action settled), if it is?
 *  - `locked_refusal` — the recorded refusal is a lock (exhausted attempts / locked session / circuit);
 *  - `action_not_open` — the referenced `PendingAction` is no longer `pending` / `awaiting_mfa`
 *    (`executed`, `failed`, `cancelled`, `locked`, `needs_reconciliation`, `confirmed`).
 */
export function sealReason(result?: PlanNodeResult | null): SealReason | undefined {
  if (!result) return undefined;
  if (isLockedRefusal(result.failure)) return 'locked_refusal';
  if (result.actionStatus !== undefined && !isOpenActionStatus(result.actionStatus)) return 'action_not_open';
  return undefined;
}

/**
 * May this node's tool be driven (again) right now?
 *  - no recorded result (never ran) → yes;
 *  - a TERMINAL node status → no (the node will not run again on its own);
 *  - a sealed action (see `sealReason`) → no;
 *  - otherwise → yes, including a still-OPEN action (`pending` / `awaiting_mfa`), whose idempotency
 *    is the caller's execution key / receipt.
 */
export function mayDriveNode(result?: PlanNodeResult | null): boolean {
  if (!result) return true;
  if (isTerminalStatus(result.status)) return false;
  return sealReason(result) === undefined;
}

/**
 * May an EXPLICIT retry reset this node to `pending`? Unlike `mayDriveNode`, a TERMINAL status is
 * resettable — that IS what retry does. A sealed action is not: the refusal is settled and the tool
 * must not run again, so its recorded `failure` is never overwritten by a fresh `pending` row.
 */
export function mayResetNode(result?: PlanNodeResult | null): boolean {
  return sealReason(result) === undefined;
}

import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { ToolExecutionResult } from '../tools';
import type { RunTurnDeps } from '../run-turn';

/** Request identity is an assertion against persisted ownership, never a grant. */
export interface ConfirmOptions {
  /** Trusted page callers can settle a reviewed operation without a model narration request. */
  narrate?: boolean;
  deps?: RunTurnDeps;
  onEvent?: (event: AgentStreamEvent) => void;
  userId?: string;
  sessionId?: string;
}

/**
 * The outcome of one human decision (`confirm` / MFA `verify` / `cancel`).
 *
 * Refusal contract: EVERY `!ok` outcome carries a typed `code` (plus the structured `failure` for a
 * security refusal), so no caller ever parses text. `message` is always a public sentence — a
 * server-authored business sentence or one rendered by the funnel (`lib/public-text.ts`) — and never
 * contains an internal status literal (`locked`, `cancelled`, …), an action/session id, JSON, a
 * stack trace or a `__SECURITY_BLOCK__` payload. `status` is the persisted decision state; anything
 * but `pending`/`awaiting_mfa` is TERMINAL (`locked` in particular), so a terminal outcome is never
 * re-prompted for a code, re-activated, resumed or executed.
 */
export interface ConfirmationOutcome {
  ok: boolean;
  actionId: string;
  status: PendingActionStatus;
  tier: RiskLevel;
  requiresMfa: boolean;
  /** Funnel-rendered public sentence; never a raw gateway or security payload. */
  message: string;
  /** Typed refusal code, so a caller never parses the message. */
  code?: import('@/lib/errors').ErrorCode;
  /** Structured refusal facts (code + reason + attempts); never rendered as a diagnostic. */
  failure?: import('@/lib/contracts/security').SecurityFailure;
  result?: ToolExecutionResult;
  events: AgentStreamEvent[];
}

/** The planner's gateway execution port reports failures as values. */
export interface GatedToolOutcome {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  errorCode?: import('@/lib/errors').ErrorCode;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
  /**
   * Structured refusal facts, normalized by `planner/failure.ts#toPlanFailure` from the gateway's own
   * `SecurityFailure` — code plus the reason/attempts it ACTUALLY reported (never invented from text).
   */
  failure?: import('@/planner/failure').PlanFailure;
  /** PERSISTED status of the `PendingAction` behind this outcome; absent when the node has none. */
  actionStatus?: PendingActionStatus;
}

export interface TrustedIdentity {
  userId: string;
  sessionId: string;
}

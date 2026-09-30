/**
 * Security Gateway — THE chokepoint of the code-enforced safety model.
 *
 * Every banking tool call proposed by the model passes through here. The gateway:
 *   1. loads today's transfer total for the user,
 *   2. consults the session circuit breaker,
 *   3. asks `permission-engine.evaluateTool` for a tier (static table + dynamic rules),
 *   4. turns the evaluation into a `SecurityDecision` (allow / require_confirmation /
 *      require_mfa / deny),
 *   5. for gated calls, persists a `PendingAction` and returns an opaque block-reason
 *      string (what the agent's `beforeToolCall` returns to the runtime), and
 *   6. later `authorizeAction`s the ORIGINAL validated args on a human confirm/MFA.
 *
 * The gateway NEVER executes the business operation — it only authorizes. Execution is
 * performed by the agent layer via the Banking SDK, using the args the gateway validated.
 * Money-moving calls are therefore always triggered by a human decision, never by model text.
 */
import type { RiskLevel } from '../lib/contracts/risk';
import type { ToolName } from '../lib/contracts/tools';
import type {
  PendingAction,
  PendingActionStatus,
  SecurityDecision,
  SecurityDecisionKind,
  SecurityEvaluation,
} from '../lib/contracts/security';
import type { ToolEvaluation } from './permission-engine';

/** Prefix wrapped around the serialized block reason so `parseBlockReason` is exact. */
export const BLOCK_REASON_PREFIX = '__SECURITY_BLOCK__';

/** Everything the gateway needs about a proposed tool call. */
export interface GatewayContext {
  sessionId: string;
  userId: string;
  toolName: ToolName;
  args: Record<string, unknown>;
  /** The user's original natural-language request (for audit); never used for permission. */
  userRequest: string;
}

/** Result of a human confirm/verify decision on a pending action. */
export interface AuthorizationResult {
  /** `true` iff the action is now authorized for execution by the caller. */
  ok: boolean;
  /** Resulting status: `confirmed` (authorized) | `awaiting_mfa` | `locked` | `cancelled` | `failed`. */
  status: PendingActionStatus;
  actionId: string;
  tier: RiskLevel;
  requiresMfa: boolean;
  mfaResult?: 'success' | 'failed' | 'not_required';
  /** Safe, user-facing message (never leaks the MFA code). */
  message: string;
  /** The updated pending action, when available. */
  action?: PendingAction;
}

/** What `beforeToolCall` needs in one shot. */
export interface ToolCallAuthorization {
  evaluation: SecurityEvaluation;
  decision: SecurityDecision;
  /** Present (and persisted) when the call is gated and blocked this turn. */
  action?: PendingAction;
  /** Opaque string to return as the runtime block reason; present iff `evaluation.blocked`. */
  blockReason?: string;
}

/**
 * Convenience orchestrator for the agent layer's `beforeToolCall` hook:
 * `evaluate → decide → (creates PendingAction + block reason when gated)`.
 * Returns the tool evaluation, the decision, and — when blocked — the persisted action
 * and the opaque block reason. (Optional: the fine-grained methods below may be used directly.)
 */
export interface SecurityGateway {
  /** Full evaluation: circuit breaker + permission/risk engines + daily-transfer lookup. */
  evaluate(ctx: GatewayContext): Promise<SecurityEvaluation>;
  /** Map an evaluation to a decision kind + user-facing message (pure, no I/O). */
  decide(ev: SecurityEvaluation, ctx: GatewayContext): SecurityDecision;
  /** Persist a gated call as a `PendingAction` with a `PendingActionSummary`. */
  createPendingAction(ctx: GatewayContext, ev: SecurityEvaluation): Promise<PendingAction>;
  /** Serialize the opaque block reason the runtime returns to the model. */
  serializeBlockReason(decision: SecurityDecision, action: PendingAction): string;
  /** Parse a block reason produced by `serializeBlockReason`; `null` if not a block reason. */
  parseBlockReason(reason: string): { actionId: string; decision: SecurityDecisionKind } | null;
  /**
   * Authorize a pending action after a human decision.
   *  - YELLOW: authorize directly (status → `confirmed`).
   *  - RED: require + verify `mfaCode` via `mfa.verify` (status → `confirmed` on success).
   *  - locked session: refused (`status: 'locked'`); honors the circuit breaker.
   * Does NOT execute the business operation.
   */
  authorizeAction(actionId: string, opts?: { mfaCode?: string }): Promise<AuthorizationResult>;
  /** Cancel a pending action (status → `cancelled`); no execution. */
  cancelAction(actionId: string): Promise<PendingAction>;
  /** End-to-end helper used by `beforeToolCall`. */
  handleToolCall(ctx: GatewayContext): Promise<ToolCallAuthorization>;
}

export const securityGateway: SecurityGateway = {
  async evaluate(ctx: GatewayContext): Promise<SecurityEvaluation> {
    throw new Error('not implemented');
  },

  decide(ev: SecurityEvaluation, ctx: GatewayContext): SecurityDecision {
    throw new Error('not implemented');
  },

  async createPendingAction(ctx: GatewayContext, ev: SecurityEvaluation): Promise<PendingAction> {
    throw new Error('not implemented');
  },

  serializeBlockReason(decision: SecurityDecision, action: PendingAction): string {
    throw new Error('not implemented');
  },

  parseBlockReason(reason: string): { actionId: string; decision: SecurityDecisionKind } | null {
    throw new Error('not implemented');
  },

  async authorizeAction(actionId: string, opts?: { mfaCode?: string }): Promise<AuthorizationResult> {
    throw new Error('not implemented');
  },

  async cancelAction(actionId: string): Promise<PendingAction> {
    throw new Error('not implemented');
  },

  async handleToolCall(ctx: GatewayContext): Promise<ToolCallAuthorization> {
    throw new Error('not implemented');
  },
};

/**
 * Build the user-facing `PendingActionSummary` for a gated call (title, key/value fields
 * such as 收款人 / 金额 / 账户 / 风险等级, `requiresMfa`, `mfaHint`). Pure — formatting only.
 * Exported for reuse/testing.
 */
export function buildPendingActionSummary(
  ctx: GatewayContext,
  ev: SecurityEvaluation,
): import('../lib/contracts/security').PendingActionSummary {
  throw new Error('not implemented');
}

/** Re-exported for the agent layer's convenience (the raw evaluation shape). */
export type { ToolEvaluation };

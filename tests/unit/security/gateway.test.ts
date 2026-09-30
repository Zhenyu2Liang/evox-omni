/**
 * Unit: security/security-gateway — the code-enforced chokepoint (evaluate → decide → pending → authorize).
 *
 * Targets `@/security/security-gateway`: securityGateway.{evaluate,decide,createPendingAction,
 * serializeBlockReason,parseBlockReason,authorizeAction,cancelAction,handleToolCall},
 * buildPendingActionSummary, BLOCK_REASON_PREFIX (+ types GatewayContext, SecurityGateway,
 * AuthorizationResult, ToolCallAuthorization).
 *
 * `decide` / `serializeBlockReason` / `parseBlockReason` / `buildPendingActionSummary` are PURE.
 * `evaluate` / `createPendingAction` / `authorizeAction` / `cancelAction` / `handleToolCall` persist
 * PendingAction rows and consult the circuit breaker → require test SQLite via ../helpers/db.
 * The gateway NEVER executes the business operation — it only authorizes.
 */
import { describe, it } from 'vitest';

// import { securityGateway, buildPendingActionSummary, BLOCK_REASON_PREFIX } from '@/security/security-gateway';   // <- uncomment in Phase 2

describe('security-gateway · decide (pure: tier → decision kind)', () => {
  it.todo('GREEN evaluation → decision kind allow with a user-facing message');
  it.todo('YELLOW evaluation → decision kind require_confirmation');
  it.todo('RED evaluation → decision kind require_mfa');
  it.todo('every decision carries a safe user-facing message (no MFA code, no internals)');
});

describe('security-gateway · block reason round-trip (pure)', () => {
  it.todo('serializeBlockReason prefixes with BLOCK_REASON_PREFIX and embeds actionId + decisionKind');
  it.todo('parseBlockReason(serializeBlockReason(decision, action)) → { actionId, decisionKind } (exact round-trip)');
  it.todo('parseBlockReason returns null for a plain non-block string');
  it.todo('parseBlockReason returns null for a malformed block string (missing fields)');
});

describe('security-gateway · createPendingAction (needs test SQLite)', () => {
  it.todo('persists a PendingAction row (status awaiting_confirmation / awaiting_mfa per tier) and returns it with the summary');
  it.todo('buildPendingActionSummary for transfer_money includes the fields 收款人 / 金额 / 账户 / 风险等级');
  it.todo('RED action summary sets requiresMfa true + a code-free mfaHint; YELLOW summary sets requiresMfa false');
  it.todo('the persisted args are the validated originals (used later for the authorized execution path)');
});

describe('security-gateway · authorizeAction (needs test SQLite)', () => {
  it.todo("YELLOW action authorizes with no code → ok true, status 'confirmed'");
  it.todo("RED action without mfaCode → ok false, status 'awaiting_mfa' (nothing executed)");
  it.todo("RED action with a wrong code → ok false, mfaResult 'failed', breaker failure recorded");
  it.todo("RED action with code '123456' → ok true, status 'confirmed', mfaResult 'success'");
  it.todo("locked session (breaker tripped) → refused, status 'locked', even with the correct code");
});

describe('security-gateway · cancelAction (needs test SQLite)', () => {
  it.todo("cancelAction(id) → status 'cancelled'; the business op is never executed");
  it.todo('cancelling an unknown or already-terminal action surfaces an AppError');
});

describe('security-gateway · handleToolCall composition', () => {
  it.todo('GREEN tool → evaluation not blocked, decision allow, no PendingAction, no blockReason');
  it.todo('YELLOW tool → blocked: PendingAction persisted + a round-trippable blockReason');
  it.todo('RED tool → blocked with decision kind require_mfa');
  it.todo('handleToolCall never invokes banking-sdk / never moves money — it only evaluates, persists and blocks');
});

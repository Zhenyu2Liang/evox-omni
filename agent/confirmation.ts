/**
 * confirmation.ts — the two-phase confirmation continuation.
 * A gated (YELLOW/RED) call was blocked by `beforeToolCall` and persisted by `security.gateway`.
 * On a human decision: (1) authorize via `security.gateway.authorizeAction`/`cancelAction`;
 * (2) on success execute the ORIGINAL validated args through the Banking SDK via the
 * gateway-authorized path (`executeGatedTool` → `registry.executeDirect`) — NEVER the LLM;
 * (3) write the audit entry, inject the REAL result, `agent.continue()` to narrate the outcome.
 * `executeGatedTool` is ALSO the `runTool` the agent passes to the planner so DAG nodes gate too.
 */
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
// `security/index.ts` re-exports the gateway as a *namespace* only; its types (GatewayContext,
// AuthorizationResult, ToolCallAuthorization) live in the documented sub-module, which the security
// node explicitly permits importing directly. Runtime calls still go through `security.gateway.*`.
import type { GatewayContext } from '@/security/security-gateway';
import type { ToolExecutionResult } from './tools';
import type { RunTurnDeps } from './run-turn';

export interface ConfirmOptions { deps?: RunTurnDeps; }
export interface ConfirmationOutcome {
  ok: boolean;
  actionId: string;
  status: PendingActionStatus;
  tier: RiskLevel;
  message: string;
  result?: ToolExecutionResult;
  events: AgentStreamEvent[];
}
/** Outcome of the single gateway-authorized execution path (mirrors planner's PlanToolOutcome). */
export interface GatedToolOutcome {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
}
/** Gate a tool call through the gateway and, when allowed, execute it through the SDK. */
export function executeGatedTool(ctx: GatewayContext): Promise<GatedToolOutcome> {
  throw new Error('not implemented');
}
/** YELLOW (or RED after MFA) — authorize a pending action and execute its original args. */
export function confirmAction(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome> {
  throw new Error('not implemented');
}
/** RED — verify the mock MFA code, then authorize + execute. */
export function verifyAction(actionId: string, code: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome> {
  throw new Error('not implemented');
}
/** Cancel a pending action; no execution. */
export function cancelAction(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome> {
  throw new Error('not implemented');
}

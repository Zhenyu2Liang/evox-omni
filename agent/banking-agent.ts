/**
 * banking-agent.ts — builds and owns the Pi `Agent` instance for one session.
 * ONLY place a Pi Agent is constructed. Loads the banking system prompt, builds the per-user tool
 * registry (`./tools`), selects the provider (`./providers`), restores `AgentState`, and installs:
 *  - `beforeToolCall` → `security.gateway.handleToolCall` (the ONE security chokepoint; returns
 *    `{block:true, reason}` for any gated tool — the model CANNOT execute YELLOW/RED itself);
 *  - `afterToolCall`  → records the tool outcome for the UI stream.
 * The agent NEVER decides a tier; money moves only via the two-phase confirmation flow (`./confirmation`).
 */
import type { Agent } from '@mariozechner/pi-agent-core';
import type { ToolName } from '@/lib/contracts/tools';
import type { AppConfig } from '@/lib/config';
import type { ToolRegistry } from './tools';
import type { SessionSnapshot } from './session';

export interface BankingAgentOptions {
  sessionId: string;
  userId: string;
  /** Restored AgentState + transcript; omitted ⇒ fresh session. */
  snapshot?: SessionSnapshot;
  /** Override config (tests). Defaults to `getConfig()`. */
  config?: AppConfig;
}
export interface BankingAgentRuntime {
  agent: Agent;
  sessionId: string;
  userId: string;
  registry: ToolRegistry;
  /** Current pi AgentState + UI transcript, ready to persist. */
  serialize(): SessionSnapshot;
  /** Remove all stream listeners. */
  dispose(): void;
}
/** Runtime beforeToolCall hook: gate a proposed tool call through the security chokepoint. */
export type BeforeToolCallHook = (
  toolCallId: string,
  toolName: ToolName,
  args: Record<string, unknown>,
) => Promise<{ block: boolean; reason?: string }>;
/** Runtime afterToolCall hook: capture the outcome for the UI stream. */
export type AfterToolCallHook = (
  toolCallId: string,
  toolName: ToolName,
  result: unknown,
) => Promise<void>;
/** Build the Pi Agent for a session (restores AgentState from `options.snapshot` when present). */
export function createBankingAgent(options: BankingAgentOptions): BankingAgentRuntime {
  throw new Error('not implemented');
}

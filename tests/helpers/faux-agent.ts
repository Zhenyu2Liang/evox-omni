/**
 * tests/helpers/faux-agent.ts — build a REAL Pi Agent driven by a SCRIPTED model.
 *
 * Scenario tests exercise the full pipeline (Agent runtime → registered banking tools →
 * Security Gateway `beforeToolCall` → Banking SDK → audit) while keeping the MODEL
 * deterministic and offline, via `registerFauxProvider()` (from `@mariozechner/pi-ai`) and
 * `LLM_MODE=mock`. Only the model is scripted — the tools, the security chokepoint and the
 * DB are the production ones. This is what makes the 12 demo scenarios provable without a
 * network or an API key.
 *
 * STATUS: documented STUB — signatures frozen; implementation lands in Phase 2 once the
 * `./agent` runtime wiring exports its tool registry + `beforeToolCall` builder.
 *
 * Key SDK facts this helper relies on (pi-agent-core 0.73.1):
 *   - `new Agent({ initialState, beforeToolCall, afterToolCall, sessionId, ... })`.
 *   - `agent.prompt(input)` / `agent.continue()` settle when the turn ends.
 *   - `agent.subscribe(listener)` streams `AgentEvent`s.
 *   - `beforeToolCall` returning `{ block: true, reason }` prevents execution (the security gate).
 */
import type { Agent, AgentTool } from '@mariozechner/pi-agent-core';

/** One proposed tool call in a scripted model turn. */
export interface FauxToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** One scripted model turn: emit text, or propose a tool call, or produce the final reply. */
export type FauxStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolCall: FauxToolCall }
  | { kind: 'final'; text: string };

export interface FauxAgentOptions {
  /** Ordered script replayed one step per model turn. */
  script: FauxStep[];
  /** Registered banking tools; defaults to the `./agent` tool registry (all 24 tools + submit_plan). */
  tools?: AgentTool<unknown>[];
  /** System prompt; defaults to the `./agent` banking system prompt. */
  systemPrompt?: string;
  /** Session id (use `scenario.newSessionId()` for breaker isolation per test). */
  sessionId?: string;
  /** Override the model; defaults to the faux/scripted provider. */
  registerModel?: boolean;
}

/**
 * Construct a Pi `Agent` wired with the scripted model, the banking tools and the production
 * security `beforeToolCall`. Returns a ready-to-`prompt()` agent.
 */
export function buildFauxAgent(_options: FauxAgentOptions): Agent {
  throw new Error('not implemented');
}

/* ------------------------------------------------------------------ script builders */

export const text = (value: string): FauxStep => ({ kind: 'text', text: value });
export const tool = (name: string, args: Record<string, unknown>): FauxStep => ({
  kind: 'tool',
  toolCall: { tool: name, args },
});
export const final = (value: string): FauxStep => ({ kind: 'final', text: value });

/** Convenience: a one-tool-call turn followed by a narration turn. */
export function callThen(text: string, name: string, args: Record<string, unknown>): FauxStep[] {
  return [tool(name, args), final(text)];
}

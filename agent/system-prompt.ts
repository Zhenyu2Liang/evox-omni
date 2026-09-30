/**
 * system-prompt.ts — the banking agent's system prompt builder.
 * MUST state: (a) the only capabilities are the REGISTERED tools; (b) the agent NEVER decides
 * permission — gated (🟡/🔴) tools are confirmed/verified by the human; (c) HALLUCINATION RULE:
 * report ONLY facts from a tool result, report `ok:false` as a failure, never invent balances/results,
 * never claim a gated tool executed; (d) no chain-of-thought — task steps/tool status/results only.
 */
import type { ToolName } from '@/lib/contracts/tools';

export interface SystemPromptContext {
  userId: string;
  displayName?: string;
  /** The exact tool names registered for this session (prompt lists ONLY real capabilities). */
  toolNames: ToolName[];
}
/** Reusable prompt fragment asserting the hallucination rule (tests assert it is present). */
export const HALLUCINATION_RULE: string =
  'Only report facts that came from a tool result. If a tool reports failure (ok:false), report the failure. Never invent balances or results, and never claim a gated tool already executed.';
/** Build the banking agent system prompt. PURE. */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  throw new Error('not implemented');
}

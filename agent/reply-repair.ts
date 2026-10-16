import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** A trusted query continuation preserves the original advice question across a process restart. */
export interface ReplyContext {
  purpose: 'advice' | 'query' | 'operation';
  requestText: string;
  sourceModelRequestId: string;
}

/** One corrective generation per durable run; provider retries reuse the same recorded request. */
export interface ReplyRepairState {
  version: 1;
  phase: 'requested' | 'completed' | 'fallback';
  attempt: 1;
  sourceDigest: string;
  instruction: AgentMessage;
  issues: string[];
  resultDigest?: string;
  fallbackText?: string;
}

/**
 * One bounded continuation that prods a declared-but-unemitted write, per durable run. The
 * declaration is model interpretation (`ConversationIntent`), never authorization; this budget only
 * re-asks for the missing controlled tool call and never authorizes, confirms or bypasses the
 * security gateway. The exact instruction is persisted BEFORE the provider request, so a process
 * restart reuses the same recorded request instead of spending a second one.
 */
export interface WriteContinuationState {
  version: 1;
  phase: 'requested' | 'completed';
  attempt: 1;
  sourceDigest: string;
  instruction: AgentMessage;
  /** Declared write capabilities for the turn, recorded for evidence only. */
  declaredTools: string[];
}

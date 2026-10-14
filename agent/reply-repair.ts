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

import type { Message } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export interface CompactionSummary {
  coveredMessages: number;
  prefixDigest: string;
  text: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface CompactionPending {
  id: string;
  coveredMessages: number;
  prefixDigest: string;
  inputDigest: string;
  modelIdentity: string;
  messages: Message[];
  attempt: number;
  chunks: AgentMessage[][];
  chunkIndex: number;
  maxTokens: number;
  previousSummary?: string;
  tokensBefore: number;
}

/** This cache describes a model-request projection; it never replaces archived messages. */
export interface ContextCompactionState {
  version: 1;
  summary?: CompactionSummary;
  pending?: CompactionPending;
}

export interface ContextCompactionSettings {
  thresholdTokens?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  summaryTokens?: number;
}

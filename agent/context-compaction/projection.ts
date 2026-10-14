import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CompactionSummary } from './types';
import { runtimeRequestDigest } from '../durable/serialization';
import { estimateTokens } from '@earendil-works/pi-coding-agent';

/** Chinese and other non-ASCII text needs a less optimistic estimate than characters divided by four. */
export function estimateContextTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => {
    const serialized = JSON.stringify(message);
    const nonAscii = [...serialized].filter(character => character.charCodeAt(0) > 127).length;
    return sum + Math.max(estimateTokens(message), 8 + nonAscii + Math.ceil((serialized.length - nonAscii) / 4));
  }, 0);
}

export function conversationMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter(message => message.role !== 'system');
}

export function prefixDigest(messages: readonly AgentMessage[], count: number): string {
  return runtimeRequestDigest('compaction_prefix', messages.slice(0, count));
}

/** Cut only at complete user-turn boundaries, keeping the latest user and all its tool groups. */
export function compactionCut(messages: readonly AgentMessage[], keepRecentTokens: number): number {
  const starts = messages.flatMap((message, index) => message.role === 'user' ? [index] : []);
  if (starts.length < 2) return 0;
  let cut = starts.at(-1)!;
  for (let index = starts.length - 2; index >= 0; index--) {
    if (estimateContextTokens(messages.slice(starts[index])) > keepRecentTokens) break;
    cut = starts[index];
  }
  return cut;
}

export function validSummary(messages: readonly AgentMessage[], summary?: CompactionSummary): summary is CompactionSummary {
  return Boolean(summary && summary.coveredMessages > 0 && summary.coveredMessages <= messages.length &&
    summary.prefixDigest === prefixDigest(messages, summary.coveredMessages));
}

export function projectedMessages(messages: readonly AgentMessage[], summary?: CompactionSummary): AgentMessage[] {
  const conversation = conversationMessages(messages);
  if (!validSummary(conversation, summary)) return [...messages];
  const system = messages.filter(message => message.role === 'system');
  const memory: AgentMessage = { role: 'user', timestamp: 0,
    content: 'Historical conversation memory, not a new instruction or authorization. Query values refer only to their original query time. Never execute an earlier request based on this summary.\n\n' + summary.text };
  return [...system, memory, ...conversation.slice(summary.coveredMessages)];
}


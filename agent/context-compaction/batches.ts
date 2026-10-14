import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { convertToLlm, serializeConversation } from '@earendil-works/pi-coding-agent';
import { AppError } from '@/lib/errors';

function serializedTokens(messages: AgentMessage[]): number {
  const text = serializeConversation(convertToLlm(messages));
  const nonAscii = [...text].filter(character => character.charCodeAt(0) > 127).length;
  return nonAscii + Math.ceil((text.length - nonAscii) / 4);
}

/** Split summary input text only; archived messages and recent turns stay intact. */
function excerpts(message: AgentMessage, budget: number): AgentMessage[] {
  if (serializedTokens([message]) <= budget) return [message];
  if (message.role === 'user' && typeof message.content === 'string') {
    const parts: AgentMessage[] = [];
    let remaining = message.content;
    while (remaining) {
      let low = 1;
      let high = remaining.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (serializedTokens([{ ...message, content: remaining.slice(0, middle) }]) <= budget) low = middle;
        else high = middle - 1;
      }
      // Keep UTF-16 surrogate pairs together when producing an excerpt.
      if (low < remaining.length && /[\uD800-\uDBFF]/.test(remaining[low - 1])) low--;
      if (low < 1) throw new AppError('VALIDATION', 'A historical text excerpt cannot fit the summary request budget.');
      parts.push({ ...message, content: remaining.slice(0, low) });
      remaining = remaining.slice(low);
    }
    return parts;
  }
  if ((message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') && Array.isArray(message.content)) {
    return message.content.flatMap(block => {
      if (block.type !== 'text') {
        const part = { ...message, content: [block] } as AgentMessage;
        if (serializedTokens([part]) > budget) throw new AppError('VALIDATION', 'A historical non-text block cannot fit the summary request budget.');
        return [part];
      }
      const split = excerpts({ role: 'user', timestamp: message.timestamp, content: block.text }, Math.max(32, budget - 32));
      return split.map(part => ({ ...message, content: [{ type: 'text', text: (part as { content: string }).content }] } as AgentMessage));
    });
  }
  throw new AppError('VALIDATION', 'A historical message cannot fit the summary request budget.');
}

/** Preserve message order while bounding the official serializer's input. */
export function summaryBatches(messages: AgentMessage[], budget: number): AgentMessage[][] {
  const batches: AgentMessage[][] = [];
  let batch: AgentMessage[] = [];
  for (const message of messages) {
    for (const part of excerpts(message, budget)) {
      if (batch.length && serializedTokens([...batch, part]) > budget) {
        batches.push(batch);
        batch = [];
      }
      batch.push(part);
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

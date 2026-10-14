import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ChatMessage } from '@/lib/contracts/agent';

function userText(message: AgentMessage): string | undefined {
  if (message.role !== 'user') return undefined;
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
}

/** Recover server-saved user wording, without reconstructing tool facts or banking authorization. */
export function restoreConversationUserMemory(
  messages: readonly AgentMessage[],
  transcript: readonly ChatMessage[],
): AgentMessage[] {
  const users = transcript.filter(message => message.role === 'user');
  const occurrences = new Map<string, { indices: number[]; cursor: number }>();
  users.forEach((message, index) => {
    const occurrence = occurrences.get(message.content) ?? { indices: [], cursor: 0 };
    occurrence.indices.push(index);
    occurrences.set(message.content, occurrence);
  });
  const insertions = new Map<number, AgentMessage[]>();
  const restoredUser = (message: ChatMessage): AgentMessage => ({
    role: 'user', content: message.content, timestamp: message.timestamp,
  });
  let nextUser = 0;
  messages.forEach((message, index) => {
    const text = userText(message);
    if (text === undefined) return;
    const occurrence = occurrences.get(text);
    if (occurrence) {
      while (occurrence.cursor < occurrence.indices.length && occurrence.indices[occurrence.cursor] < nextUser) {
        occurrence.cursor++;
      }
    }
    const match = occurrence?.indices[occurrence.cursor];
    if (match === undefined || !occurrence) return;
    // User boundaries keep every existing assistant/tool-result group contiguous.
    if (match > nextUser) insertions.set(index, users.slice(nextUser, match).map(restoredUser));
    occurrence.cursor++;
    nextUser = match + 1;
  });
  const restored: AgentMessage[] = [];
  messages.forEach((message, index) => {
    restored.push(...(insertions.get(index) ?? []), message);
  });
  return [...restored, ...users.slice(nextUser).map(restoredUser)];
}


import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ChatMessage } from '@/lib/contracts/agent';
import { restoreConversationUserMemory } from '@/agent/conversation-context';
import { normalizeToolResultMessages } from '@/agent/message-normalize';

function user(content: string): AgentMessage {
  return { role: 'user', content, timestamp: 1 };
}

function savedUsers(contents: string[]): ChatMessage[] {
  return contents.map((content, index) => ({ id: `saved_user_${index}`, role: 'user', content, timestamp: index + 10 }));
}

describe('server transcript user memory restoration', () => {
  it('restores a missing negative request before the next surviving user boundary', () => {
    const transcript = savedUsers(['Transfer -200 to Zhang Wei.', 'Tell me a joke.', 'What amount did I ask to transfer?']);
    const system: AgentMessage = { role: 'system', content: 'Current banking rules.', timestamp: 0 };
    const question = user('What amount did I ask to transfer?');
    const messages = [system, question];
    const next = restoreConversationUserMemory(messages, transcript);
    expect(next).toEqual([
      system,
      { role: 'user', content: 'Transfer -200 to Zhang Wei.', timestamp: 10 },
      { role: 'user', content: 'Tell me a joke.', timestamp: 11 },
      question,
    ]);
    expect(restoreConversationUserMemory(next, transcript)).toEqual(next);
  });

  it('restores multiple missing clarifications in their saved order across surviving boundaries', () => {
    const transcript = savedUsers(['Transfer to Zhang Wei.', 'Use -200.', 'I meant negative 200.', 'Explain the rules.', 'Remember the sign.']);
    const first = user('Transfer to Zhang Wei.');
    const clarification = fauxAssistantMessage('Please provide the amount.');
    const boundary = user('Explain the rules.');
    const answer = fauxAssistantMessage('Negative transfers are not supported.');
    const next = restoreConversationUserMemory([first, clarification, boundary, answer], transcript);
    expect(next).toEqual([
      first, clarification,
      { role: 'user', content: 'Use -200.', timestamp: 11 },
      { role: 'user', content: 'I meant negative 200.', timestamp: 12 },
      boundary, answer,
      { role: 'user', content: 'Remember the sign.', timestamp: 14 },
    ]);
    expect(restoreConversationUserMemory(next, transcript)).toEqual(next);
  });

  it('matches repeated wording by occurrence and never deduplicates genuine repeated user turns', () => {
    const transcript = savedUsers(['Hello.', 'Hello.', 'Tell me a joke.', 'Hello.']);
    const messages = [user('Hello.'), fauxAssistantMessage('Hello.'), user('Tell me a joke.'), user('Hello.')];
    const next = restoreConversationUserMemory(messages, transcript);
    expect(next.map(message => message.role === 'user' ? message.content : undefined).filter(Boolean))
      .toEqual(['Hello.', 'Hello.', 'Tell me a joke.', 'Hello.']);
    expect(restoreConversationUserMemory(next, transcript)).toEqual(next);
    expect(next.filter(message => message.role === 'user')).toHaveLength(4);
  });

  it('inserts before user boundaries without splitting an assistant parallel tool-result group', () => {
    const firstCall = fauxToolCall('get_balance', {});
    const secondCall = fauxToolCall('get_cards', {});
    const assistant = fauxAssistantMessage([firstCall, secondCall]);
    const results: AgentMessage[] = [firstCall, secondCall].map(call => ({
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'Recorded query result.' }], isError: false, timestamp: 3,
    }));
    const first = user('Query my accounts.');
    const boundary = user('Tell me a joke.');
    const transcript = savedUsers(['Query my accounts.', 'I wanted -200.', 'Tell me a joke.']);
    const next = restoreConversationUserMemory([first, assistant, ...results, boundary], transcript);
    expect(next).toEqual([
      first, assistant, ...results,
      { role: 'user', content: 'I wanted -200.', timestamp: 11 },
      boundary,
    ]);
    expect(normalizeToolResultMessages(next)).toEqual(next);
  });

  it('appends unmatched user history after the final tool-result group when no later user boundary survives', () => {
    const call = fauxToolCall('get_balance', {});
    const assistant = fauxAssistantMessage([call]);
    const result: AgentMessage = {
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'Recorded query result.' }], isError: false, timestamp: 3,
    };
    const messages = [user('Query my accounts.'), assistant, result];
    const next = restoreConversationUserMemory(messages, savedUsers(['Query my accounts.', 'I wanted -200.']));
    expect(next).toEqual([...messages, { role: 'user', content: 'I wanted -200.', timestamp: 11 }]);
    expect(normalizeToolResultMessages(next)).toEqual(next);
  });

  it('restores only original user text and never assistant facts, cards, tool results or authorization', () => {
    const transcript: ChatMessage[] = [
      { id: 'saved_request', role: 'user', content: '  Transfer -200.  ', timestamp: 10 },
      { id: 'saved_reply', role: 'assistant', content: 'A transfer succeeded.', timestamp: 11,
        cards: [{ type: 'error', message: 'An unrelated presentation card.' }],
        toolEvents: [{ toolCallId: 'old_call', toolName: 'transfer_money', status: 'success' }] },
    ];
    const next = restoreConversationUserMemory([], transcript);
    expect(next).toEqual([{ role: 'user', content: '  Transfer -200.  ', timestamp: 10 }]);
    expect(restoreConversationUserMemory(next, transcript)).toEqual(next);
  });

  it('does not mutate either input or replace an existing image-containing user message', () => {
    const imageUser: AgentMessage = { role: 'user', content: [
      { type: 'text', text: 'Transfer -200.' }, { type: 'image', data: 'image-data', mimeType: 'image/png' },
    ], timestamp: 1 };
    const messages = [imageUser];
    const transcript = savedUsers(['Transfer -200.', 'Explain the rules.']);
    const original = JSON.stringify({ messages, transcript });
    const next = restoreConversationUserMemory(messages, transcript);
    expect(next[0]).toBe(imageUser);
    expect(JSON.stringify({ messages, transcript })).toBe(original);
    expect(restoreConversationUserMemory(messages, [])).toEqual(messages);
  });
});

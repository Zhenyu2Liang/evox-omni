import type { Message, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';

type TextBlock = { type?: string; text?: string };

/** Project text without exposing thinking or tool-call arguments as conversation prose. */
export function contentToText(content: string | readonly TextBlock[]): string {
  if (typeof content === 'string') return content;
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('');
}

export function findLastUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return index;
  }
  return -1;
}

export function lastToolResultAfter(messages: Message[], afterIndex: number): ToolResultMessage | undefined {
  for (let index = messages.length - 1; index > afterIndex; index--) {
    const message = messages[index];
    if (message.role === 'toolResult') return message;
  }
  return undefined;
}

export function findToolCall(messages: Message[], toolCallId: string): { name: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && block.id === toolCallId) return block;
    }
  }
  return undefined;
}

export function assistantTextBefore(messages: Message[], lastUserIndex: number): string | undefined {
  for (let index = lastUserIndex - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant') return contentToText(message.content).trim();
    if (message.role === 'user') return undefined;
  }
  return undefined;
}

export function userTextBefore(messages: Message[], lastUserIndex: number): string | undefined {
  for (let index = lastUserIndex - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      return contentToText((messages[index] as UserMessage).content).trim();
    }
  }
  return undefined;
}

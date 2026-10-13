import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ToolExecutionResult } from '../tools';

export function safeToString(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAssistantMessage(message: unknown): message is AssistantMessage {
  return isRecord(message) && message.role === 'assistant';
}

export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.filter(isRecord).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}

export function textOfResult(result: unknown): string {
  return isRecord(result) ? textOfContent(Array.isArray(result.content) ? result.content.slice(0, 1) : result.content) : '';
}

export function toExecutionResult(details: unknown, summary: string): ToolExecutionResult {
  if (isRecord(details) && typeof details.ok === 'boolean') return details as unknown as ToolExecutionResult;
  return summary === '' ? { ok: true, data: details } : { ok: true, data: details, summary };
}

export function findRunFailure(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isAssistantMessage(message) && ['error', 'aborted'].includes(message.stopReason)) return message;
  }
  return null;
}

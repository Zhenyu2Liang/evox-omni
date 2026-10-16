import type { BankingAgentRuntime } from '../banking-agent';
import type { TurnBuffer } from './contracts';
import { newAssistantMessage } from './buffer';

/**
 * Remove only an unpublished conversational candidate. The original provider response stays archived
 * in the Pi journal, so withholding the candidate never rewrites history; independent tool/result rows
 * remain published.
 */
export function retireUnpublishedReply(buffer: TurnBuffer): void {
  const current = buffer.current;
  if (current?.role === 'assistant' && !current.cards?.length && !current.toolEvents?.length) {
    buffer.events = buffer.events.filter(event => !(
      (event.type === 'message_start' || event.type === 'message_end') && event.message.id === current.id
    ));
    buffer.assistants = buffer.assistants.filter(message => message.id !== current.id);
    buffer.groundedIds.delete(current.id);
    buffer.current = null;
  }
}

/** Server rendering appends memory but never emits another tool call or provider usage. */
export function publishServerReply(runtime: BankingAgentRuntime, buffer: TurnBuffer, now: () => number, content: string, retryRequest?: string): void {
  const message = { ...newAssistantMessage(now()), content, ...(retryRequest ? { retryRequest } : {}) };
  buffer.current = message;
  buffer.assistants.push(message);
  buffer.groundedIds.add(message.id);
  buffer.events.push({ type: 'message_start', message: { ...message } }, { type: 'text_delta', delta: content }, { type: 'message_end', message });
  const model = runtime.agent.state.model;
  runtime.agent.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: content }], api: model.api,
    provider: model.provider, model: model.id, timestamp: message.timestamp, stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}

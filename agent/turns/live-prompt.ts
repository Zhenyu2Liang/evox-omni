import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { BankingAgentRuntime } from '../banking-agent';
import { canRecoverPlanning, PLANNING_RECOVERY_INSTRUCTION } from '../live-recovery';
import type { TurnBuffer } from './contracts';
import { isAssistantMessage, findRunFailure, safeToString } from './message-utils';
import { newAssistantMessage } from './buffer';

export function discardTerminalReply(runtime: BankingAgentRuntime, buffer: TurnBuffer): void {
  const last = runtime.agent.state.messages.at(-1);
  if (isAssistantMessage(last) && (!last.content.some(part => part.type === 'toolCall') || ['error', 'aborted'].includes(last.stopReason))) runtime.agent.state.messages.pop();
  const current = buffer.current;
  if (current && !current.cards?.length && !current.toolEvents?.length) {
    const start = buffer.events.findIndex(event => event.type === 'message_start' && event.message.id === current.id);
    if (start >= 0) buffer.events.splice(start);
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

export async function runLivePrompt(runtime: BankingAgentRuntime, buffer: TurnBuffer, request: string, now: () => number): Promise<string | undefined> {
  let failure: string | undefined;
  let instruction: AgentMessage | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = runtime.agent.state.messages.length;
      buffer.lastGuidance = undefined;
      failure = undefined;
      try {
        if (attempt === 0) await runtime.agent.prompt(request);
        else await runtime.agent.continue();
        const failed = findRunFailure(runtime.agent.state.messages.slice(start));
        if (failed) failure = failed.errorMessage || 'Model request interrupted';
      } catch (error) { failure = safeToString(error); }
      const guidance = Boolean(buffer.serverGuidance ?? buffer.lastGuidance);
      if (attempt !== 0 || !canRecoverPlanning(request, buffer.events, buffer.factResults, guidance, failure, runtime.planningRejections)) break;
      discardTerminalReply(runtime, buffer);
      buffer.events = buffer.events.filter(event => event.type !== 'error');
      instruction = { role: 'system', content: PLANNING_RECOVERY_INSTRUCTION, timestamp: now() };
      runtime.agent.state.messages.push(instruction);
    }
  } finally { if (instruction) runtime.agent.state.messages = runtime.agent.state.messages.filter(message => message !== instruction); }
  return failure;
}

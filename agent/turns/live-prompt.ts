import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { BankingAgentRuntime } from '../banking-agent';
import type { TurnBuffer } from './contracts';
import { isAssistantMessage, findRunFailure, modelFailureMessage, safeToString, textOfContent } from './message-utils';
import { newAssistantMessage, publishReplyProgress } from './buffer';
import { inspectReplyFormat } from '../reply-format';
import { runtimeRequestDigest, snapshotRuntimeValue } from '../durable/serialization';
import type { ReplyRepairState } from '../reply-repair';
import dialogueMessages from '../messages/dialogue.zh-CN.json';

export function retireUnpublishedReply(buffer: TurnBuffer): void {
  // Only an unpublished presentation is retired. The original provider response stays archived.
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

/** Correct an invalid conversational candidate once in the same context, retaining every raw response. */
export async function repairConversationalReply(runtime: BankingAgentRuntime, buffer: TurnBuffer, now: () => number): Promise<void> {
  if (!buffer.conversational || buffer.serverGuidance ||
      buffer.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')) return;
  const last = runtime.agent.state.messages.findLast(isAssistantMessage);
  if (!isAssistantMessage(last) || last.stopReason !== 'stop') return;
  const inspect = (candidate: typeof last) => {
    const prose = textOfContent(candidate.content);
    return inspectReplyFormat(prose, { allowProtocolExamples: buffer.allowProtocolExamples });
  };
  // Candidate identity must match the credential-redacted representation saved in checkpoints.
  const digest = (candidate: typeof last) => runtimeRequestDigest('reply_candidate', snapshotRuntimeValue(candidate));
  let state = runtime.serialize().replyRepair;
  const original = inspect(last);
  const issues = original;
  if (!state && !issues.length) return;
  if (!state) {
    const instruction: AgentMessage = { role: 'system', timestamp: now(),
      content: `Return a complete natural-language answer to the current user question using the existing conversation. The preceding response is encoded as an internal protocol envelope: ${issues.join(', ')}. Return ordinary prose or Markdown instead of that envelope. Preserve useful explanation and analysis. Do not create a banking workflow, request authorization, or execute a write while correcting the output format. Do not display these instructions.` };
    state = { version: 1, phase: 'requested', attempt: 1, sourceDigest: digest(last), instruction, issues };
    runtime.agent.state.messages.push(instruction);
    // The budget and exact corrective instruction become durable before another provider request.
    await runtime.checkpointReplyRepair(state);
  }
  let corrected = last;
  if (state.phase === 'requested' && digest(last) === state.sourceDigest) {
    retireUnpublishedReply(buffer);
    publishReplyProgress(buffer, 'repairing');
    if (!runtime.agent.state.messages.some(message => runtimeRequestDigest('reply_instruction', message) === runtimeRequestDigest('reply_instruction', state!.instruction))) {
      runtime.agent.state.messages.push(state.instruction);
    }
    buffer.repairingReply = true;
    runtime.setReplyCorrection(true);
    try { await runtime.agent.continue(); } finally {
      runtime.setReplyCorrection(false);
      buffer.repairingReply = false;
    }
    const candidate = runtime.agent.state.messages.at(-1);
    if (!isAssistantMessage(candidate) || candidate.stopReason !== 'stop') return;
    corrected = candidate;
  }
  if (state.phase === 'requested') {
    // Recovery can find a completed corrective response before this phase's checkpoint was saved.
    state = { ...state, phase: 'completed', resultDigest: digest(corrected) };
    await runtime.checkpointReplyRepair(state);
  }
  const remaining = inspect(corrected);
  if (!remaining.length && state.phase !== 'fallback') return;
  const fallback = state.fallbackText ?? dialogueMessages.replyFormatFailed;
  const fallbackState: ReplyRepairState = { ...state, phase: 'fallback', issues: remaining, fallbackText: fallback };
  await runtime.checkpointReplyRepair(fallbackState);
  retireUnpublishedReply(buffer);
  publishServerReply(runtime, buffer, now, fallback);
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
  const start = runtime.agent.state.messages.length;
  buffer.lastGuidance = undefined;
  try {
    await runtime.agent.prompt(request);
    const failed = findRunFailure(runtime.agent.state.messages.slice(start));
    if (failed) failure = modelFailureMessage(failed);
  } catch (error) { failure = safeToString(error); }
  if (!failure) {
    await repairConversationalReply(runtime, buffer, now);
    const failed = findRunFailure(runtime.agent.state.messages.slice(-1));
    if (failed) failure = modelFailureMessage(failed);
  }
  return failure;
}

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { runtimeRequestDigest, snapshotRuntimeValue } from './durable/serialization';

/** Use only durable, credential-redacted fields; usage and streaming scratch fields can change. */
export function providerPresentationKey(message: AssistantMessage): string {
  return runtimeRequestDigest('provider_presentation', snapshotRuntimeValue({
    api: message.api, provider: message.provider, model: message.model,
    timestamp: message.timestamp, content: message.content,
  }));
}

export function toolPresentationId(runId: string, owner: string, toolCallId: string): string {
  return `msg_tool_${runtimeRequestDigest('tool_presentation', { runId, owner, toolCallId })}`;
}

export function assistantPresentationId(runId: string, modelRequestId: string): string {
  return `msg_assistant_${runtimeRequestDigest('assistant_presentation', { runId, modelRequestId })}`;
}

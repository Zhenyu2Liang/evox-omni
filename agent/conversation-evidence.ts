import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { FactInput } from './grounding-facts';
import { normalizeToolResultMessages } from './message-normalize';
import { isRecord } from './turns/message-utils';
import type { ToolExecutionResult } from './tools';
import { catalogEntry } from '@/lib/contracts/tool-catalog';

/** Earlier results support dated discussion; write failures can invalidate a known balance. */
export function collectConversationEvidence(messages: readonly AgentMessage[]): FactInput[] {
  return normalizeToolResultMessages(messages).flatMap(message => {
    if (message.role !== 'toolResult' || message.details === undefined ||
        !catalogEntry(message.toolName) || catalogEntry(message.toolName)?.effect === 'workflow') return [];
    const result = isRecord(message.details) && typeof message.details.ok === 'boolean'
      ? message.details as unknown as ToolExecutionResult : { ok: !message.isError, data: message.details };
    if ((message.isError || !result.ok) && catalogEntry(message.toolName)?.effect !== 'write') return [];
    return [{ toolName: message.toolName, toolCallId: message.toolCallId,
      result }];
  });
}

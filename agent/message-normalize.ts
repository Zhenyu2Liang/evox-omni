/**
 * message-normalize.ts — keep the pi transcript valid for OpenAI-compatible providers.
 *
 * DeepSeek (and the OpenAI chat API generally) reject a transcript in which a `tool` message is not
 * the DIRECT response to the immediately-preceding assistant message carrying the matching
 * `tool_call`:
 *   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'".
 * pi models that relation with `role:'toolResult'` (its `convertToLlm` maps it to the wire role
 * `tool`), so pi's message array must obey the same adjacency rule.
 *
 * Two chokepoints use this module:
 *  - construction/restoration (`banking-agent.ts`): `normalizeToolResultMessages` prunes any
 *    `toolResult` that is not immediately preceded by a matching assistant `toolCall`, so a persisted
 *    transcript (including one written by an older build) can never replay an orphan or a duplicated
 *    result — the exact shape that produces the 400 above.
 *  - the confirmation continuation (`run-turn.ts#resumeTurn`): `withRealToolResult` attributes the
 *    REAL outcome to the ORIGINAL tool call, REPLACING the turn-time (blocked) placeholder in place
 *    while retaining later dialogue — never appending a second result for the same `toolCallId`
 *    (which would land after the narration message and violate the adjacency rule).
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { runtimeRequestDigest } from './durable/serialization';
import { AppError } from '@/lib/errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An assistant message (carries text and/or `toolCall` parts). */
export function isAssistantMessage(message: unknown): message is AssistantMessage {
  return isRecord(message) && message.role === 'assistant';
}

/** A tool-result message (pi's `role:'toolResult'`; the OpenAI/DeepSeek wire role `tool`). */
export function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return isRecord(message) && message.role === 'toolResult';
}

/** The `toolCall` parts an assistant message declares. */
function toolCallsOf(message: AgentMessage): ToolCall[] {
  if (!isAssistantMessage(message)) return [];
  const calls: ToolCall[] = [];
  for (const part of message.content) {
    if (part.type === 'toolCall') calls.push(part);
  }
  return calls;
}

/** Provider IDs may repeat across turns, but one response must identify every call unambiguously. */
export function validateToolCallIdentities(message: AssistantMessage): void {
  const identities = new Set<string>();
  for (const call of toolCallsOf(message)) {
    if (typeof call.id !== 'string' || call.id.trim().length === 0 || identities.has(call.id)) {
      throw new AppError('VALIDATION', 'Every tool call in one response must have a unique nonempty call ID.');
    }
    identities.add(call.id);
  }
}

/** Does this assistant message declare a `toolCall` with `id`? */
function hasToolCall(message: AgentMessage, id: string, name: string): boolean {
  return toolCallsOf(message).some((call) => call.id === id && call.name === name);
}

/** Provider IDs can repeat; a saved model response identifies the assistant that owns the call. */
export function findToolCallOwner(messages: readonly AgentMessage[], id: string, name: string,
  expectedOwner?: AssistantMessage | null): number {
  if (expectedOwner === null) return -1;
  const identity = (message: AssistantMessage) => runtimeRequestDigest('provider_assistant', {
    timestamp: message.timestamp, api: message.api, provider: message.provider, model: message.model,
    responseId: message.responseId ?? null, content: message.content,
  });
  const expected = expectedOwner ? identity(expectedOwner) : undefined;
  let found = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isAssistantMessage(message) || !hasToolCall(message, id, name)) continue;
    if (expected === undefined) return index;
    if (identity(message) !== expected) continue;
    if (found !== -1) return -1;
    found = index;
  }
  return found;
}

/**
 * Drop every `toolResult` that is not a response to the assistant message that owns the current
 * contiguous result run; message order is otherwise preserved. The run is (re)opened by an assistant
 * message that declares `toolCall` parts and stays open across the consecutive `toolResult` messages
 * that answer it (a parallel batch), so every result whose id is declared by that assistant survives
 * while an orphan (no declaring assistant), a result after a non-`toolCall` assistant message, and a
 * duplicated result for the same call are all dropped. A transcript that ever gained an extra,
 * orphaned result (e.g. written by an older build) is therefore healed on load.
 */
export function normalizeToolResultMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  let openCalls: Map<string, string> | null = null; // ids and names of the owning assistant calls
  let seen: Set<string> = new Set(); // ids already answered inside the current run
  for (const message of messages) {
    if (isToolResultMessage(message)) {
      const valid = openCalls !== null && openCalls.get(message.toolCallId) === message.toolName && !seen.has(message.toolCallId);
      if (valid) {
        out.push(message);
        seen.add(message.toolCallId); // orphan / duplicate ⇒ dropped
      }
      continue;
    }
    out.push(message);
    const declared = toolCallsOf(message);
    openCalls = declared.length > 0 ? new Map(declared.map(call => [call.id, call.name])) : null;
    seen = new Set();
  }
  return out;
}

/**
 * Replace the original outcome in place without rewinding the conversation:
 *  - find the assistant message declaring that `toolCall`, then REPLACE the (blocked) turn-time result
 *    inside that assistant message's contiguous result group and retain everything after the group;
 *  - when no such call exists, keep the valid history without inventing an orphan result.
 * Sibling results of the same assistant turn (a parallel tool-call batch) are preserved.
 */
export function withRealToolResult(
  messages: readonly AgentMessage[],
  result: ToolResultMessage,
  owner?: AssistantMessage | null,
): AgentMessage[] {
  const base = normalizeToolResultMessages(messages);
  const callIndex = findToolCallOwner(base, result.toolCallId, result.toolName, owner);
  if (callIndex < 0) return base;

  // The contiguous run of tool results answering that assistant message.
  const group: ToolResultMessage[] = [];
  let groupEnd = callIndex + 1;
  for (; groupEnd < base.length; groupEnd += 1) {
    const message: AgentMessage | undefined = base[groupEnd];
    if (message === undefined || !isToolResultMessage(message)) break;
    group.push(message);
  }

  const at = group.findIndex((message) => message.toolCallId === result.toolCallId);
  if (at >= 0) group[at] = result;
  else group.push(result);

  return [...base.slice(0, callIndex + 1), ...group, ...base.slice(groupEnd)];
}

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
 *    and dropping the trailing narration — never appending a second result for the same `toolCallId`
 *    (which would land after the narration message and violate the adjacency rule).
 */
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An assistant message (carries text and/or `toolCall` parts). */
export function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
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

/** Does this assistant message declare a `toolCall` with `id`? */
function hasToolCall(message: AgentMessage, id: string): boolean {
  return toolCallsOf(message).some((call) => call.id === id);
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
  let openCalls: Set<string> | null = null; // ids of the assistant message owning the current run
  let seen: Set<string> = new Set(); // ids already answered inside the current run
  for (const message of messages) {
    if (isToolResultMessage(message)) {
      const valid = openCalls !== null && openCalls.has(message.toolCallId) && !seen.has(message.toolCallId);
      if (valid) {
        out.push(message);
        seen.add(message.toolCallId); // orphan / duplicate ⇒ dropped
      }
      continue;
    }
    out.push(message);
    const declared = toolCallsOf(message).map((call) => call.id);
    openCalls = declared.length > 0 ? new Set(declared) : null;
    seen = new Set();
  }
  return out;
}

/**
 * Place the REAL tool result for `result.toolCallId` in the transcript so that `agent.continue()`
 * (which requires the last message to be a user/tool-result message) can narrate it:
 *  - find the assistant message declaring that `toolCall`, then REPLACE the (blocked) turn-time result
 *    inside that assistant message's contiguous result group and drop everything after the group (the
 *    turn-time narration) — so no second result for the same id is appended, no orphan is created, and
 *    the result becomes the LAST message;
 *  - when no such call exists (a degenerate/empty transcript that never occurs on the live gated
 *    path) simply append it.
 * Sibling results of the same assistant turn (a parallel tool-call batch) are preserved.
 */
export function withRealToolResult(
  messages: readonly AgentMessage[],
  result: ToolResultMessage,
): AgentMessage[] {
  const base = normalizeToolResultMessages(messages);
  const callIndex = base.findIndex((message) => hasToolCall(message, result.toolCallId));
  if (callIndex < 0) return [...base, result];

  // The contiguous run of tool results answering that assistant message.
  const group: ToolResultMessage[] = [];
  for (let i = callIndex + 1; i < base.length; i += 1) {
    const message: AgentMessage | undefined = base[i];
    if (message === undefined || !isToolResultMessage(message)) break;
    group.push(message);
  }

  const at = group.findIndex((message) => message.toolCallId === result.toolCallId);
  if (at >= 0) group[at] = result;
  else group.push(result);

  return [...base.slice(0, callIndex + 1), ...group];
}

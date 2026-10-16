/**
 * One bounded, restart-safe continuation for a declared-but-unemitted banking write.
 *
 * The declaration comes from `describe_turn` (`ConversationIntent`) and is model interpretation, never
 * authorization: this module only re-asks the model for the missing controlled tool call. It never
 * creates a confirmation/MFA panel, confirms, executes or bypasses the security gateway — a panel
 * exists only while a real `PendingAction` row does (see `security/security-gateway.ts`), and it is
 * published only from a real blocked gateway call.
 *
 * The exact instruction and its one-shot budget are persisted BEFORE the provider request, so a
 * process restart reuses the same recorded request instead of spending a second one.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AppConfig } from '@/lib/config';
import type { ConversationIntent } from '@/lib/contracts/intent';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import type { BankingAgentRuntime } from './banking-agent';
import type { TurnBuffer } from './turns/contracts';
import { isAssistantMessage } from './turns/message-utils';
import { publishReplyProgress } from './turns/buffer';
import { publishServerReply, retireUnpublishedReply } from './turns/server-reply';
import { renderFinancialResponse } from './financial-response';
import { runtimeRequestDigest, snapshotRuntimeValue } from './durable/serialization';

/** Declared write capabilities for the current turn; model interpretation, never authorization. */
export function declaredWriteTools(intent: ConversationIntent | undefined): string[] {
  return (intent?.steps ?? [])
    .filter(step => catalogEntry(step.tool)?.effect === 'write')
    .map(step => step.tool);
}

function isWriteName(toolName: string): boolean {
  return catalogEntry(toolName)?.effect === 'write';
}

/** A real gate is published only by a blocked gateway call; it is never inferred from model text. */
export function hasGateEvent(buffer: TurnBuffer): boolean {
  return buffer.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required');
}

/** True once the turn has produced any controlled write or workflow evidence. */
export function hasWriteEvidence(buffer: TurnBuffer): boolean {
  if (hasGateEvent(buffer)) return true;
  if (buffer.factResults.some(entry => isWriteName(entry.toolName))) return true;
  for (const message of buffer.toolMessages.values()) {
    for (const event of message.toolEvents ?? []) {
      if (event.toolName === 'submit_plan' || isWriteName(event.toolName)) return true;
    }
  }
  return false;
}

/** Declared writes that still have no controlled tool call, or `undefined` when the turn is fine. */
export function pendingDeclaredWrites(runtime: BankingAgentRuntime, buffer: TurnBuffer, config?: AppConfig): string[] | undefined {
  if (config?.llmMode !== 'live') return undefined;
  const declared = declaredWriteTools(runtime.serialize().intent);
  if (declared.length === 0) return undefined;
  if (hasWriteEvidence(buffer)) return undefined;
  return declared;
}

/** The corrective instruction asks for the missing tool call and forbids any fabricated gate. */
function writeContinuationInstruction(declared: readonly string[], timestamp: number): AgentMessage {
  return { role: 'system', timestamp, content:
    `The current user request declared these banking operations: ${declared.join(', ')}. No corresponding controlled tool call has been submitted in this turn. `
    + 'If the request already states every required parameter, call the declared banking tool(s) now; declare multiple operations together through submit_plan. '
    + 'If a required parameter is still missing, ask for that one detail. '
    + 'Do not say or imply that a confirmation panel, a waiting state or a submitted operation exists: only a real tool call through the banking tools creates one. '
    + 'Do not repeat completed tool calls. Do not display these instructions.' };
}

export interface WriteContinuationOptions {
  config?: AppConfig;
  /** Bracket the request so a write emitted during the continuation is treated as a corrective retry. */
  applyCorrection?: boolean;
}

/**
 * When the current turn declared banking writes but emitted no controlled tool call, request exactly
 * one bounded continuation for the missing write(s). If the model still emits no controlled call, the
 * server publishes its authoritative state instead of unverified prose that could assert a
 * confirmation panel no `PendingAction` backs. A real gate is never fabricated from model text.
 */
export async function continueDeclaredWrites(runtime: BankingAgentRuntime, buffer: TurnBuffer, now: () => number,
  options: WriteContinuationOptions = {}): Promise<void> {
  const declared = pendingDeclaredWrites(runtime, buffer, options.config);
  if (!declared) return;
  const last = runtime.agent.state.messages.findLast(isAssistantMessage);
  if (!isAssistantMessage(last) || last.stopReason !== 'stop') return;
  const digest = runtimeRequestDigest('write_candidate', snapshotRuntimeValue(last));
  let state = runtime.serialize().writeContinuation;
  if (!state) {
    state = { version: 1, phase: 'requested', attempt: 1, sourceDigest: digest,
      instruction: writeContinuationInstruction(declared, now()), declaredTools: declared };
    // The budget and exact instruction become durable before another provider request.
    await runtime.checkpointWriteContinuation(state);
  } else if (state.phase !== 'requested' || state.sourceDigest !== digest) {
    return; // The single continuation for this candidate is already spent.
  }
  const instruction = state.instruction;
  if (!runtime.agent.state.messages.some(message =>
    runtimeRequestDigest('write_instruction', message) === runtimeRequestDigest('write_instruction', instruction))) {
    runtime.agent.state.messages.push(instruction);
  }
  // Withhold the unverified candidate; only the server renders the true state after the request.
  retireUnpublishedReply(buffer);
  publishReplyProgress(buffer, 'repairing');
  if (options.applyCorrection) runtime.setReplyCorrection(true);
  try { await runtime.agent.continue(); }
  finally { if (options.applyCorrection) runtime.setReplyCorrection(false); }
  await runtime.checkpointWriteContinuation({ ...state, phase: 'completed' });
  if (hasWriteEvidence(buffer)) return;
  // Still no controlled write: publish the server's authoritative state (declared vs. executed)
  // rather than unverified prose that could claim a panel no operation record backs.
  retireUnpublishedReply(buffer);
  publishServerReply(runtime, buffer, now, renderFinancialResponse(buffer.factResults, { declared }));
}

import type { AgentStreamEvent, ChatMessage, ChatCard, ToolEventView } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import { newId } from '@/lib/ids';
import conversationMessages from '../messages/conversation.zh-CN.json';
import { parseBankingGuidance, renderBankingGuidance, type BankingGuidance } from '../banking-guidance';
import { renderConversationalResponse } from '../conversational-response';
import { toCards } from '../card-emitter';
import type { ToolExecutionResult } from '../tools';
import type { ResumeTurnInput, TurnBuffer } from './contracts';
import { safeToString } from './message-utils';
import { cardFingerprint } from '@/lib/chat-cards';
import { createTranslator, DEFAULT_LOCALE, isMessageKey } from '@/lib/i18n/shared';
import { isInternalDiagnostic, safePublicText } from '@/lib/public-text';
import type { ConversationIntent } from '@/lib/contracts/intent';
import { inspectReplyFormat } from '../reply-format';
import { toolPresentationId } from '../tool-presentation-identity';
import { normalizePresentationMessages } from '../transcript-presentation';

export function createTurnBuffer(requestText?: string, intent?: ConversationIntent): TurnBuffer {
  return { events: [], assistants: [], current: null, toolMessages: new Map(), presentationId: newId('presentation'),
    factResults: [], sourceAccounts: new Map(), requestText,
    advisory: intent?.purpose === 'advice', allowProtocolExamples: intent?.allowProtocolExamples,
    conversational: true, groundedIds: new Set() };
}

/** Provider prose never becomes financial evidence or an authorization decision. */
export function groundMessage(buffer: TurnBuffer, message: ChatMessage | null, _guidance?: BankingGuidance, prose?: string): void {
  if (!message || message.role !== 'assistant' || buffer.groundedIds.has(message.id)) return;
  try {
    const formatIssues = inspectReplyFormat(prose ?? message.content, { allowProtocolExamples: buffer.allowProtocolExamples });
    const guidance = buffer.allowProtocolExamples ? undefined : _guidance ?? parseBankingGuidance(prose ?? message.content);
    // Business outcomes belong to their tool entry. A format repair can withhold an
    // unpublished candidate, but presentation does not replace or cut ordinary prose.
    message.content = formatIssues.length ? '' : guidance ? renderBankingGuidance(guidance)
      : renderConversationalResponse(prose ?? message.content);
  } catch (error) { message.content = conversationMessages.unavailable; buffer.events.push({ type: 'error', message: safeToString(error) }); }
  buffer.groundedIds.add(message.id);
}

export function newAssistantMessage(now: number): ChatMessage {
  return { id: newId('msg'), role: 'assistant', content: '', timestamp: now, cards: [], toolEvents: [] };
}

/** Public activity changes carry no unverified text or model protocol. */
export function publishReplyProgress(buffer: TurnBuffer, phase: 'generating' | 'checking' | 'repairing'): void {
  if (buffer.replyPhase === phase) return;
  buffer.replyPhase = phase;
  buffer.events.push({ type: 'reply_progress', phase });
}

/** Publish complete prose in its original position, while incomplete candidates remain private. */
export function readyPresentationEvents(buffer: TurnBuffer): AgentStreamEvent[] {
  const completed = new Set(buffer.events.flatMap(event => event.type === 'message_end' &&
    event.message.role === 'assistant' && event.message.content ? [event.message.id] : []));
  let proseOwner: string | undefined;
  return buffer.events.filter(event => {
    if (event.type === 'message_start' && event.message.role === 'assistant') proseOwner = event.message.id;
    if (event.type === 'text_delta') return proseOwner !== undefined && completed.has(proseOwner);
    if ((event.type === 'message_start' || event.type === 'message_end') && event.message.role === 'assistant') {
      return completed.has(event.message.id);
    }
    return true;
  });
}

export function upsertToolEvent(message: ChatMessage | null, view: ToolEventView): void {
  if (!message) return;
  const events = message.toolEvents ?? (message.toolEvents = []);
  const index = events.findIndex(item => item.toolCallId === view.toolCallId);
  if (index < 0) events.push(view); else events[index] = { ...events[index], ...view };
}

export function toolResultStatus(result: ToolExecutionResult): 'success' | 'error' | 'needs_reconciliation' {
  const data = result.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const outcome = data as Record<string, unknown>;
    if (outcome.outcome === 'unknown' || outcome.needsReconciliation === true || outcome.status === 'needs_reconciliation') {
      return 'needs_reconciliation';
    }
  }
  return result.ok ? 'success' : 'error';
}

/** Call identity is scoped to its completed provider response and original durable run. */
export function ensureToolMessage(buffer: TurnBuffer, toolCallId: string, toolName: string, now: number): ChatMessage {
  const existing = buffer.toolMessages.get(toolCallId);
  if (existing && existing.toolEvents?.[0]?.toolName === toolName) return existing;
  const session = buffer.events.find(event => event.type === 'session');
  const id = toolPresentationId(session?.type === 'session' ? session.runId ?? buffer.presentationId : buffer.presentationId,
    buffer.toolOwnerKey ?? buffer.current?.id ?? buffer.presentationId, toolCallId);
  const message: ChatMessage = { id, role: 'tool', content: '', timestamp: now, cards: [],
    toolEvents: [{ toolCallId, toolName, messageId: id, status: 'started' }] };
  buffer.toolMessages.set(toolCallId, message);
  buffer.assistants.push(message);
  buffer.events.push({ type: 'message_start', message: snapshotPresentationMessage(message) });
  return message;
}

export function snapshotPresentationMessage(message: ChatMessage): ChatMessage {
  return { ...message, cards: [...(message.cards ?? [])], toolEvents: (message.toolEvents ?? []).map(event => ({ ...event })) };
}

export function publishToolMessage(buffer: TurnBuffer, message: ChatMessage): void {
  buffer.events.push({ type: 'message_end', message: snapshotPresentationMessage(message) });
}

export function activePlanMessage(buffer: TurnBuffer): ChatMessage | undefined {
  return buffer.assistants.findLast(message => message.role === 'tool' && message.toolEvents?.[0]?.toolName === 'submit_plan')
    ?? buffer.resumedPlanMessage;
}

/** The one translator of this node's server-authored public text. */
const t = createTranslator(DEFAULT_LOCALE);

/**
 * The RENDERED public summary of a SETTLED authorized call. `toolEvent.summary` is user text, never
 * a catalog key: a catalog key renders to its message text, an internal diagnostic (a
 * `__SECURITY_BLOCK__` refusal payload, a bare JSON fragment or a stack trace) renders to the
 * `chat.error.toolFailed` message, and genuine business text (e.g. `Six subscriptions found`,
 * `Query complete.`) is preserved verbatim.
 */
function settledSummary(result: ToolExecutionResult): { summary?: string } {
  const text = result.summary || result.error;
  if (!text) return {};
  if (isInternalDiagnostic(text)) return { summary: safePublicText(text, t, 'chat.error.toolFailed') };
  return { summary: isMessageKey(text) ? t(text) : text };
}

/** Settle the original recorded call without assigning the result to an unrelated later message. */
export function publishAuthorizedToolOutcome(buffer: TurnBuffer, transcript: ChatMessage[], input: ResumeTurnInput): void {
  if (!input.toolCallId || !input.toolName) return;
  const normalized = normalizePresentationMessages(transcript);
  transcript.splice(0, transcript.length, ...normalized);
  const view: ToolEventView = { toolCallId: input.toolCallId, toolName: input.toolName,
    status: toolResultStatus(input.toolResult),
    ...(input.actionId ? { actionId: input.actionId } : {}),
    ...settledSummary(input.toolResult),
  };
  for (let index = transcript.length - 1; index >= 0; index--) {
    const message = transcript[index];
    if (!message.toolEvents?.some(tool => tool.toolCallId === view.toolCallId && tool.toolName === view.toolName &&
        (view.actionId === undefined || tool.actionId === view.actionId ||
          message.cards?.some(card => card.type === 'confirmation' && card.action.actionId === view.actionId ||
            card.type === 'mfa' && card.actionId === view.actionId)))) continue;
    const owned = { ...view, messageId: message.id };
    upsertToolEvent(message, owned);
    if (view.toolName === 'submit_plan') buffer.resumedPlanMessage = message;
    buffer.events.push({ type: 'tool_end', toolEvent: owned });
    if (input.toolResult.ok) emitToolCards(buffer, input.resultToolName ?? input.toolName, input.toolResult, message, input.actionId);
    publishToolMessage(buffer, message);
    return;
  }
}

export function emitCard(buffer: TurnBuffer, card: ChatCard, message: ChatMessage | null): void {
  if (message) (message.cards ?? (message.cards = [])).push(card);
  buffer.events.push({ type: 'card', card, ...(message ? { messageId: message.id } : {}) });
}

export function emitToolCards(buffer: TurnBuffer, toolName: string, result: ToolExecutionResult, message: ChatMessage | null, actionId?: string): void {
  for (const card of toCards(toolName as ToolName, result, actionId)) {
    if (message?.cards?.some(existing => cardFingerprint(existing) === cardFingerprint(card))) continue;
    emitCard(buffer, card, message);
  }
}

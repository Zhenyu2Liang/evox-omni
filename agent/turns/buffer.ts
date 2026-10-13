import type { ChatMessage, ChatCard, ToolEventView } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import { newId } from '@/lib/ids';
import { renderFinancialResponse, UNAVAILABLE_RESPONSE } from '../financial-response';
import { filterMissingFields, type BankingGuidance } from '../banking-guidance';
import { toCards } from '../card-emitter';
import type { ToolExecutionResult } from '../tools';
import type { TurnBuffer } from './contracts';
import { safeToString } from './message-utils';

export function createTurnBuffer(requestText?: string): TurnBuffer {
  return { events: [], assistants: [], current: null, factResults: [], sourceAccounts: new Map(), requestText, groundedIds: new Set() };
}

/** Provider prose never becomes financial evidence or an authorization decision. */
export function groundMessage(buffer: TurnBuffer, message: ChatMessage | null, guidance?: BankingGuidance): void {
  if (!message || buffer.groundedIds.has(message.id)) return;
  try {
    const pending = [...buffer.events].reverse().find(event => event.type === 'mfa_required' || event.type === 'confirmation_required');
    message.content = renderFinancialResponse(buffer.factResults, { requestText: buffer.requestText,
      guidance: buffer.serverGuidance ?? filterMissingFields(guidance, buffer.providedFields ?? []),
      locked: buffer.events.some(event => event.type === 'security_event' && event.kind === 'locked'),
      ...(pending?.type === 'mfa_required' ? { pending: 'mfa' as const } : pending?.type === 'confirmation_required' ? { pending: 'confirmation' as const } : {}) });
  } catch (error) { message.content = UNAVAILABLE_RESPONSE; buffer.events.push({ type: 'error', message: safeToString(error) }); }
  buffer.groundedIds.add(message.id);
}

export function newAssistantMessage(now: number): ChatMessage {
  return { id: newId('msg'), role: 'assistant', content: '', timestamp: now, cards: [], toolEvents: [] };
}

export function upsertToolEvent(message: ChatMessage | null, view: ToolEventView): void {
  if (!message) return;
  const events = message.toolEvents ?? (message.toolEvents = []);
  const index = events.findIndex(item => item.toolCallId === view.toolCallId);
  if (index < 0) events.push(view); else events[index] = view;
}

export function emitCard(buffer: TurnBuffer, card: ChatCard): void {
  if (buffer.current) (buffer.current.cards ?? (buffer.current.cards = [])).push(card);
  buffer.events.push({ type: 'card', card });
}

export function emitToolCards(buffer: TurnBuffer, toolName: string, result: ToolExecutionResult): void {
  for (const card of toCards(toolName as ToolName, result)) emitCard(buffer, card);
}

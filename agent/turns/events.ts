import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { ToolEventView } from '@/lib/contracts/agent';
import { security } from '@/security';
import { confirmationCard, errorCard, mfaCard } from '../card-emitter';
import { filterMissingFields, parseBankingGuidance } from '../banking-guidance';
import type { TurnBuffer } from './contracts';
import { emitCard, emitToolCards, groundMessage, newAssistantMessage, upsertToolEvent } from './buffer';
import { findRunFailure, isAssistantMessage, isRecord, safeToString, textOfContent, textOfResult, toExecutionResult } from './message-utils';
import { loadPendingSummary, MFA_HINT } from './authorization-view';

async function handleToolEnd(buffer: TurnBuffer, event: Extract<AgentEvent, { type: 'tool_execution_end' }>, rejected: ReadonlyMap<string, string>): Promise<void> {
  const { toolCallId, toolName } = event;
  if (rejected.has(toolCallId)) {
    const view: ToolEventView = { toolCallId, toolName, status: 'blocked', summary: 'Full plan validation failed. Supply the objects and amounts for every step.' };
    upsertToolEvent(buffer.current, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    return;
  }
  if (!event.isError) {
    const summary = textOfResult(event.result);
    const result = toExecutionResult(isRecord(event.result) ? event.result.details : undefined, summary);
    const view: ToolEventView = { toolCallId, toolName, status: 'success', ...(summary !== '' ? { summary } : {}) };
    upsertToolEvent(buffer.current, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    buffer.factResults.push({ toolName, result, toolCallId, sourceAccountId: buffer.sourceAccounts.get(toolCallId) });
    emitToolCards(buffer, toolName, result);
    return;
  }
  const message = textOfResult(event.result) || 'Tool execution failed';
  const parsed = security.gateway.securityGateway.parseBlockReason(message);
  const blocked = parsed !== null || message.startsWith(security.gateway.BLOCK_REASON_PREFIX);
  if (!blocked) {
    const view: ToolEventView = { toolCallId, toolName, status: 'error', summary: message };
    upsertToolEvent(buffer.current, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    buffer.factResults.push({ toolName, result: { ok: false, error: message }, toolCallId, sourceAccountId: buffer.sourceAccounts.get(toolCallId) });
    emitCard(buffer, errorCard(message));
    return;
  }
  const view: ToolEventView = { toolCallId, toolName, status: 'blocked' };
  upsertToolEvent(buffer.current, view);
  buffer.events.push({ type: 'tool_end', toolEvent: view });
  if (parsed?.decisionKind === 'require_mfa') {
    const summary = await loadPendingSummary(parsed.actionId, toolName);
    buffer.events.push({ type: 'mfa_required', actionId: parsed.actionId, hint: MFA_HINT, action: summary });
    emitCard(buffer, mfaCard(parsed.actionId, MFA_HINT, summary));
    return;
  }
  if (parsed?.decisionKind === 'require_confirmation') {
    const summary = await loadPendingSummary(parsed.actionId, toolName);
    buffer.events.push({ type: 'confirmation_required', actionId: parsed.actionId, action: summary });
    emitCard(buffer, confirmationCard(summary));
    return;
  }
  buffer.events.push({ type: 'security_event', kind: 'locked', message });
}

/** Map normal and recovered Pi events through the same grounded presentation adapter. */
export function createEventHandler(buffer: TurnBuffer, now: () => number, rejected: ReadonlyMap<string, string> = new Map()): (event: AgentEvent) => Promise<void> {
  return async event => {
    try {
      switch (event.type) {
        case 'message_start': {
          if (!isAssistantMessage(event.message)) return;
          const assistant = newAssistantMessage(now());
          buffer.current = assistant;
          buffer.assistants.push(assistant);
          buffer.events.push({ type: 'message_start', message: { ...assistant } });
          return;
        }
        case 'message_update': return;
        case 'message_end': {
          if (!isAssistantMessage(event.message)) return;
          const assistant = buffer.current ?? newAssistantMessage(now());
          buffer.lastGuidance = event.message.stopReason === 'stop'
            ? filterMissingFields(parseBankingGuidance(textOfContent(event.message.content)), buffer.providedFields ?? []) : undefined;
          if (event.message.content.some(part => part.type === 'toolCall')) {
            assistant.content = '';
            buffer.groundedIds.add(assistant.id);
          } else {
            groundMessage(buffer, assistant, event.message.stopReason === 'stop' ? parseBankingGuidance(textOfContent(event.message.content)) : undefined);
          }
          event.message.content = [...event.message.content.filter(part => part.type !== 'text'), ...(assistant.content ? [{ type: 'text' as const, text: assistant.content }] : [])];
          if (assistant.content !== '') buffer.events.push({ type: 'text_delta', delta: assistant.content });
          buffer.events.push({ type: 'message_end', message: assistant });
          return;
        }
        case 'tool_execution_start': {
          if (isRecord(event.args) && typeof event.args.sourceAccountId === 'string') buffer.sourceAccounts.set(event.toolCallId, event.args.sourceAccountId);
          const view: ToolEventView = { toolCallId: event.toolCallId, toolName: event.toolName, status: 'started' };
          upsertToolEvent(buffer.current, view);
          buffer.events.push({ type: 'tool_start', toolEvent: view });
          return;
        }
        case 'tool_execution_update': {
          const view: ToolEventView = { toolCallId: event.toolCallId, toolName: event.toolName, status: 'updated' };
          upsertToolEvent(buffer.current, view);
          buffer.events.push({ type: 'tool_end', toolEvent: view });
          return;
        }
        case 'tool_execution_end':
          await handleToolEnd(buffer, event, rejected);
          return;
        case 'agent_end': {
          const failure = findRunFailure(event.messages);
          if (failure?.errorMessage) buffer.events.push({ type: 'error', message: failure.errorMessage });
          return;
        }
        default: return;
      }
    } catch (error) { buffer.events.push({ type: 'error', message: safeToString(error) }); }
  };
}

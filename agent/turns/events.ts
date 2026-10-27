import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { ToolEventView } from '@/lib/contracts/agent';
import type { SecurityFailure } from '@/lib/contracts/security';
import { security } from '@/security';
import { errorCard } from '../card-emitter';
import { parseBankingGuidance } from '../banking-guidance';
import type { TurnBuffer } from './contracts';
import { emitCard, emitToolCards, groundMessage, newAssistantMessage, upsertToolEvent, publishReplyProgress,
  ensureToolMessage, publishToolMessage, toolResultStatus } from './buffer';
import { findRunFailure, isAssistantMessage, isRecord, safeToString, textOfContent, textOfResult, toExecutionResult } from './message-utils';
import { publishPendingDecision } from './authorization-view';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';
import { projectToolRejection } from '@/lib/tool-feedback';
import { inspectReplyFormat } from '../reply-format';
import { assistantPresentationId, providerPresentationKey } from '../tool-presentation-identity';
import { parseModelToolError } from '../tools/result';

/** The TYPED facts a refusal carries, projected into the catalog placeholders that render them. */
function errorParamsFrom(failure: SecurityFailure | undefined): { errorParams?: Record<string, string | number> } {
  if (!failure) return {};
  const params: Record<string, string | number> = {};
  if (typeof failure.attemptsLeft === 'number') params.attemptsLeft = failure.attemptsLeft;
  if (typeof failure.attemptsUsed === 'number') params.attemptsUsed = failure.attemptsUsed;
  if (typeof failure.maxAttempts === 'number') params.maxAttempts = failure.maxAttempts;
  return Object.keys(params).length > 0 ? { errorParams: params } : {};
}

async function handleToolEnd(buffer: TurnBuffer, event: Extract<AgentEvent, { type: 'tool_execution_end' }>, rejected: ReadonlyMap<string, string>, now: number): Promise<void> {
  const { toolCallId, toolName } = event;
  const toolMessage = ensureToolMessage(buffer, toolCallId, toolName, now);
  const owner = { messageId: toolMessage.id };
  if (rejected.has(toolCallId)) {
    const view: ToolEventView = { toolCallId, toolName, ...owner, status: 'blocked', ...projectToolRejection(rejected.get(toolCallId)!) };
    upsertToolEvent(toolMessage, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    return;
  }
  if (!event.isError) {
    const summary = textOfResult(event.result);
    const result = toExecutionResult(isRecord(event.result) ? event.result.details : undefined, summary);
    const view: ToolEventView = { toolCallId, toolName, ...owner, status: 'success', ...(summary !== '' ? { summary } : {}) };
    upsertToolEvent(toolMessage, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    buffer.factResults.push({ toolName, result, toolCallId, sourceAccountId: buffer.sourceAccounts.get(toolCallId) });
    emitToolCards(buffer, toolName, result, toolMessage);
    return;
  }
  const rawMessage = textOfResult(event.result) || 'Tool execution failed';
  const result = { ...toExecutionResult(isRecord(event.result) ? event.result.details : undefined, rawMessage),
    ...parseModelToolError(rawMessage), ok: false };
  const message = result.error ?? rawMessage;
  if (toolResultStatus(result) === 'needs_reconciliation') {
    const view: ToolEventView = { toolCallId, toolName, ...owner, status: 'needs_reconciliation' };
    upsertToolEvent(toolMessage, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    buffer.factResults.push({ toolName, toolCallId, result, sourceAccountId: buffer.sourceAccounts.get(toolCallId) });
    return;
  }
  const parsed = security.gateway.securityGateway.parseBlockReason(message);
  // `BLOCK_REASON_PREFIX` is undefined under a partial `@/security` mock — stay robust, never throw.
  const prefix: unknown = security.gateway.BLOCK_REASON_PREFIX;
  const blocked = parsed !== null || (typeof prefix === 'string' && message.startsWith(prefix));
  if (!blocked) {
    const view: ToolEventView = { toolCallId, toolName, ...owner, status: 'error', summary: message, errorCode: result.errorCode };
    upsertToolEvent(toolMessage, view);
    buffer.events.push({ type: 'tool_end', toolEvent: view });
    buffer.factResults.push({ toolName, result: { ...result, error: message }, toolCallId, sourceAccountId: buffer.sourceAccounts.get(toolCallId) });
    emitCard(buffer, errorCard(message, result.errorCode), toolMessage);
    return;
  }
  // The blocked view carries ONLY typed facts (`actionId` / `errorCode` / renderable params).
  const view: ToolEventView = { toolCallId, toolName, ...owner, status: 'blocked',
    ...(parsed?.actionId ? { actionId: parsed.actionId } : {}),
    ...(parsed?.failure ? { errorCode: parsed.failure.code } : {}),
    ...errorParamsFrom(parsed?.failure) };
  upsertToolEvent(toolMessage, view);
  buffer.events.push({ type: 'tool_end', toolEvent: view });
  // A gated call is only actionable WITH its still-open pending action: the persisted row decides,
  // and a settled (`locked`/`executed`/`failed`/`cancelled`/`needs_reconciliation`) action is never
  // re-presented as a decision. A published prompt and the typed lock notice of a `locked` action
  // both own the outcome; a SKIPPED prompt (missing row, or settled to another terminal status) still
  // must not leave the blocked call unexplained, so it falls through to the typed refusal below -
  // without inventing a prompt, a pending card or any success.
  if (parsed?.actionId && (parsed.decisionKind === 'require_mfa' || parsed.decisionKind === 'require_confirmation')) {
    const outcome = await publishPendingDecision(buffer, parsed.actionId, toolName,
      parsed.decisionKind === 'require_mfa' ? 'mfa' : 'confirmation', toolMessage);
    if (outcome !== 'skipped') return;
  }
  // A locked refusal is published as STRUCTURED fields only — never the raw payload text.
  buffer.events.push({ type: 'security_event', kind: 'locked',
    ...(parsed?.failure ? { code: parsed.failure.code, reason: parsed.failure.reason } : {}),
    ...(parsed?.actionId ? { actionId: parsed.actionId } : {}),
    ...(typeof parsed?.failure?.attemptsLeft === 'number' ? { attemptsLeft: parsed.failure.attemptsLeft } : {}),
    ...(typeof parsed?.failure?.maxAttempts === 'number' ? { maxAttempts: parsed.failure.maxAttempts } : {}) });
}

/** Map normal and recovered Pi events through the same grounded presentation adapter. */
export function createEventHandler(buffer: TurnBuffer, now: () => number, rejected: ReadonlyMap<string, string> = new Map(),
  modelRequestIdentity?: () => string | undefined): (event: AgentEvent) => Promise<void> {
  return async event => {
    try {
      switch (event.type) {
        case 'message_start': {
          if (!isAssistantMessage(event.message)) return;
          const assistant = newAssistantMessage(now());
          const requestId = modelRequestIdentity?.();
          const session = buffer.events.find(item => item.type === 'session');
          if (requestId && session?.type === 'session' && session.runId) {
            assistant.id = assistantPresentationId(session.runId, requestId);
          }
          buffer.toolMessages.clear();
          buffer.sourceAccounts.clear();
          buffer.toolOwnerKey = undefined;
          buffer.current = assistant;
          buffer.assistants.push(assistant);
          buffer.events.push({ type: 'message_start', message: { ...assistant } });
          return;
        }
        case 'message_update': {
          if (event.assistantMessageEvent.type === 'text_delta') {
            // Raw tokens remain in the Pi journal; the public stream reports generation activity.
            publishReplyProgress(buffer, buffer.repairingReply ? 'repairing' : 'generating');
          }
          return;
        }
        case 'message_end': {
          if (!isAssistantMessage(event.message)) return;
          if (event.message.stopReason === 'stop') publishReplyProgress(buffer, 'checking');
          const assistant = buffer.current ?? newAssistantMessage(now());
          const rawProse = textOfContent(event.message.content);
          const formatIssues = inspectReplyFormat(rawProse, { allowProtocolExamples: buffer.allowProtocolExamples });
          buffer.lastGuidance = event.message.stopReason === 'stop' && !formatIssues.length
            ? parseBankingGuidance(rawProse) : undefined;
          if (event.message.content.some(part => part.type === 'toolCall')) {
            buffer.toolOwnerKey = modelRequestIdentity?.() ?? providerPresentationKey(event.message);
            if (rawProse) groundMessage(buffer, assistant, undefined, rawProse);
            else {
              assistant.content = '';
              buffer.groundedIds.add(assistant.id);
              buffer.assistants = buffer.assistants.filter(message => message.id !== assistant.id);
            }
          } else {
            const prose = event.message.stopReason === 'stop' ? textOfContent(event.message.content) : '';
            groundMessage(buffer, assistant, parseBankingGuidance(prose), prose);
          }
          // Presentation owns its projection; Pi and the journal retain the original model output.
          if (assistant.content !== '') buffer.events.push({ type: 'text_delta', delta: assistant.content });
          buffer.events.push({ type: 'message_end', message: assistant });
          return;
        }
        case 'tool_execution_start': {
          if (event.toolName === 'describe_turn') return;
          if (isRecord(event.args) && typeof event.args.sourceAccountId === 'string') buffer.sourceAccounts.set(event.toolCallId, event.args.sourceAccountId);
          const view: ToolEventView = { toolCallId: event.toolCallId, toolName: event.toolName, status: 'started',
            debugArguments: sanitizeToolArguments(event.args) };
          const message = ensureToolMessage(buffer, event.toolCallId, event.toolName, now());
          view.messageId = message.id;
          upsertToolEvent(message, view);
          buffer.events.push({ type: 'tool_start', toolEvent: view });
          return;
        }
        case 'tool_execution_update': {
          if (event.toolName === 'describe_turn') return;
          const message = ensureToolMessage(buffer, event.toolCallId, event.toolName, now());
          const view: ToolEventView = { toolCallId: event.toolCallId, toolName: event.toolName, messageId: message.id, status: 'updated' };
          upsertToolEvent(message, view);
          buffer.events.push({ type: 'tool_end', toolEvent: view });
          return;
        }
        case 'tool_execution_end': {
          if (event.toolName === 'describe_turn') return;
          try { await handleToolEnd(buffer, event, rejected, now()); }
          catch (error) {
            const message = buffer.toolMessages.get(event.toolCallId);
            const previous = message?.toolEvents?.[0];
            if (previous && (previous.status === 'started' || previous.status === 'updated')) {
              const failed: ToolEventView = { ...previous, status: 'error', debugDetail: safeToString(error) };
              upsertToolEvent(message ?? null, failed);
              buffer.events.push({ type: 'tool_end', toolEvent: failed });
            }
            throw error;
          }
          finally {
            const message = buffer.toolMessages.get(event.toolCallId);
            if (message) publishToolMessage(buffer, message);
          }
          return;
        }
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

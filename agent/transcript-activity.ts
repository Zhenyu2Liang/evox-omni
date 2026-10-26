import type { PendingAction, ToolInvocation } from '@/lib/db/prisma';
import type { ChatMessage, ToolEventView } from '@/lib/contracts/agent';
import { prisma } from '@/lib/db/client';
import { safeParse } from '@/lib/json';
import type { SessionSnapshot } from './session';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';
import { toCards } from './card-emitter';
import { isCatalogToolName } from '@/lib/contracts/tool-catalog';
import type { ToolExecutionResult } from './tools';
import { cardFingerprint } from '@/lib/chat-cards';
import { MANUAL_CARD_COMMAND_NAMES } from '@/lib/contracts/card-management';
import { toolPresentationId } from './tool-presentation-identity';
import { normalizePresentationMessages } from './transcript-presentation';
import { isInternalDiagnostic } from '@/lib/public-text';
import { isOpenActionStatus } from './action-status';

type InvocationEvidence = Pick<ToolInvocation, 'id' | 'runId' | 'callId' | 'toolName' | 'status' | 'resultJson'> & {
  argsJson?: string; modelRequestId?: string | null;
};
type ActionEvidence = Pick<PendingAction, 'id' | 'invocationId' | 'toolName' | 'status' | 'resultJson'>;

interface ResultSummary { summary?: string; }

/**
 * A recorded `resultJson.summary` is re-projected as PUBLIC historical text. `durable/journal.ts`
 * funnels the write side; this projection reads the same column a SECOND time, so a raw
 * `__SECURITY_BLOCK__` payload, a JSON fragment or a stack trace must never become visible
 * history. A business summary stays verbatim.
 */
function publicRecordedSummary(summary: string | undefined): string | undefined {
  if (typeof summary !== 'string' || isInternalDiagnostic(summary)) return undefined;
  return summary;
}

/** Resolve presentation from recorded execution identity, never from a matching tool name alone. */
export function projectTranscriptActivity(messages: readonly ChatMessage[], messageRuns: ReadonlyMap<string, string>,
  invocations: readonly InvocationEvidence[], actions: readonly ActionEvidence[]): ChatMessage[] {
  const byAction = new Map(actions.map(action => [action.id, action]));
  const invocationActions = new Map(actions.filter(action => action.invocationId).map(action => [action.invocationId!, action]));
  const byCall = new Map<string, InvocationEvidence | undefined>();
  const byMessage = new Map<string, InvocationEvidence | undefined>();
  for (const invocation of invocations) {
    const key = `${invocation.runId}:${invocation.callId}`;
    byCall.set(key, byCall.has(key) ? undefined : invocation);
    if (invocation.modelRequestId) {
      const messageId = toolPresentationId(invocation.runId, invocation.modelRequestId, invocation.callId);
      byMessage.set(messageId, byMessage.has(messageId) ? undefined : invocation);
    }
  }
  const projected = messages.map(message => {
    let cards = message.cards ? [...message.cards] : undefined;
    const toolEvents = message.toolEvents?.map(event => {
    const runId = messageRuns.get(message.id);
    const exact = byMessage.get(message.id);
    const invocation = exact?.callId === event.toolCallId ? exact
      : runId ? byCall.get(`${runId}:${event.toolCallId}`) : undefined;
    const action = event.actionId ? byAction.get(event.actionId) : invocation ? invocationActions.get(invocation.id) : undefined;
    const resultJson = action?.toolName === event.toolName && action.status === 'executed' ? action.resultJson
      : invocation?.toolName === event.toolName && invocation.status === 'completed' ? invocation.resultJson : undefined;
    if ((message.role === 'tool' || message.toolEvents?.length === 1) && resultJson && isCatalogToolName(event.toolName)) {
      const result = safeParse<ToolExecutionResult | null>(resultJson, null);
      if (result?.ok === true) {
        cards ??= [];
        for (const card of toCards(event.toolName, result, action?.id)) {
          if (card.type === 'cards' && card.issuanceActionId) {
            const existing = cards.findIndex(value => value.type === 'cards' &&
              cardFingerprint({ type: 'cards', data: value.data }) === cardFingerprint({ type: 'cards', data: card.data }));
            if (existing >= 0) { cards[existing] = card; continue; }
          }
          if (!cards.some(existing => cardFingerprint(existing) === cardFingerprint(card))) cards.push(card);
        }
      }
    }
    const debugArguments = invocation?.argsJson ? sanitizeToolArguments(safeParse<unknown>(invocation.argsJson, {}))
      : event.debugArguments === undefined ? undefined : sanitizeToolArguments(event.debugArguments);
    event = { ...event, ...(debugArguments === undefined ? {} : { debugArguments }) };
    if (action && action.toolName === event.toolName) {
      const status: ToolEventView['status'] = action.status === 'executed' ? 'success'
        : action.status === 'cancelled' ? 'cancelled' : action.status === 'needs_reconciliation' ? 'needs_reconciliation'
          : action.status === 'failed' ? 'error' : action.status === 'confirmed' ? 'updated'
            // Only an OPEN row may be re-presented as an awaiting-authorization decision; a
            // `locked` row is TERMINAL (`agent/action-status.ts`) and settled without executing.
          : isOpenActionStatus(action.status) ? 'blocked' : 'cancelled';
      const summary = publicRecordedSummary(safeParse<ResultSummary>(action.resultJson, {}).summary);
      return { ...event, actionId: action.id, status, summary };
    }
    if (!invocation || invocation.toolName !== event.toolName) return event;
    const status: ToolEventView['status'] = invocation.status === 'completed' ? 'success'
      : ['waiting_confirmation', 'waiting_verification'].includes(invocation.status) ? 'blocked'
        : ['failed', 'interrupted'].includes(invocation.status) ? 'error' : invocation.status === 'cancelled' ? 'cancelled'
          : invocation.status === 'needs_reconciliation' ? 'needs_reconciliation' : event.status;
    const summary = status === 'blocked' ? undefined
      : publicRecordedSummary(safeParse<ResultSummary>(invocation.resultJson, {}).summary);
    return { ...event, status, summary };
    });
    return { ...message, cards, toolEvents };
  });
  return normalizePresentationMessages(projected);
}

/** Rebuild historical activity on page opening without modifying the financial or event journal. */
export async function readTranscriptActivity(snapshot: SessionSnapshot): Promise<ChatMessage[]> {
  const scope = { sessionId: snapshot.sessionId, userId: snapshot.userId };
  const [events, invocations, actions] = await Promise.all([
    prisma.agentRunEvent.findMany({ where: { run: scope, channel: 'ui', eventType: { in: ['message_start', 'message_end'] } },
      orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }], select: { runId: true, payloadJson: true } }),
    prisma.toolInvocation.findMany({ where: { run: scope, origin: 'pi' },
      select: { id: true, runId: true, callId: true, toolName: true, status: true, resultJson: true, argsJson: true,
        modelRequestId: true } }),
    prisma.pendingAction.findMany({ where: { ...scope, toolName: { notIn: [...MANUAL_CARD_COMMAND_NAMES] } },
      select: { id: true, invocationId: true, toolName: true, status: true, resultJson: true } }),
  ]);
  const messageRuns = new Map<string, string>();
  for (const event of events) {
    const id = safeParse<{ message?: { id?: string } }>(event.payloadJson, {}).message?.id;
    if (id && !messageRuns.has(id)) messageRuns.set(id, event.runId);
  }
  return projectTranscriptActivity(snapshot.transcript, messageRuns, invocations, actions);
}

import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import type { AgentRunStatus } from '@/lib/contracts/runtime';
import { isWriteTool } from '@/security/permission-engine';
import { TOOL_NAMES } from './tools';
import { AgentRunJournal, beginRun, readRunPresentation, snapshotRuntimeValue } from './durable';
import type { SessionSnapshot } from './session';
import { newId } from '@/lib/ids';
import { getConfig, type AppConfig } from '@/lib/config';
import { encodeCheckpoint } from './durable/checkpoint';

export interface TurnRuntime {
  journal: AgentRunJournal;
  publish(events: readonly AgentStreamEvent[]): Promise<void>;
}

async function presentationEvents(runId: string, userId: string): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = await readRunPresentation(runId, userId, cursor, 500);
    events.push(...page.events.map(event => event.payload as AgentStreamEvent));
    cursor = page.nextSequence;
    if (!page.hasMore) return events;
  }
}

/** Runtime durability is separate from financial command durability and user presentation. */
export async function withDurableTurn(
  snapshot: SessionSnapshot,
  request: unknown,
  requestId: string | undefined,
  onEvent: ((event: AgentStreamEvent) => void | Promise<void>) | undefined,
  execute: (context: TurnRuntime) => Promise<ChatTurnResponse>,
  config: AppConfig = getConfig(),
): Promise<ChatTurnResponse> {
  const admission = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId, requestId: requestId ?? newId('request'), request, expectedRevision: snapshot.revision,
    checkpointJson: encodeCheckpoint(snapshot, config) });
  if (!admission.lease) {
    const events = await presentationEvents(admission.run.id, snapshot.userId);
    for (const event of events) await onEvent?.(event);
    return { sessionId: snapshot.sessionId, runId: admission.run.id, events };
  }
  const journal = new AgentRunJournal(admission.lease, { receiptBackedTools: new Set(TOOL_NAMES.filter(isWriteTool)) });
  journal.startHeartbeat();
  const published = new Set<AgentStreamEvent>();
  const publish = async (events: readonly AgentStreamEvent[]) => {
    for (const event of events) {
      if (published.has(event)) continue;
      const immutable = snapshotRuntimeValue(event) as AgentStreamEvent;
      await journal.recordPresentationEvent(immutable);
      published.add(event);
      await onEvent?.(immutable);
    }
  };
  try {
    if (admission.reused) {
      // Recovery must retain the original invocation identities; never re-prompt the input.
      const events: AgentStreamEvent[] = [
        { type: 'session', sessionId: snapshot.sessionId, runId: admission.run.id },
        { type: 'error', message: 'This interrupted run requires explicit recovery; existing operations were not repeated.' },
        { type: 'done' },
      ];
      await publish(events);
      await journal.finish('interrupted');
      return { sessionId: snapshot.sessionId, runId: admission.run.id, events };
    }
    const response = await execute({ journal, publish });
    await publish(response.events);
    const status: Exclude<AgentRunStatus, 'running'> = response.events.some(event => event.type === 'mfa_required')
      ? 'waiting_verification' : response.events.some(event => event.type === 'confirmation_required')
        ? 'waiting_confirmation' : response.events.some(event => event.type === 'error') ? 'failed' : 'completed';
    await journal.finish(status);
    return { ...response, runId: admission.run.id, events: await presentationEvents(admission.run.id, snapshot.userId) };
  } catch (error) {
    try { await journal.finish('failed', 'TURN_FAILED'); }
    catch { /* A failed journal or replaced lease must not hide the original failure. */ }
    throw error;
  } finally {
    journal.stopHeartbeat();
  }
}

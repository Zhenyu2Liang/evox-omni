import type { ChatTurnRequest, ChatTurnResponse } from '@/lib/contracts/agent';
import { getConfig } from '@/lib/config';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { redactRequest } from '@/lib/sensitive';
import { security } from '@/security';
import { createBankingAgent } from './banking-agent';
import { CONVERSATION_GENERATION_FAILED } from './conversational-response';
import { collectConversationEvidence } from './conversation-evidence';
import { getOrCreateSession, loadSession, saveSession, type SessionSnapshot } from './session';
import { withDurableTurn, type TurnRuntime } from './turn-runtime';
import { advanceConversationIntent } from './intent-context';
import { readyPresentationEvents } from './turns/buffer';
import { encodeCheckpoint } from './durable/checkpoint';
import { performAuthorizationResume } from './authorization-resume';
import { createTurnBuffer, createEventHandler, relayPlanSnapshot, flushParkedDecision, retireUnpublishedReply,
  publishServerReply, groundMessage, runLivePrompt, type PlanRelay, type RunTurnDeps, type ResumeTurnInput } from './turn-presentation';

export type { RunTurnDeps, ResumeTurnInput } from './turn-presentation';

/** Admission, execution, presentation and session commit have separate ownership boundaries. */
export async function runTurn(req: ChatTurnRequest, deps?: RunTurnDeps): Promise<ChatTurnResponse> {
  req = { ...req, message: redactRequest(req.message) };
  const config = deps?.config ?? getConfig();
  const snapshot = await getOrCreateSession(config.demoUserId, req.sessionId);
  return withDurableTurn(snapshot, { kind: 'input', message: req.message }, req.requestId, deps?.onEvent,
    context => performTurn(req, deps, snapshot, context), config);
}

async function performTurn(req: ChatTurnRequest, deps: RunTurnDeps | undefined, snapshot: SessionSnapshot,
  context: TurnRuntime): Promise<ChatTurnResponse> {
  const config = deps?.config ?? getConfig();
  const now = deps?.now ?? demoNow;
  snapshot.intent = advanceConversationIntent(snapshot.intent, req.message);
  const buffer = createTurnBuffer(req.message, snapshot.intent);
  buffer.conversationFacts = collectConversationEvidence(snapshot.agentState.messages);
  buffer.events.push({ type: 'session', sessionId: snapshot.sessionId, runId: context.journal.lease.runId });
  await context.publish(buffer.events);
  const scan = security.injection.scan(req.message);
  if (scan.suspicious) {
    await security.injection.reportInjection(snapshot.sessionId, req.message, scan, `injection:${context.journal.lease.runId}`);
    buffer.events.push({ type: 'security_event', kind: 'injection', message: scan.note });
  }
  const relay: PlanRelay = {};
  const publishProgress = () => context.publish(readyPresentationEvents(buffer));
  const runtime = createBankingAgent({ sessionId: snapshot.sessionId, userId: snapshot.userId, snapshot, config,
    provider: deps?.provider, journal: context.journal,
    onTurnIntent: intent => {
      snapshot.intent = intent;
      buffer.advisory = intent.purpose === 'advice';
      buffer.allowProtocolExamples = intent.allowProtocolExamples;
    },
    onPlanUpdate: async plan => { relayPlanSnapshot(buffer, relay, plan); await publishProgress(); } });
  const unsubscribeJournal = context.journal.subscribe(runtime.agent);
  const handler = createEventHandler(buffer, now, runtime.planningRejections,
    () => context.journal.currentModelRequestIdentity?.());
  const unsubscribe = runtime.agent.subscribe(async event => {
    await handler(event);
    if (event.type === 'tool_execution_end') await context.journal.checkpoint('tool_result');
    await publishProgress();
  });
  let generationFailure: string | undefined;
  try {
    await context.journal.checkpoint('input');
    generationFailure = await runLivePrompt(runtime, buffer, req.message, now);
  } finally { await flushParkedDecision(buffer, relay); unsubscribe(); unsubscribeJournal(); runtime.dispose(); }
  const hasPresentation = buffer.assistants.some(message => message.role === 'tool' || message.content !== '');
  if (generationFailure !== undefined || !hasPresentation) {
    retireUnpublishedReply(buffer);
    publishServerReply(runtime, buffer, now, CONVERSATION_GENERATION_FAILED);
    buffer.events.push({ type: 'error', code: 'INTERNAL', message: CONVERSATION_GENERATION_FAILED });
  }
  const serialized = runtime.serialize();
  snapshot.agentState = serialized.agentState;
  snapshot.intent = serialized.intent;
  snapshot.contextCompaction = serialized.contextCompaction;
  snapshot.replyRepair = serialized.replyRepair;
  snapshot.replyContext = serialized.replyContext;
  groundMessage(buffer, buffer.current);
  buffer.events = readyPresentationEvents(buffer);
  snapshot.transcript.push({ id: newId('msg'), role: 'user', content: req.message, timestamp: now() }, ...buffer.assistants);
  await saveSession(snapshot, { lease: context.journal.lease, checkpointJson: encodeCheckpoint(snapshot, config) });
  buffer.events.push({ type: 'done' });
  return { sessionId: snapshot.sessionId, events: buffer.events };
}

export async function resumeTurn(input: ResumeTurnInput, deps?: RunTurnDeps): Promise<ChatTurnResponse> {
  const snapshot = await loadSession(input.sessionId);
  if (!snapshot) throw new AppError('NOT_FOUND', 'Conversation not found');
  return withDurableTurn(snapshot, { kind: 'authorization_result', ...input }, undefined, deps?.onEvent,
    context => performAuthorizationResume(input, deps, snapshot, context, { createBuffer: createTurnBuffer,
      createHandler: createEventHandler, relayPlan: relayPlanSnapshot, flushDecision: flushParkedDecision,
      ground: groundMessage, reply: publishServerReply }), deps?.config ?? getConfig());
}

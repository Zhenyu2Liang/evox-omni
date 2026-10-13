import type { ChatTurnRequest, ChatTurnResponse } from '@/lib/contracts/agent';
import { getConfig } from '@/lib/config';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { redactRequest } from '@/lib/sensitive';
import { listProducts } from '@/lib/db/repositories/investment';
import { invalidRequestedComparison, requestedComparison } from '@/lib/request-constraints';
import { invalidRequestedPurchase } from '@/lib/request-purchases';
import { security } from '@/security';
import { createBankingAgent } from './banking-agent';
import { renderFinancialResponse } from './financial-response';
import { providedRequestFields } from './banking-guidance';
import { getOrCreateSession, loadSession, saveSession, type SessionSnapshot } from './session';
import { withDurableTurn, type TurnRuntime } from './turn-runtime';
import { advanceConversationIntent } from './intent-context';
import { canRecoverPlanning, unfinishedPlanning, recoveryNotice, startedMutation } from './live-recovery';
import { encodeCheckpoint } from './durable/checkpoint';
import { performAuthorizationResume } from './authorization-resume';
import { createTurnBuffer, createEventHandler, relayPlanSnapshot, flushParkedDecision, discardTerminalReply,
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
  snapshot.intent = advanceConversationIntent(snapshot.intent, req.message, { now });
  const buffer = createTurnBuffer(req.message);
  // Catalogue validation calibrates questions; it neither supplies financial facts nor authorizes.
  try {
    const products = /理财|申购|认购|购买|产品|基金/.test(req.message) || requestedComparison(req.message).length > 0 ? await listProducts() : [];
    buffer.providedFields = providedRequestFields(req.message, products);
    if (invalidRequestedComparison(req.message, products) || (/理财|申购|认购|产品|基金/.test(req.message) && invalidRequestedPurchase(req.message, products))) buffer.serverGuidance = { code: 'product_selection_invalid' };
  } catch { buffer.providedFields = []; }
  buffer.events.push({ type: 'session', sessionId: snapshot.sessionId, runId: context.journal.lease.runId });
  await context.publish(buffer.events);
  const scan = security.injection.scan(req.message);
  if (scan.suspicious) {
    await security.injection.reportInjection(snapshot.sessionId, req.message, scan, `injection:${context.journal.lease.runId}`);
    buffer.events.push({ type: 'security_event', kind: 'injection', message: scan.note });
  }
  const relay: PlanRelay = {};
  const publishProgress = () => {
    if (config.llmMode !== 'live') return context.publish(buffer.events);
    const planningIds = new Set(buffer.assistants.filter(message => message.content === '' && message.toolEvents?.length).map(message => message.id));
    return context.publish(buffer.events.filter(event => {
      if (event.type === 'error' || event.type === 'text_delta') return false;
      return event.type === 'message_start' || event.type === 'message_end' ? planningIds.has(event.message.id) : true;
    }));
  };
  const runtime = createBankingAgent({ sessionId: snapshot.sessionId, userId: snapshot.userId, snapshot, config,
    provider: deps?.provider, conversationIntent: () => snapshot.intent, journal: context.journal,
    onPlanUpdate: async plan => { relayPlanSnapshot(buffer, relay, plan); await publishProgress(); } });
  const unsubscribeJournal = context.journal.subscribe(runtime.agent);
  const handler = createEventHandler(buffer, now, runtime.planningRejections);
  const unsubscribe = runtime.agent.subscribe(async event => {
    await handler(event);
    if (event.type === 'tool_execution_end') await context.journal.checkpoint('tool_result');
    await publishProgress();
  });
  let liveFailure: string | undefined;
  try {
    await context.journal.checkpoint('input');
    if (config.llmMode === 'live') liveFailure = await runLivePrompt(runtime, buffer, req.message, now);
    else await runtime.agent.prompt(req.message);
  } finally { await flushParkedDecision(buffer, relay); unsubscribe(); unsubscribeJournal(); runtime.dispose(); }
  const unfinished = config.llmMode === 'live' && unfinishedPlanning(req.message, buffer.events, buffer.factResults,
    Boolean(buffer.serverGuidance ?? buffer.lastGuidance), runtime.planningRejections);
  if (config.llmMode === 'live' && (liveFailure || unfinished)) {
    discardTerminalReply(runtime, buffer);
    const notice = recoveryNotice(buffer.events, liveFailure, req.message, buffer.factResults, runtime.planningRejections);
    const facts = buffer.factResults.length || startedMutation(buffer.events, runtime.planningRejections)
      ? renderFinancialResponse(buffer.factResults, { requestText: req.message,
        pending: buffer.events.some(event => event.type === 'mfa_required') ? 'mfa' : buffer.events.some(event => event.type === 'confirmation_required') ? 'confirmation' : undefined }) + '\n' : '';
    const retryable = canRecoverPlanning(req.message, buffer.events, buffer.factResults,
      Boolean(buffer.serverGuidance ?? buffer.lastGuidance), liveFailure, runtime.planningRejections);
    buffer.events = buffer.events.filter(event => event.type !== 'error');
    publishServerReply(runtime, buffer, now, facts + notice, retryable ? req.message : undefined);
    if (liveFailure) buffer.events.push({ type: 'error', message: notice });
  } else if (config.llmMode === 'live' && buffer.current?.content === '' && (buffer.factResults.length || startedMutation(buffer.events, runtime.planningRejections))) {
    publishServerReply(runtime, buffer, now, renderFinancialResponse(buffer.factResults, {
      guidance: buffer.serverGuidance ?? buffer.lastGuidance, locked: buffer.events.some(event => event.type === 'security_event' && event.kind === 'locked'),
      pending: buffer.events.some(event => event.type === 'mfa_required') ? 'mfa' : buffer.events.some(event => event.type === 'confirmation_required') ? 'confirmation' : undefined }));
  }
  snapshot.agentState = runtime.serialize().agentState;
  if (buffer.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required' || event.type === 'plan_update')) snapshot.intent.status = 'submitted';
  groundMessage(buffer, buffer.current);
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

import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { runTurn, confirmAction } from '@/agent';
import { recoverOwnedRun } from '@/agent/durable/service';
import { tickAgentRecovery } from '@/agent/recovery-worker';
import type { AppConfig } from '@/lib/config';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { ModelRuntime } from '@/agent/providers/types';
import { prisma } from '@/lib/db/client';
import { listRecoverableAgentRuns } from '@/lib/db/repositories/agentRun';
import { AgentRunJournal } from '@/agent/durable/journal';
import { turnDeclaration } from './scripted-provider';

const config: AppConfig = {
  llmMode: 'live', llmProvider: 'restart-test', llmModel: 'restart-model', demoUserId: 'user_liming',
};
const mode = process.argv[2];
const scenario = process.argv[3];
if (scenario === 'authorization_result') config.llmMode = 'mock';
const runId = process.argv[4];
const sessionId = process.argv[5];
let activeRunId = '';
let activeSessionId = '';
let modelCalls = 0;
let renderingAuthorization = false;
// A service has a listening socket; this child keeps an equivalent live host handle until killed.
const hostHandle = mode === 'start' ? setInterval(() => undefined, 1000) : undefined;

function tell(message: unknown): void { process.send?.(message); }
function hold(): Promise<never> { return new Promise(() => undefined); }

const recordAgentEvent = AgentRunJournal.prototype.recordAgentEvent;
AgentRunJournal.prototype.recordAgentEvent = function (event) {
  if (mode === 'start' && scenario === 'model_result' && event.type === 'tool_execution_start') {
    tell({ type: 'barrier', point: scenario, runId: activeRunId, sessionId: activeSessionId });
    return hold();
  }
  return recordAgentEvent.call(this, event);
};

const checkpoint = AgentRunJournal.prototype.checkpoint;
AgentRunJournal.prototype.checkpoint = async function (stage) {
  await checkpoint.call(this, stage);
  if (mode === 'start' && scenario === 'authorization_result' && renderingAuthorization && stage === 'input') {
    // The financial command already committed; result rendering/session persistence has not begun.
    tell({ type: 'barrier', point: scenario, runId: this.lease.runId, sessionId: this.lease.sessionId });
    await hold();
  }
};

const faux = fauxProvider({ provider: 'restart-test', api: 'restart-test-api', models: [{ id: 'restart-model', name: 'Restart test model' }] });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

function proposedTool() {
  const call = scenario === 'dag_progress'
    ? fauxToolCall('submit_plan', { goal: 'Reserve a budget and read the balance', nodes: [
      { id: 'budget', name: 'Reserve budget', kind: 'tool', tool: 'reserve_budget', args: { name: 'Crash-safe workflow budget', amount: '10.00' }, dependencies: [] },
      { id: 'read', name: 'Read balance', kind: 'tool', tool: 'get_balance', args: {}, dependencies: ['budget'] },
    ] }, { id: 'original-call' })
    : scenario === 'committed_write'
    ? fauxToolCall('reserve_budget', { name: 'Crash-safe budget', amount: '10.00' }, { id: 'original-call' })
    : scenario === 'authorization' || scenario === 'authorization_result'
      ? fauxToolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.00' }, { id: 'original-call' })
      : fauxToolCall('get_balance', {}, { id: 'original-call' });
  const writes = scenario === 'dag_progress' || scenario === 'committed_write' ? ['reserve_budget']
    : scenario === 'authorization' || scenario === 'authorization_result' ? ['transfer_money'] : [];
  const declaration = turnDeclaration({ purpose: writes.length ? 'operation' : 'query',
    operations: [...writes, ...(scenario === 'dag_progress' || !writes.length ? ['get_balance'] : [])],
    ...(scenario === 'dag_progress' ? { workflow: true } : {}) });
  return fauxAssistantMessage([...declaration.content, call], { stopReason: 'toolUse' });
}

faux.appendResponses([context => {
  // Recovery supplies stored tool results to the model rather than generating a fresh operation.
  const answered = context.messages.some(message => message.role === 'toolResult');
  const result = answered ? fauxAssistantMessage('The saved operation result has been received.') : proposedTool();
  faux.appendResponses([() => fauxAssistantMessage('The saved operation result has been received.')]);
  return result;
}]);

const provider: ModelRuntime = {
  model,
  streamFn: (currentModel, context, options) => {
    modelCalls++;
    tell({ type: 'model_call', count: modelCalls });
    if (mode === 'start' && scenario === 'partial_model') {
      const stream = createAssistantMessageEventStream();
      const partial = { ...fauxAssistantMessage('Incomplete model output'), api: currentModel.api,
        provider: currentModel.provider, model: currentModel.id };
      stream.push({ type: 'start', partial });
      stream.push({ type: 'text_start', contentIndex: 0, partial });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Incomplete model output', partial });
      tell({ type: 'barrier', point: scenario, runId: activeRunId, sessionId: activeSessionId });
      return stream;
    }
    return models.streamSimple(currentModel, context, options);
  },
};

async function onEvent(event: AgentStreamEvent): Promise<void> {
  if (event.type === 'session') {
    activeRunId = event.runId ?? activeRunId;
    activeSessionId = event.sessionId;
  }
  const stop = scenario === 'read_intent' && event.type === 'tool_start'
    || scenario === 'committed_write' && event.type === 'tool_end' && event.toolEvent.status === 'success'
    || scenario === 'authorization' && event.type === 'confirmation_required'
    || scenario === 'dag_progress' && event.type === 'plan_update' && event.plan.results.some(node => node.id === 'budget' && node.status === 'success')
      && !event.plan.results.some(node => node.id === 'read' && node.status === 'success');
  if (mode === 'start' && stop) {
    tell({ type: 'barrier', point: scenario, runId: activeRunId, sessionId: activeSessionId });
    await hold();
  }
}

async function main(): Promise<void> {
  if (mode === 'start') {
    const message = scenario === 'dag_progress' ? 'Reserve a budget of 10.00 named Crash-safe workflow budget and then read my checking account balance.'
      : scenario === 'committed_write' ? 'Reserve a budget of 10.00 named Crash-safe budget.'
      : scenario === 'authorization' || scenario === 'authorization_result' ? 'Transfer 200.00 to contact_zhangwei.' : 'Read my checking account balance.';
    const result = await runTurn({ message, requestId: `restart:${scenario}` }, { config, provider, onEvent });
    if (scenario === 'authorization_result') {
      const decision = result.events.find(event => event.type === 'confirmation_required');
      if (decision?.type !== 'confirmation_required') throw new Error('The original transfer was not parked for confirmation.');
      await runTurn({ sessionId: result.sessionId, message: 'Tell me a joke.', requestId: 'restart:authorization_result:conversation' }, { config, provider });
      renderingAuthorization = true;
      await confirmAction(decision.actionId, { sessionId: result.sessionId, userId: config.demoUserId, deps: { config, provider, onEvent } });
    }
    tell({ type: 'unexpected_completion', runId: result.runId, modelCalls });
  } else if (mode === 'recover') {
    const response = await recoverOwnedRun(runId, { userId: config.demoUserId, sessionId }, undefined, { config, provider });
    tell({ type: 'recovered', response, modelCalls });
  } else if (mode === 'worker') {
    let recoveryError: string | undefined;
    const result = await tickAgentRecovery({ ports: {
      discover: listRecoverableAgentRuns,
      recover: async candidate => {
        try { return await recoverOwnedRun(candidate.id, candidate, undefined, { config, provider }); }
        catch (error) { recoveryError = error instanceof Error ? error.message : 'Recovery failed.'; throw error; }
      },
    } });
    tell({ type: 'worker_finished', result, modelCalls, message: recoveryError });
  } else throw new Error('Unsupported restart test process mode.');
}

void main().catch(error => {
  tell({ type: 'fatal', message: error instanceof Error ? error.message : 'Restart test failed.' });
  process.exitCode = 1;
}).finally(async () => {
  if (hostHandle) clearInterval(hostHandle);
  await prisma.$disconnect();
  process.disconnect?.();
});

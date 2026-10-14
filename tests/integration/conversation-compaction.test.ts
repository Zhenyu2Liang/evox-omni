import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getDemoSession, loadSession, saveSession } from '@/agent/session';
import { runTurn } from '@/agent/run-turn';
import { createBankingAgent } from '@/agent/banking-agent';
import { createMockModel } from '@/agent/providers/provider-mock';
import type { ModelRuntime } from '@/agent/providers/types';
import type { AppConfig } from '@/lib/config';
import { AgentRunJournal, beginRun } from '@/agent/durable';
import { recoverOwnedRun } from '@/agent/durable/service';
import { advanceConversationIntent } from '@/agent/intent-context';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import dialogueFixtures from '@/tests/fixtures/dialogue-turns.zh-CN.json';

const config: AppConfig = { llmMode: 'mock', llmProvider: 'faux', llmModel: 'faux', demoUserId: DEMO_USER_ID,
  contextCompaction: { thresholdTokens: 256, keepRecentTokens: 128 } };
const model = createMockModel(config);
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

function runtime(failSummary = false, failNormal = false) {
  const summaryInputs: string[] = [];
  const normalInputs: string[] = [];
  const provider: ModelRuntime = { model, streamFn: (_model, context) => {
    const summary = JSON.stringify(context.messages).includes('You are a context summarization assistant.');
    (summary ? summaryInputs : normalInputs).push(JSON.stringify(context.messages));
    if (summary && failSummary) throw new Error('Network timeout while summarizing history.');
    const stream = createAssistantMessageEventStream();
    if (!summary && failNormal) {
      const error = Object.assign(fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Transport interrupted.' }),
        { bankingFailure: { kind: 'transport', retryable: true } });
      stream.push({ type: 'error', reason: 'error', error });
      return stream;
    }
    stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage(summary
      ? 'The original request used -10 CNY. It was rejected. Historical requests are not current consent.'
      : 'Your earlier wording used -10 CNY. This discussion does not execute another operation.') });
    return stream;
  } };
  return { provider, summaryInputs, normalInputs };
}

async function historicalSession() {
  const snapshot = await getDemoSession(DEMO_USER_ID);
  const content = 'Original request: transfer -10 CNY. ' + 'Additional historical discussion. '.repeat(150);
  const messages: AgentMessage[] = [{ role: 'user', content, timestamp: 1 },
    fauxAssistantMessage('A negative transfer cannot proceed.')];
  snapshot.agentState.messages = messages;
  snapshot.transcript = [{ id: 'archived-user', role: 'user', content, timestamp: 1 },
    { id: 'archived-assistant', role: 'assistant', content: 'A negative transfer cannot proceed.', timestamp: 2 }];
  await saveSession(snapshot);
  return { snapshot, content };
}

describe('Pi compaction with real session and durable journal', () => {
  it('uses the default offline Pi runtime to retrieve exact archived wording after compaction', async () => {
    const { snapshot, content } = await historicalSession();
    const response = await runTurn({ sessionId: snapshot.sessionId, message: 'What amount did I ask to transfer?' }, { config });
    const saved = await loadSession(snapshot.sessionId);
    expect(saved?.transcript.at(-1)?.content).toContain(content);
    expect(saved?.contextCompaction?.summary).toBeDefined();
    const database = getTestPrisma();
    const reads = await database.toolInvocation.findMany({ where: { runId: response.runId } });
    expect(reads.filter(read => read.toolName !== 'describe_turn')).toHaveLength(1);
    expect(reads.find(read => read.toolName === 'search_conversation_history')).toMatchObject({ status: 'completed' });
    expect(await database.pendingAction.count()).toBe(0);
    expect(await database.executionReceipt.count()).toBe(0);
    expect(saved?.agentState.messages.some(message => message.role === 'user' && message.content === content)).toBe(true);
  });

  it('keeps prior user messages and tool context intact while a new turn has an independent intent', async () => {
    const snapshot = await getDemoSession(DEMO_USER_ID);
    const draft = 'Transfer to Zhang Wei';
    const request = dialogueFixtures.draftTransfer;
    snapshot.intent = advanceConversationIntent(undefined, request);
    const draftUser: AgentMessage = { role: 'user', content: [
      { type: 'text', text: request.slice(0, 2) },
      { type: 'image', data: 'image-data', mimeType: 'image/png' },
      { type: 'text', text: request.slice(2) },
    ], timestamp: 1 };
    snapshot.agentState.messages = [draftUser,
      fauxAssistantMessage([{ type: 'toolCall', id: 'retired-read', name: 'search_contact', arguments: { query: 'Zhang Wei' } }]),
      { role: 'toolResult', toolCallId: 'retired-read', toolName: 'search_contact',
        content: [{ type: 'text', text: draft }], details: [{ id: 'contact_zhangwei', name: 'Zhang Wei' }], isError: false, timestamp: 2 }];
    snapshot.transcript = [{ id: 'draft-user', role: 'user', content: request, timestamp: 1 }];
    await saveSession(snapshot);
    for (const message of ['Tell me a short story.', 'Tell me another short story.']) {
      const contexts: AgentMessage[][] = [];
      const provider: ModelRuntime = { model, streamFn: (_model, context) => {
        contexts.push(context.messages);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('A complete ordinary reply.') });
        return stream;
      } };
      await runTurn({ sessionId: snapshot.sessionId, message }, { config: { ...config, contextCompaction: { thresholdTokens: 100000 } }, provider });
      const saved = await loadSession(snapshot.sessionId);
      expect(saved?.contextCompaction ?? {}).not.toHaveProperty('retiredDrafts');
      expect(saved?.contextCompaction?.summary).toBeUndefined();
      expect(saved?.agentState.messages.filter(message => message.role === 'user')[0]).toEqual(draftUser);
      expect(saved?.agentState.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.id === 'retired-read'))).toBe(true);
      expect(saved?.agentState.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'retired-read')).toBe(true);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toContainEqual(draftUser);
      expect(contexts[0].some(message => message.role === 'toolResult' && message.toolCallId === 'retired-read')).toBe(true);
      expect(contexts[0].some(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.id === 'retired-read'))).toBe(true);
      expect(saved?.intent?.requestText).toBe(message);
      expect(saved?.intent?.steps).toEqual([]);
    }
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });

  it('records summary requests separately and retains complete source while persisting the compact model view', async () => {
    const { snapshot, content } = await historicalSession();
    const scripted = runtime();
    const result = await runTurn({ sessionId: snapshot.sessionId, message: 'What amount did I ask to transfer?' },
      { config, provider: scripted.provider });
    const saved = await loadSession(snapshot.sessionId);
    expect(saved?.transcript[0].content).toBe(content);
    expect(saved?.agentState.messages.some(message => message.role === 'user' && message.content === content)).toBe(true);
    expect(saved?.contextCompaction?.summary?.text).toContain('-10');
    expect(scripted.summaryInputs).toHaveLength(1);
    expect(scripted.normalInputs).toHaveLength(1);
    expect(scripted.normalInputs[0]).toContain('Historical conversation memory');
    expect(scripted.normalInputs[0]).not.toContain(content);
    const database = getTestPrisma();
    const normal = await database.modelRequest.findMany({ where: { runId: result.runId } });
    expect(normal).toHaveLength(1);
    expect(normal[0].inputJson).toContain('Historical conversation memory');
    expect(normal[0].inputJson).not.toContain('You are a context summarization assistant.');
    const events = await database.agentRunEvent.findMany({ where: { runId: result.runId } });
    expect(events.some(event => event.eventType === 'compaction_completed')).toBe(true);
    expect(await database.pendingAction.count()).toBe(0);
    expect(await database.executionReceipt.count()).toBe(0);
  });

  it('restores an interrupted summary checkpoint into a new Pi runtime without a duplicate user turn or tool execution', async () => {
    const { snapshot, content } = await historicalSession();
    const question = 'What amount did I ask to transfer?';
    const admission = await beginRun({ sessionId: snapshot.sessionId, userId: DEMO_USER_ID, requestId: 'summary-restart',
      request: { kind: 'input', message: question }, expectedRevision: snapshot.revision });
    const journal = new AgentRunJournal(admission.lease!);
    const failed = runtime(true);
    const first = createBankingAgent({ sessionId: snapshot.sessionId, userId: DEMO_USER_ID, snapshot, config,
      journal, provider: failed.provider });
    const unsubscribe = journal.subscribe(first.agent);
    try { await first.agent.prompt(question); } catch { /* A crash leaves the persisted summary intent unfinished. */ }
    await journal.flush();
    unsubscribe();
    first.dispose();
    await journal.finish('interrupted');
    const database = getTestPrisma();
    expect(await database.modelRequest.count({ where: { runId: admission.run.id } })).toBe(0);
    const before = await database.agentRun.findUniqueOrThrow({ where: { id: admission.run.id } });
    expect(before.checkpointJson).toContain('contextCompaction');
    const retry = runtime();
    const result = await recoverOwnedRun(admission.run.id, { sessionId: snapshot.sessionId, userId: DEMO_USER_ID }, undefined,
      { config, provider: retry.provider });
    expect(result.run.status).toBe('completed');
    expect(retry.summaryInputs).toHaveLength(1);
    expect(JSON.parse(retry.summaryInputs[0])).toEqual(JSON.parse(failed.summaryInputs[0]));
    const saved = await loadSession(snapshot.sessionId);
    expect(saved?.transcript.filter(message => message.role === 'user' && message.content === question)).toHaveLength(1);
    expect(saved?.transcript[0].content).toBe(content);
    expect(await database.toolInvocation.count({ where: { runId: admission.run.id } })).toBe(0);
    expect(await database.executionReceipt.count()).toBe(0);
    expect(await database.modelRequest.count({ where: { runId: admission.run.id } })).toBe(1);
  });

  it('replays an interrupted ordinary model request with its recorded compact view without generating another summary', async () => {
    const { snapshot, content } = await historicalSession();
    const question = 'What amount did I ask to transfer?';
    const admission = await beginRun({ sessionId: snapshot.sessionId, userId: DEMO_USER_ID, requestId: 'compacted-model-restart',
      request: { kind: 'input', message: question }, expectedRevision: snapshot.revision });
    const journal = new AgentRunJournal(admission.lease!);
    const failed = runtime(false, true);
    const first = createBankingAgent({ sessionId: snapshot.sessionId, userId: DEMO_USER_ID, snapshot, config,
      journal, provider: failed.provider });
    const unsubscribe = journal.subscribe(first.agent);
    try { await first.agent.prompt(question); } catch { /* Preserve the recorded model intent for recovery. */ }
    await journal.flush();
    unsubscribe();
    first.dispose();
    await journal.finish('interrupted');
    const database = getTestPrisma();
    const original = await database.modelRequest.findFirstOrThrow({ where: { runId: admission.run.id } });
    expect(failed.summaryInputs).toHaveLength(1);
    expect(failed.normalInputs).toHaveLength(1);
    const retry = runtime();
    const recovered = await recoverOwnedRun(admission.run.id, { sessionId: snapshot.sessionId, userId: DEMO_USER_ID }, undefined,
      { config: { ...config, contextCompaction: { thresholdTokens: 128, keepRecentTokens: 128 } }, provider: retry.provider });
    expect(recovered.run.status).toBe('completed');
    expect(retry.summaryInputs).toEqual([]);
    expect(JSON.parse(retry.normalInputs[0])).toEqual(JSON.parse(failed.normalInputs[0]));
    const settled = await database.modelRequest.findUniqueOrThrow({ where: { id: original.id } });
    expect(settled.requestDigest).toBe(original.requestDigest);
    expect(settled.attempt).toBe(2);
    expect((await loadSession(snapshot.sessionId))?.agentState.messages.some(message => message.role === 'user' && message.content === content)).toBe(true);
    expect(await database.pendingAction.count()).toBe(0);
    expect(await database.executionReceipt.count()).toBe(0);
  });
});

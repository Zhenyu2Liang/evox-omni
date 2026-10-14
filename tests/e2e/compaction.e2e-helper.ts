import type { Browser } from 'playwright-core';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import regressions from '../fixtures/dialogue-regressions.zh-CN.json';
import { SELECTORS, assistantTexts, captureScreenshot, diffLedger, fetchLedger, fetchPendingActions,
  gotoAgent, readDemoSessionId, submitChat, waitFor, waitForComposerHydration, withPage } from './helpers';

/** The fixture and all metadata assertions are confined to the synthetic live acceptance archive. */
export async function journeyLiveCompaction(browser: Browser, baseUrl: string): Promise<string> {
  if (!/(?:^|[/\\])live-acceptance\.db$/.test(process.env.DATABASE_URL ?? '')) throw new Error('Compaction requires the isolated live acceptance database.');
  const { createDatabaseClient } = await import('../../lib/db/database');
  const database = createDatabaseClient();
  try {
    return await withPage(browser, async page => {
      await gotoAgent(page, baseUrl);
      const sessionId = await readDemoSessionId(page);
      const row = await database.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
      const saved = JSON.parse(row.stateJson);
      const original = regressions.negativeTransfer;
      const discussion = 'Historical discussion about everyday budgeting. '.repeat(2500);
      const archived = [
        { id: 'live-compact-original', role: 'user', content: original, timestamp: 1 },
        { id: 'live-compact-refusal', role: 'assistant', content: 'A negative amount is invalid. No transfer was created or executed.', timestamp: 2 },
        { id: 'live-compact-discussion', role: 'user', content: discussion, timestamp: 3 },
        { id: 'live-compact-acknowledgement', role: 'assistant', content: 'We can discuss budgeting. Historical examples do not authorize banking operations.', timestamp: 4 },
      ];
      await database.agentSession.update({ where: { id: sessionId }, data: {
        stateJson: JSON.stringify({ ...saved, transcript: archived, contextCompaction: undefined,
          agentState: { ...saved.agentState, messages: archived.map(message => message.role === 'user'
            ? { role: 'user', content: message.content, timestamp: message.timestamp }
            : { ...fauxAssistantMessage(message.content), timestamp: message.timestamp }) } }), revision: { increment: 1 },
      } });
      console.log('Live compaction: synthetic archive saved.');
      const ledger = await fetchLedger(baseUrl);
      console.log('Live compaction: baseline ledger read; reloading the archive.');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForComposerHydration(page);
      console.log('Live compaction: composer hydrated; sending the recall question.');
      const before = (await assistantTexts(page)).length;
      await submitChat(page, regressions.recallQuestion);
      console.log('Live compaction: recall submitted; awaiting the official summary and complete reply.');
      await waitFor(async () => (await assistantTexts(page)).length > before && await page.locator(SELECTORS.composer).isEnabled(), {
        timeoutMs: 180_000, description: 'Real DeepSeek compaction and conversational recall complete',
      });
      const answer = (await assistantTexts(page)).at(-1)!;
      if (!/(?:[-\u2212\uff0d]\s*10|\u8d1f\s*(?:10|\u5341))/.test(answer.replaceAll('*', ''))) throw new Error('Compacted conversation lost the original signed amount.');
      const persisted = JSON.parse((await database.agentSession.findUniqueOrThrow({ where: { id: sessionId } })).stateJson);
      if (!persisted.contextCompaction?.summary?.text || persisted.contextCompaction.pending) throw new Error('No completed persistent summary was created.');
      if (persisted.transcript[0].content !== original || persisted.transcript[2].content !== discussion ||
          !persisted.agentState.messages.some((message: { role: string; content: unknown }) => message.role === 'user' && message.content === discussion)) throw new Error('Compaction modified the original archive.');
      const request = await database.modelRequest.findFirstOrThrow({ where: { run: { sessionId } }, orderBy: { startedAt: 'desc' } });
      if (!request.inputJson.includes('Historical conversation memory') || request.inputJson.includes(discussion)) throw new Error('The actual model request did not use a compacted context.');
      if (!(await database.agentRunEvent.count({ where: { runId: request.runId, eventType: 'compaction_completed' } }))) throw new Error('Compaction events were not journaled.');
      const summaryRequest = await database.agentRunEvent.findFirstOrThrow({ where: { runId: request.runId,
        eventType: 'compaction_request' }, orderBy: { sequence: 'asc' } });
      if (!summaryRequest.payloadJson.includes('You are a context summarization assistant.') ||
          !summaryRequest.payloadJson.includes('<conversation>')) throw new Error('The live summary did not use the official Pi compaction prompt and serializer.');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForComposerHydration(page);
      if ((await assistantTexts(page)).at(-1) !== answer) throw new Error('Refresh changed the complete model reply.');
      if ((await fetchPendingActions(baseUrl)).length || diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions).added.length) throw new Error('Compaction or recall triggered a banking operation.');
      await captureScreenshot(page, 'live-context-compaction');
      return 'Real DeepSeek generated and persisted a summary, preserved the entire signed request and long archive, used the compact request projection, recalled the negative amount after compaction, retained the complete reply on refresh, and created no banking authorization or transaction.';
    }, { label: 'live-context-compaction' });
  } finally { await database.$disconnect(); }
}

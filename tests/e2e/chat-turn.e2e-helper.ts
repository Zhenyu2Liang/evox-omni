import type { Page, Response } from 'playwright-core';
import type { ChatMessage } from '../../lib/contracts/agent';
import { readDemoSessionId, SELECTORS, submitChat, waitFor } from './helpers';
import { withDb } from './live-virtual-card.e2e-helper';

const TURN_TIMEOUT_MS = 120_000;

/** The stream's `done` event may precede lease release; await the HTTP body as well. */
export async function waitForLiveResponseCompletion(response: Response, timeoutMs = TURN_TIMEOUT_MS): Promise<void> {
  if (!response.ok()) throw new Error(`The current banking request returned HTTP ${response.status()}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const failure = await Promise.race([
      response.finished(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The current banking response did not finish')), timeoutMs);
      }),
    ]);
    if (failure) throw new Error(`The current banking response was interrupted: ${failure.message}`);
  } finally { clearTimeout(timer); }
}

/** A visible old reply or an enabled composer does not prove server-side admission is free. */
export async function waitForLiveSessionIdle(page: Page, timeoutMs = TURN_TIMEOUT_MS): Promise<void> {
  const sessionId = await readDemoSessionId(page);
  await waitFor(async () => {
    const session = await withDb(db => db.agentSession.findUnique({ where: { id: sessionId }, select: { activeRunId: true } }));
    return session !== null && session.activeRunId === null;
  }, { timeoutMs, description: 'The current demo session releases its active run' });
}

export interface CompletedLiveChatTurn {
  requestId: string;
  runId: string;
  sessionId: string;
  messages: ChatMessage[];
}

/** Bind completion and rendered messages to the POST's own requestId and persisted run. */
export async function submitCompletedLiveChatTurn(page: Page, message: string,
  timeoutMs = TURN_TIMEOUT_MS): Promise<CompletedLiveChatTurn> {
  await waitForLiveSessionIdle(page, timeoutMs);
  const sessionId = await readDemoSessionId(page);
  const [response] = await Promise.all([
    page.waitForResponse(candidate => {
      const request = candidate.request();
      return request.method() === 'POST' && new URL(candidate.url()).pathname === '/api/chat' &&
        request.postDataJSON()?.message === message;
    }, { timeout: timeoutMs }),
    submitChat(page, message, timeoutMs),
  ]);
  await waitForLiveResponseCompletion(response, timeoutMs);
  const requestId: unknown = response.request().postDataJSON()?.requestId;
  if (typeof requestId !== 'string' || !requestId) throw new Error('The current chat request has no requestId');

  const run = await withDb(db => db.agentRun.findUnique({
    where: { sessionId_requestId: { sessionId, requestId } },
    select: { id: true, status: true, errorCode: true },
  }));
  if (!run || !['completed', 'waiting_confirmation', 'waiting_verification'].includes(run.status)) {
    throw new Error(`The current chat run did not complete: ${run?.status ?? 'missing'} / ${run?.errorCode ?? 'no error code'}`);
  }
  await waitForLiveSessionIdle(page, timeoutMs);
  const rows = await withDb(db => db.agentRunEvent.findMany({
    where: { runId: run.id, channel: 'ui', eventType: 'message_end' },
    select: { payloadJson: true }, orderBy: { sequence: 'asc' },
  }));
  const messages = rows.map(row => (JSON.parse(row.payloadJson) as { message: ChatMessage }).message);
  if (!messages.length || messages.some(item => !item || typeof item.id !== 'string' || !item.id)) {
    throw new Error('The current chat run has no complete presentation messages');
  }
  const messageIds = messages.map(item => item.id);
  await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled() &&
    await page.locator('[data-message-id]').evaluateAll((elements, ids) => {
      const rendered = new Set(elements.map(element => element.getAttribute('data-message-id')));
      return ids.every(id => rendered.has(id));
    }, messageIds), { timeoutMs, description: 'Only this request’s completed messages are rendered' });
  return { requestId, runId: run.id, sessionId, messages };
}

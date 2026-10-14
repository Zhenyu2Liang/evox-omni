import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/chat/history/route';
import { POST as resetConversation } from '@/app/api/developer/chat/reset/route';
import { getDemoSession, loadSession, saveSession } from '@/agent/session';
import { conversationHistoryGeneration } from '@/app/agent/history';
import { searchConversationHistory } from '@/agent/conversation-history-search';
import { selectChatHistoryPage } from '@/lib/chat-history';
import type { ChatHistoryPage } from '@/lib/contracts/chat-history';
import { DEVELOPER_MODE_COOKIE } from '@/lib/developer-mode/shared';
import { getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { getJson, postJson } from './harness';

const path = '/api/chat/history';
const enabled = { cookie: `${DEVELOPER_MODE_COOKIE}=1` };
beforeEach(resetDatabase);

async function savedHistory(count = 45) {
  const snapshot = await getDemoSession(DEMO_USER_ID);
  snapshot.transcript = Array.from({ length: count }, (_, index) => ({
    id: `history-${index}`, role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `Message ${index}.`, timestamp: 10,
  }));
  await saveSession(snapshot);
  return snapshot;
}

describe('shared conversation history pages', () => {
  it('searches original archived user/assistant text only within the trusted owner and session', async () => {
    const snapshot = await savedHistory();
    const page = await searchConversationHistory({ userId: DEMO_USER_ID, sessionId: snapshot.sessionId, query: 'Message', limit: 20 });
    expect(page.matches.map(match => match.messageId)).toEqual(snapshot.transcript.slice(25).map(message => message.id));
    expect(page.matches.every(match => match.role === 'user' || match.role === 'assistant')).toBe(true);
    expect(page.hasMore).toBe(true);
    await expect(searchConversationHistory({ userId: 'other-owner', sessionId: snapshot.sessionId, query: 'Message' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(searchConversationHistory({ userId: DEMO_USER_ID, sessionId: 'missing-session', query: 'Message' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await loadSession(snapshot.sessionId))?.transcript).toEqual(snapshot.transcript);
  });
  it('returns 20 complete messages and all older pages without trimming stored archives', async () => {
    const snapshot = await savedHistory();
    const latest = await getJson<{ data: ChatHistoryPage }>(GET, path);
    expect(latest.status).toBe(200);
    expect(latest.headers.get('cache-control')).toBe('no-store');
    const first = latest.data!.data;
    expect(first.messages.map(message => message.id)).toEqual(snapshot.transcript.slice(25).map(message => message.id));
    const second = await getJson<{ data: ChatHistoryPage }>(GET, `${path}?cursor=${first.nextCursor}&limit=20`);
    const third = await getJson<{ data: ChatHistoryPage }>(GET, `${path}?cursor=${second.data!.data.nextCursor}`);
    expect([...third.data!.data.messages, ...second.data!.data.messages, ...first.messages])
      .toEqual(snapshot.transcript.map(message => ({ ...message, cards: [], toolEvents: undefined })));
    expect(third.data!.data.hasMore).toBe(false);
    expect((await loadSession(snapshot.sessionId))?.transcript).toEqual(snapshot.transcript);
  });

  it('keeps older page anchors stable when another browser appends a new turn', async () => {
    const snapshot = await savedHistory();
    const first = (await getJson<{ data: ChatHistoryPage }>(GET, path)).data!.data;
    snapshot.transcript.push({ id: 'new-turn', role: 'user', content: 'New question.', timestamp: 10 });
    await saveSession(snapshot);
    const older = await getJson<{ data: ChatHistoryPage }>(GET, `${path}?cursor=${first.nextCursor}`);
    expect(older.status).toBe(200);
    expect(older.data!.data.messages.map(message => message.id)).toEqual(snapshot.transcript.slice(5, 25).map(message => message.id));
    expect(older.data!.data.revision).toBe(snapshot.revision);
  });

  it('refuses history from a cleared conversation even after new messages have been written', async () => {
    const snapshot = await savedHistory();
    const first = (await getJson<{ data: ChatHistoryPage }>(GET, path)).data!.data;
    expect((await postJson(resetConversation, '/api/developer/chat/reset', {
      expectedRevision: snapshot.revision, confirm: true,
    }, enabled)).status).toBe(200);
    const cleared = (await loadSession(snapshot.sessionId))!;
    cleared.transcript.push({ id: 'new-history', role: 'user', content: 'Fresh conversation.', timestamp: 10 });
    await saveSession(cleared);
    expect((await getJson(GET, `${path}?cursor=${first.nextCursor}`)).status).toBe(409);
    const latest = (await getJson<{ data: ChatHistoryPage }>(GET, path)).data!.data;
    expect(latest.messages.map(message => message.id)).toEqual(['new-history']);
    expect(latest.historyGeneration).not.toBe(first.historyGeneration);
  });

  it('rejects another owner or session cursor and does not allow query identity selection', async () => {
    const snapshot = await savedHistory();
    for (const other of [{ userId: 'another-owner' }, { sessionId: 'another-session' }]) {
      const page = selectChatHistoryPage(snapshot.transcript, { userId: snapshot.userId, sessionId: snapshot.sessionId,
        revision: snapshot.revision, historyGeneration: conversationHistoryGeneration(snapshot), ...other });
      expect((await getJson(GET, `${path}?cursor=${page.nextCursor}`)).status).toBe(409);
    }
    expect((await getJson(GET, `${path}?sessionId=another-session`)).status).toBe(400);
    expect((await getJson(GET, `${path}?userId=another-owner`)).status).toBe(400);
  });

  it.each(['?cursor=malformed', '?limit=0', '?limit=21', '?limit=1.5'])('rejects invalid pagination %s', query => {
    return getJson(GET, path + query).then(result => expect(result.status).toBe(400));
  });

  it('refreshes the original message authorization state rather than returning a stale saved card', async () => {
    const snapshot = await savedHistory(1);
    snapshot.transcript[0] = { id: 'authorization-reply', role: 'assistant', content: '', timestamp: 10,
      cards: [{ type: 'mfa', actionId: 'history-action' }] };
    await saveSession(snapshot);
    await getTestPrisma().pendingAction.create({ data: {
      id: 'history-action', sessionId: snapshot.sessionId, userId: DEMO_USER_ID,
      toolName: 'freeze_card', argsJson: '{"cardId":"card_credit"}',
      summaryJson: '{"title":"Freeze card","toolName":"freeze_card","fields":[],"tier":"RED","requiresMfa":true}', riskLevel: 'RED',
      requiresMfa: true, status: 'executed', resultJson: '{"ok":true}',
    } });
    const page = (await getJson<{ data: ChatHistoryPage }>(GET, path)).data!.data;
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].cards?.[0]).toMatchObject({ type: 'mfa', actionId: 'history-action', status: 'executed' });
    expect((await loadSession(snapshot.sessionId))?.transcript[0].cards?.[0]).toEqual({ type: 'mfa', actionId: 'history-action' });
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as chatPost } from '@/app/api/chat/route';
import { getOrCreateSession, loadSession } from '@/agent';
import { getDemoSession } from '@/agent/session';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { chatUrl, postJson } from './harness';

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message: string } }
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

describe('shared demo conversation HTTP entry', () => {
  it('uses one persisted conversation for clients with absent, unknown, and foreign cookies', async () => {
    const foreign = await getOrCreateSession(DEMO_USER_ID);
    for (const cookie of [undefined, 'unknown-session', foreign.sessionId]) {
      const response = await postJson<Envelope<ChatTurnResponse>>(chatPost,
        `${chatUrl({ stream: 0 })}&userId=foreign&sessionId=${foreign.sessionId}`,
        { message: '你好' }, { sessionId: cookie });
      expect(response.status).toBe(200);
      expect(response.data!.data!.sessionId).toBe(`demo:${DEMO_USER_ID}`);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await loadSession(`demo:${DEMO_USER_ID}`))!.transcript.filter(message => message.role === 'user')).toHaveLength(3);
    expect((await loadSession(foreign.sessionId))!.transcript).toEqual([]);
    expect(await getTestPrisma().agentSession.count()).toBe(2);
  });

  it('accepts a canonical body assertion without any cookie', async () => {
    const canonical = await getDemoSession(DEMO_USER_ID);
    const response = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
      sessionId: canonical.sessionId, message: '查询我的余额',
    });
    expect(response.status).toBe(200);
    expect(response.data!.data!.sessionId).toBe(canonical.sessionId);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a foreign body assertion without altering either transcript', async () => {
    const canonical = await getDemoSession(DEMO_USER_ID);
    const foreign = await getOrCreateSession(DEMO_USER_ID);
    for (const cookie of [undefined, foreign.sessionId, canonical.sessionId]) {
      const response = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
        sessionId: foreign.sessionId, message: '查询我的余额',
      }, { sessionId: cookie });
      expect(response.status).toBe(409);
      expect(response.data!.error!.code).toBe('CONFLICT');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await loadSession(canonical.sessionId))!.transcript).toEqual([]);
    expect((await loadSession(foreign.sessionId))!.transcript).toEqual([]);
  });

  it('reuses a request ID across clients without repeating a completed run', async () => {
    const body = { message: '查询我的余额', requestId: 'demo-cross-client-retry' };
    const first = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), body);
    const replay = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), body, { sessionId: 'ignored' });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.data!.data!.events).toEqual(first.data!.data!.events);
    expect(await getTestPrisma().agentRun.count()).toBe(1);
    expect((await loadSession(`demo:${DEMO_USER_ID}`))!.transcript.filter(message => message.role === 'user')).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { executeGatedTool } from '@/agent/confirmation';
import { getDemoSession } from '@/agent/session';
import { GET as listActions } from '@/app/api/actions/route';
import { POST as confirm } from '@/app/api/actions/[id]/confirm/route';
import { BankingHttpClient } from '@/channels/weixin/banking-client';
import { WeixinBridge } from '@/channels/weixin/bridge';
import { emptyState } from '@/channels/weixin/state';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';

useFreshDatabase();
describe('WeChat sequential confirmations through banking HTTP handlers', () => {
  it('reveals subscriptions after one bare confirmation and waits for another before changing a limit', async () => {
    const db = getTestPrisma();
    const { sessionId } = await getDemoSession('user_liming');
    for (const [toolName, args] of [
      ['list_subscriptions', {}],
      ['set_card_limit', { cardId: 'card_debit', category: '购物', amount: '900.50' }],
    ] as const) {
      await executeGatedTool({ sessionId, userId: 'user_liming', toolName, args, userRequest: '先查询订阅，再把借记卡购物限额设为900.50元，每笔分别确认' });
    }
    const first = await db.pendingAction.findFirstOrThrow({ where: { sessionId, toolName: 'list_subscriptions' } });
    const second = await db.pendingAction.findFirstOrThrow({ where: { sessionId, toolName: 'set_card_limit' } });
    const events: AgentStreamEvent[] = [first, second].map(row => ({ type: 'confirmation_required', actionId: row.id,
      action: JSON.parse(row.summaryJson) as PendingActionSummary }));
    const settled: string[] = [];
    const client = new BankingHttpClient('http://localhost:3000', async (input, init) => {
      const url = String(input);
      const request = new NextRequest(url, { ...init, signal: init?.signal ?? undefined });
      if (new URL(url).pathname === '/api/actions') return listActions(request);
      if (new URL(url).pathname === '/api/chat') return Response.json({ ok: true, data: { sessionId, events } });
      const match = /\/api\/actions\/([^/]+)\/confirm$/.exec(url);
      if (!match) throw new Error('Unexpected banking route');
      settled.push(match[1]);
      return confirm(request, { params: Promise.resolve({ id: match[1] }) });
    });
    const state = emptyState();
    state.auth = { ownerId: 'owner', botId: 'bot', token: 'test-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
    const replies: string[] = [];
    const bridge = new WeixinBridge(state, client, { send: async (_to, text) => { replies.push(text); } }, async () => {});
    const send = (text: string, messageId: number) => bridge.handle({ message_id: messageId, from_user_id: 'owner', to_user_id: 'bot',
      message_type: 1, message_state: 2, context_token: 'context', item_list: [{ type: 1, text_item: { text } }] });
    await send('查询订阅后调整购物限额', 1);
    expect(replies.at(-1)).toContain('确认：/确认\n');
    expect(replies.at(-1)).not.toContain('操作编号');
    expect(state.activeActionId).toBe(first.id);
    expect(state.offered[second.id]).toBeUndefined();
    await send('/确认', 2);
    expect(settled).toEqual([first.id]);
    expect((await db.pendingAction.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('executed');
    expect((await db.pendingAction.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('pending');
    expect(state.activeActionId).toBe(second.id);
    expect(replies.at(-1)).toContain('当前待确认操作');
    await send('/确认', 3);
    expect(settled).toEqual([first.id, second.id]);
    expect((await db.cardLimit.findFirstOrThrow({ where: { cardId: 'card_debit', category: '购物' } })).amountMinor).toBe(90050n);
    expect(state.activeActionId).toBeUndefined();
    await send('/确认', 3);
    expect(settled).toHaveLength(2);
  });
});

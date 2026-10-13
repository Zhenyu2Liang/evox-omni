import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { executeGatedTool, getOrCreateSession, loadSession, runTurn } from '@/agent';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { GET as listActions } from '@/app/api/actions/route';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import { CardRenderer } from '@/components/chat/cards/CardRenderer';
import { parseBankingGuidance } from '@/agent/banking-guidance';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
const db = getTestPrisma;
function request(sessionId: string, body: object = {}) {
  return new NextRequest('http://localhost/api/actions', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` }, body: JSON.stringify(body) });
}
async function route(handler: typeof confirmPost, id: string, sessionId: string, body: object = {}) {
  const response = await handler(request(sessionId, body), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  return (await response.json()).data;
}
async function scriptedGuidance(message: string, text: string) {
  const mock = fauxProvider(); const models = createModels(); models.setProvider(mock.provider);
  mock.setResponses([fauxAssistantMessage(text)]);
  return runTurn({ message }, { provider: { model: mock.getModel(), streamFn: models.streamSimple.bind(models) } });
}

describe('multiple decisions upgrade coherently through real routes and rendered cards', () => {
  it('persists and streams the full RED summary, replaces the old card, and debits only after MFA', async () => {
    const { sessionId } = await getOrCreateSession('user_liming');
    async function park(name: string, amount: string) {
      const result = await executeGatedTool({ sessionId, userId: 'user_liming', toolName: 'transfer_money',
        args: { name, amount }, userRequest: '两笔独立转账' });
      return db().pendingAction.findUniqueOrThrow({ where: { id: result.pendingActionId! } });
    }
    const a = await park('张伟', '600.25'), b = await park('李华', '500.50');
    const aSummary = JSON.parse(a.summaryJson) as PendingActionSummary;
    const bSummary = JSON.parse(b.summaryJson) as PendingActionSummary;
    aSummary.actionId = a.id; bSummary.actionId = b.id;
    expect((await route(confirmPost, a.id, sessionId)).ok).toBe(true);
    const upgraded = await route(confirmPost, b.id, sessionId);
    expect(upgraded).toMatchObject({ status: 'awaiting_mfa', tier: 'RED', requiresMfa: true });
    const event = upgraded.events.find((e: AgentStreamEvent) => e.type === 'mfa_required');
    expect(event.action).toMatchObject({ actionId: b.id, tier: 'RED', requiresMfa: true, amount: '500.50' });
    expect(event.action.fields).toContainEqual({ label: '收款人', value: '李华' });
    expect(event.action.fields).toContainEqual({ label: '风险等级', value: '🔴 红色' });
    const stored = await db().pendingAction.findUniqueOrThrow({ where: { id: b.id } });
    expect(JSON.parse(stored.summaryJson)).toMatchObject(event.action);
    // Even when the primary decision was cleared after deciding another action, inline B keeps its identity.
    const state = reduceAgentEvents(initialChatUIState({ messages: [{ id: 'cards', role: 'assistant',
      content: '', timestamp: 0, cards: [{ type: 'confirmation', action: aSummary }, { type: 'confirmation', action: bSummary }] }] }),
      upgraded.events);
    expect(state.pendingAction).toMatchObject({ actionId: b.id, kind: 'mfa', summary: event.action });
    const cards = state.messages.find(m => m.id === 'cards')!.cards!;
    expect(cards[0]).toMatchObject({ type: 'confirmation', action: { actionId: a.id } });
    expect(cards[1]).toMatchObject({ type: 'mfa', actionId: b.id, action: event.action });
    const html = renderToStaticMarkup(createElement(CardRenderer, { card: cards[1] }));
    expect(html).toContain('李华'); expect(html).toContain('¥500.50'); expect(html).toContain('🔴 红色');
    expect(html).not.toContain('🟡 黄色'); expect(html).not.toMatch(/>确认<\/button>/);
    expect((await route(verifyPost, b.id, sessionId, { code: '000000' })).ok).toBe(false);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2297975n);
    expect((await route(verifyPost, b.id, sessionId, { code: '123456' })).ok).toBe(true);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2247925n);
    expect(await db().transaction.count({ where: { amountMinor: -50050n, channel: 'TRANSFER' } })).toBe(1);
  });
  it('refreshes the action card after a persisted policy escalation', async () => {
    const { sessionId } = await getOrCreateSession('user_liming');
    const action = await executeGatedTool({ sessionId, userId: 'user_liming', toolName: 'transfer_money',
      args: { name: '李华', amount: '500.50' }, userRequest: '历史升级操作' });
    await db().pendingAction.update({ where: { id: action.pendingActionId! }, data: { riskLevel: 'RED', requiresMfa: true, status: 'awaiting_mfa' } });
    const response = await listActions(new NextRequest('http://localhost/api/actions', { headers: { cookie: `banking_session=${sessionId}` } }));
    const restored = (await response.json()).data[0];
    expect(restored.summary).toMatchObject({ actionId: action.pendingActionId, tier: 'RED', requiresMfa: true });
    expect(restored.summary.fields).toContainEqual({ label: '风险等级', value: '🔴 红色' });
  });
  it('an incremental MFA escalation preserves the current action details', () => {
    const summary: PendingActionSummary = { actionId: 'b', title: '转账', toolName: 'transfer_money',
      tier: 'YELLOW', requiresMfa: false, fields: [{ label: '金额', value: '¥500.50' }, { label: '风险等级', value: '🟡 黄色' }] };
    const state = reduceAgentEvents(initialChatUIState({ messages: [{ id: 'b', role: 'assistant', content: '', timestamp: 0,
      cards: [{ type: 'confirmation', action: summary }] }] }), [{ type: 'mfa_required', actionId: 'b' }]);
    expect(state.pendingAction?.summary.fields).toContainEqual({ label: '金额', value: '¥500.50' });
    expect(state.messages[0].cards?.[0].type).toBe('mfa');
  });
});

describe('structured guidance survives Pi/SSE/session persistence without financial prose', () => {
  it.each([
    ['我只想从稳健理财B赎回1000元，不要全额赎回。', 'partial_redemption_unsupported', '不支持部分赎回'],
    ['用储蓄账户申购稳健理财A 1000.66元，不要用活期。', 'investment_funding_account_unsupported', '不能使用储蓄账户'],
    ['把信用卡总授信额度提高到25000元。', 'credit_line_adjustment_unsupported', '不支持修改信用卡总授信额度'],
  ])('discloses the actual capability boundary for %s', async (message, code, expected) => {
    const response = await scriptedGuidance(message, JSON.stringify({ guidance: { code } }));
    const final = response.events.filter(e => e.type === 'message_end').at(-1)!;
    if (final.type !== 'message_end') throw new Error('missing output');
    expect(final.message.content).toContain(expected);
    expect(final.message.content).not.toContain('请说明产品名称');
    expect(response.events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe(final.message.content);
    const stored = await loadSession(response.sessionId);
    expect(stored?.transcript.at(-1)?.content).toBe(final.message.content);
    expect(JSON.stringify(stored?.agentState.messages)).toContain(expected);
    expect(await db().pendingAction.count()).toBe(0);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });
  it('asks only for the missing amount, without asking again for the already-specified product', async () => {
    const response = await scriptedGuidance('申购稳健理财A', '{"guidance":{"code":"missing_details","fields":["product","amount"]}}');
    expect(JSON.stringify(response.events)).toContain('请补充金额');
    expect(JSON.stringify(response.events)).not.toContain('请说明产品名称');
    expect(JSON.stringify(response.events)).not.toContain('请补充理财产品');
  });
  it('accepts a harmless declared field list and JSON fence on a capability code', async () => {
    const response = await scriptedGuidance('稳健理财B只赎回1000元', '```json\n{"guidance":{"code":"partial_redemption_unsupported","fields":["holding"]}}\n```');
    expect(JSON.stringify(response.events)).toContain('不支持部分赎回');
    expect(JSON.stringify(response.events)).not.toContain('请补充');
    expect(await db().pendingAction.count()).toBe(0);
  });
  it.each([
    '{"guidance":{"code":"transfer_succeeded"}}',
    '{"guidance":{"code":"missing_details","fields":["余额999999"]}}',
    '{"guidance":{"code":"capabilities","balance":999999}}',
    '{"guidance":{"code":"capabilities"},"result":"转账成功30000"}',
  ])('rejects forged status, amounts and arbitrary text in guidance: %s', async text => {
    expect(parseBankingGuidance(text)).toBeUndefined();
    const result = await scriptedGuidance('查询余额', text);
    const output = result.events.filter(e => e.type === 'message_end');
    expect(JSON.stringify(output)).not.toContain('999999'); expect(JSON.stringify(output)).not.toContain('30000');
    expect(await db().pendingAction.count()).toBe(0);
  });
  it('default mock follows the same guidance protocol rather than requesting a full redemption', async () => {
    const result = await runTurn({ message: '稳健理财B我只赎回1000元，剩下继续持有。' });
    expect(JSON.stringify(result.events)).toContain('不支持部分赎回');
    expect(await db().pendingAction.count()).toBe(0);
  });
  it('mock keeps the specified product across a structured missing-amount clarification', async () => {
    const start = await runTurn({ message: '申购稳健理财A' });
    expect(JSON.stringify(start.events)).toContain('请补充金额');
    expect(await db().pendingAction.count()).toBe(0);
    await runTurn({ sessionId: start.sessionId, message: '1000.66元' });
    const action = await db().pendingAction.findFirstOrThrow({ where: { sessionId: start.sessionId } });
    expect(action).toMatchObject({ toolName: 'subscribe_investment', status: 'awaiting_mfa', riskLevel: 'RED' });
    expect(JSON.parse(action.argsJson)).toMatchObject({ productId: 'prod_wenjiana', amount: '1000.66' });
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });
  it('a malformed model response cannot make the fallback invent missing product or amount', async () => {
    const response = await scriptedGuidance('稳健理财B只赎回1000元', '抱歉，请提供产品名称和金额，已收到30000元');
    const final = response.events.filter(e => e.type === 'message_end').at(-1)!;
    if (final.type !== 'message_end') throw new Error('missing output');
    expect(final.message.content).toContain('不支持部分赎回');
    expect(final.message.content).not.toContain('请提供产品名称');
    expect(final.message.content).not.toContain('30000');
    expect(await db().pendingAction.count()).toBe(0);
  });
  it('filters explicitly provided amount but does not guess a product or approve the operation', async () => {
    const response = await scriptedGuidance('申购1000.66元', '{"guidance":{"code":"missing_details","fields":["product","amount"]}}');
    expect(JSON.stringify(response.events)).toContain('请补充理财产品');
    expect(JSON.stringify(response.events)).not.toContain('请补充金额');
    expect(await db().pendingAction.count()).toBe(0);
  });
});

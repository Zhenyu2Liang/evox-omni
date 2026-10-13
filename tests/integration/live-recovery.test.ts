import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { runTurn, resumeTurn, loadSession, confirmAction } from '@/agent';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import type { AppConfig } from '@/lib/config';
import { ACCOUNTS } from '@/tests/helpers/fixtures';

const config: AppConfig = { llmMode: 'live', llmProvider: 'deepseek', llmModel: 'deepseek-flash', demoUserId: 'user_liming' };
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
function provider(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(responses);
  let calls = 0;
  return { model: faux.getModel(), streamFn: (...args: Parameters<typeof models.streamSimple>) => {
    calls++; return models.streamSimple(...args);
  }, calls: () => calls };
}
const transfer = () => fauxAssistantMessage([fauxToolCall('transfer_money', { name: '张伟', amount: '200.37' })], { stopReason: 'toolUse' });
const text = (result: Awaited<ReturnType<typeof runTurn>>) => result.events.flatMap(e => e.type === 'message_end' ? [e.message.content] : []).join('\n');

describe('live planning recovery [integration: real Pi, gateway and database; scripted transport]', () => {
  it('repairs prose-only planning without adding another user request or moving money', async () => {
    const runtime = provider([fauxAssistantMessage('I can help, please confirm.'), transfer(), fauxAssistantMessage('Waiting.')]);
    const result = await runTurn({ message: '给张伟转账200.37元' }, { config, provider: runtime });
    expect(result.events.some(e => e.type === 'confirmation_required')).toBe(true);
    expect(await getTestPrisma().pendingAction.count()).toBe(1);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNTS[0].id } })).balanceMinor).toBe(2358000n);
    const saved = await loadSession(result.sessionId);
    expect(saved?.transcript.filter(m => m.role === 'user')).toHaveLength(1);
    expect(text(result)).not.toContain('请明确要办理的受支持业务');
  });
  it('exposes confirmation without requesting model narration; never replays the transfer', async () => {
    const runtime = provider([transfer(), fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Request timed out.' })]);
    const result = await runTurn({ message: '给张伟转账200.37元' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(1);
    expect(await getTestPrisma().pendingAction.count()).toBe(1);
    expect(text(result)).toContain('等待确认');
    expect(result.events.some(e => e.type === 'confirmation_required')).toBe(true);
    expect(result.events.filter(e => e.type === 'message_end').at(-1)).not.toHaveProperty('message.retryRequest');
  });
  it('renders a confirmed live result without making another model request', async () => {
    const runtime = provider([transfer(), fauxAssistantMessage('Waiting.')]);
    const result = await runTurn({ message: '给张伟转账200.37元' }, { config, provider: runtime });
    const before = runtime.calls();
    const outcome = await resumeTurn({ sessionId: result.sessionId, toolName: 'transfer_money', resultToolName: 'transfer_money',
      toolResult: { ok: true, summary: 'Verified server result', data: { amount: '200.37', newBalance: '23379.63' } } }, { config, provider: runtime });
    expect(runtime.calls()).toBe(before);
    expect(text(outcome)).toContain('23,379.63');
    expect(outcome.events.some(e => e.type === 'error')).toBe(false);
    expect((await loadSession(result.sessionId))?.transcript.at(-1)?.content).toBe(text(outcome));
  });
  it('recovers a transient planning timeout once and parks exactly one transfer', async () => {
    const runtime = provider([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Request timed out.' }), transfer()]);
    const result = await runTurn({ message: '给张伟转账200.37元' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    expect(await getTestPrisma().pendingAction.count()).toBe(1);
    expect(result.events.some(e => e.type === 'error')).toBe(false);
    expect(text(result)).toContain('等待确认');
    expect((await loadSession(result.sessionId))?.agentState.messages.filter(m => m.role === 'user')).toHaveLength(1);
  });
  it('exhausts recovery with an explicit persisted retry option, without financial effects', async () => {
    const runtime = provider(Array.from({ length: 2 }, () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Request timed out.' })));
    const request = '给张伟转账200.37元';
    const result = await runTurn({ message: request }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    expect(text(result)).toContain('已停止自动重试');
    const final = result.events.filter(e => e.type === 'message_end').at(-1)!;
    expect(final).toHaveProperty('message.retryRequest', request);
    expect((await loadSession(result.sessionId))?.transcript.at(-1)).toEqual(final.type === 'message_end' ? final.message : null);
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().agentTask.count()).toBe(0);
  });
  it('does not loop indefinitely when the model repeatedly returns prose', async () => {
    const runtime = provider([fauxAssistantMessage('Please confirm.'), fauxAssistantMessage('Please confirm again.')]);
    const result = await runTurn({ message: '给张伟转账200.37元' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    expect(text(result)).toContain('模型未完成业务规划');
    expect(text(result)).not.toContain('请明确要办理的受支持业务');
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });
  it('retains lookup/tool-result pairs when recovering a timeout between lookup and planning', async () => {
    const runtime = provider([fauxAssistantMessage([fauxToolCall('search_contact', { query: '张伟' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 temporary outage' }), transfer()]);
    const result = await runTurn({ message: '给张伟转账200.37元' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(3);
    expect(await getTestPrisma().pendingAction.count()).toBe(1);
    expect(result.events.some(e => e.type === 'error')).toBe(false);
    const messages = (await loadSession(result.sessionId))!.agentState.messages;
    expect(messages.filter(m => m.role === 'toolResult')).toHaveLength(2);
    expect(messages.filter(m => m.role === 'user')).toHaveLength(1);
  });
  it('keeps an already completed balance query instead of querying again after narration timeout', async () => {
    const runtime = provider([fauxAssistantMessage([fauxToolCall('get_balance', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Request timed out.' })]);
    const result = await runTurn({ message: '查询我的余额' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    expect(text(result)).toContain('23,580.00');
    expect(text(result)).toContain('已取得的查询结果已保留');
    expect(result.events.filter(e => e.type === 'message_end').at(-1)).not.toHaveProperty('message.retryRequest');
  });
  it('retains a committed automatic budget and refuses to replay after narration times out', async () => {
    const runtime = provider([fauxAssistantMessage([fauxToolCall('reserve_budget', { name: 'live-interruption', amount: '66.66' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Request timed out.' })]);
    const result = await runTurn({ message: '预留66.66元作为live-interruption预算' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    expect(await getTestPrisma().budget.count({ where: { name: 'live-interruption' } })).toBe(1);
    expect(text(result)).toContain('执行成功');
    expect(text(result)).toContain('请勿重复办理');
    expect(result.events.filter(e => e.type === 'message_end').at(-1)).not.toHaveProperty('message.retryRequest');
  });
  it.each(['missing_details', 'ambiguous_selection'])('honors valid %s guidance without another planning attempt', async code => {
    const runtime = provider([fauxAssistantMessage(JSON.stringify({ guidance: { code, fields: ['amount'] } }))]);
    const result = await runTurn({ message: '给张伟转账' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(1);
    expect(text(result)).toContain('金额');
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });
  it('honors catalogue-based refusal even if the live model only returns prose', async () => {
    const runtime = provider([fauxAssistantMessage('Please choose this other product.')]);
    const result = await runTurn({ message: '申购货币基金增强D1000.13元' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(1);
    expect(text(result)).toContain('未找到你指定的理财产品');
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });
  it('does not retry invalid credentials or expose raw provider details', async () => {
    const runtime = provider([fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 Authentication failed: private-provider-detail' })]);
    const result = await runTurn({ message: '给张伟转账200.37元' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(1);
    expect(text(result)).toContain('认证配置异常');
    expect(JSON.stringify(result)).not.toContain('private-provider-detail');
    expect(result.events.filter(e => e.type === 'message_end').at(-1)).not.toHaveProperty('message.retryRequest');
  });
  it('confirms a real transfer once with no narration HTTP request and valid saved message pairs', async () => {
    const runtime = provider([transfer()]);
    const parked = await runTurn({ message: '给张伟转账200.37元' }, { config, provider: runtime });
    const action = await getTestPrisma().pendingAction.findFirstOrThrow();
    const outcome = await confirmAction(action.id, { deps: { config, provider: runtime } });
    expect(outcome.ok).toBe(true);
    expect(runtime.calls()).toBe(1);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNTS[0].id } })).balanceMinor).toBe(2337963n);
    const saved = await loadSession(parked.sessionId);
    expect(saved?.transcript.at(-1)?.content).toContain('23,379.63');
    const calls = new Set(saved?.agentState.messages.flatMap(m => m.role === 'assistant' ? m.content.filter(p => p.type === 'toolCall').map(p => p.type === 'toolCall' ? p.id : '') : []));
    const results = saved?.agentState.messages.filter(m => m.role === 'toolResult');
    expect(results).toHaveLength(1);
    expect(results?.every(m => m.role === 'toolResult' && calls.has(m.toolCallId))).toBe(true);
    await confirmAction(action.id, { deps: { config, provider: runtime } });
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNTS[0].id } })).balanceMinor).toBe(2337963n);
  });
});

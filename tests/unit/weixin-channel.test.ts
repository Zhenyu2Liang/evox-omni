import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeixinMessage } from 'pi-weixinbot/src/types.ts';
import { WeixinBridge } from '../../channels/weixin/bridge';
import { BankingHttpClient, renderEvents, type BankingChannel } from '../../channels/weixin/banking-client';
import { WeixinStore, emptyState } from '../../channels/weixin/state';
import { bankingBaseUrl, weixinBaseUrl } from '../../channels/weixin/config';
import type { AgentStreamEvent } from '../../lib/contracts/agent';
import type { PendingActionSummary } from '../../lib/contracts/security';

const summary: PendingActionSummary = { title: '转账', toolName: 'transfer_money', tier: 'RED', requiresMfa: true,
  fields: [{ label: '收款人', value: '张伟' }, { label: '金额', value: '¥2,000.37' }] };
const gate: AgentStreamEvent = { type: 'confirmation_required', actionId: 'action_one', action: summary };
const pendingAction = (id: string, status: 'pending' | 'awaiting_mfa' = 'pending'): Awaited<ReturnType<BankingChannel['actions']>>[number] => ({
  id, sessionId: 'demo:user', toolName: 'transfer_money', args: {}, tier: 'RED', requiresMfa: true,
  status, summary, createdAt: 1, updatedAt: 1,
});
function fixture() {
  const state = emptyState();
  state.auth = { botId: 'bot', ownerId: 'owner', token: 'test-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
  const bank = { chat: vi.fn<BankingChannel['chat']>().mockResolvedValue({ sessionId: 'demo:user', events: [gate] }),
    actions: vi.fn<BankingChannel['actions']>().mockResolvedValue([pendingAction('action_one')]),
    settle: vi.fn<BankingChannel['settle']>().mockResolvedValue({ actionId: 'action_one', ok: false, status: 'awaiting_mfa', events: [] }),
    plans: vi.fn<BankingChannel['plans']>().mockResolvedValue([]),
    plan: vi.fn<BankingChannel['plan']>(), controlPlan: vi.fn<BankingChannel['controlPlan']>(),
    schedules: vi.fn<BankingChannel['schedules']>().mockResolvedValue({ tasks: [], notifications: [] }),
    tickSchedules: vi.fn<BankingChannel['tickSchedules']>().mockResolvedValue({ evaluatedAt: 0, dispatches: [] }),
  };
  const sender = { send: vi.fn().mockResolvedValue(undefined) };
  const save = vi.fn().mockResolvedValue(undefined);
  const bridge = new WeixinBridge(state, bank, sender, save);
  const message = (text: string, id: number | string = 1): WeixinMessage => ({ message_id: id,
    from_user_id: 'owner', to_user_id: 'bot', context_token: 'context', message_type: 1, message_state: 2,
    item_list: [{ type: 1, text_item: { text } }] });
  return { state, bank, sender, save, bridge, message };
}

describe('微信通道边界与授权', () => {
  it('bare slash confirmation resolves the only currently pending shown action and still requires MFA', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    f.bank.actions.mockResolvedValue([pendingAction('action_one')]);
    await f.bridge.handle(f.message('/确认', 2));
    expect(f.bank.settle).toHaveBeenCalledExactlyOnceWith('action_one', 'confirm', undefined);
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('/验证 六位验证码');
    await f.bridge.handle(f.message('/验证 246810', 3));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'verify', '246810');
    expect(f.bank.chat).toHaveBeenCalledTimes(1);
  });
  it('confirms multiple decisions one at a time and waits for MFA before showing the next', async () => {
    const f = fixture();
    f.bank.actions.mockResolvedValue([pendingAction('action_one'), { ...pendingAction('action_two'), summary: { ...summary, title: '第二笔操作' } }]);
    await f.bridge.handle(f.message('转账'));
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('还有 1 笔待处理');
    expect(f.sender.send.mock.calls.at(-1)?.[1]).not.toContain('第二笔操作');
    await f.bridge.handle(f.message('/确认', 2));
    expect(f.bank.settle).toHaveBeenCalledExactlyOnceWith('action_one', 'confirm', undefined);
    expect(f.state.activeActionId).toBe('action_one');
    await f.bridge.handle(f.message('/确认', 3));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'confirm', undefined);
    f.bank.actions.mockResolvedValueOnce([pendingAction('action_one', 'awaiting_mfa'), pendingAction('action_two')]);
    f.bank.actions.mockResolvedValue([{ ...pendingAction('action_two'), summary: { ...summary, title: '第二笔操作' } }]);
    f.bank.settle.mockResolvedValueOnce({ actionId: 'action_one', ok: true, status: 'executed', events: [] });
    await f.bridge.handle(f.message('/验证 246810', 4));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'verify', '246810');
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('第二笔操作');
    expect(f.state.activeActionId).toBe('action_two');
    await f.bridge.handle(f.message('/确认', 5));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_two', 'confirm', undefined);
  });
  it.each(['/确认', '/取消', '/验证 246810'])('does not redirect %s to a new action when the displayed one was settled on the web', async command => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    f.bank.actions.mockResolvedValue([pendingAction('replacement')]);
    await f.bridge.handle(f.message(command, 2));
    expect(f.bank.settle).not.toHaveBeenCalled();
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('请先核对');
    expect(f.state.activeActionId).toBe('replacement');
  });
  it('shows a subscription confirmation without an ID and advances only after one explicit confirmation', async () => {
    const f = fixture();
    const subscription = { ...pendingAction('subscription'), toolName: 'list_subscriptions' as const, tier: 'YELLOW' as const, requiresMfa: false,
      summary: { title: 'Read active subscriptions.', toolName: 'list_subscriptions' as const, tier: 'YELLOW' as const, requiresMfa: false, fields: [] } };
    f.bank.actions.mockResolvedValue([subscription, pendingAction('later')]);
    f.bank.chat.mockResolvedValue({ sessionId: 'demo:user', events: [{ type: 'confirmation_required', actionId: subscription.id, action: subscription.summary }] });
    await f.bridge.handle(f.message('查询订阅'));
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('查询当前有效订阅。');
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('确认：/确认\n');
    expect(f.sender.send.mock.calls.at(-1)?.[1]).not.toContain('操作编号');
    expect(f.state.offered.later).toBeUndefined();
    f.bank.actions.mockResolvedValueOnce([subscription, pendingAction('later')]);
    f.bank.actions.mockResolvedValue([pendingAction('later')]);
    f.bank.settle.mockResolvedValue({ actionId: subscription.id, ok: true, status: 'executed', events: [
      { type: 'message_end', message: { id: 'subscriptions', role: 'assistant', content: '当前有 3 项订阅。', timestamp: 1 } },
    ] });
    await f.bridge.handle(f.message('/确认', 2));
    expect(f.bank.settle).toHaveBeenCalledExactlyOnceWith('subscription', 'confirm', undefined);
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('当前有 3 项订阅。');
    expect(f.state.activeActionId).toBe('later');
    expect(f.bank.chat).toHaveBeenCalledTimes(1);
  });
  it('keeps a canceled operation separate from the next confirmation', async () => {
    const f = fixture(); f.bank.actions.mockResolvedValue([pendingAction('action_one'), pendingAction('later')]);
    await f.bridge.handle(f.message('两笔操作'));
    f.bank.actions.mockResolvedValueOnce([pendingAction('action_one'), pendingAction('later')]);
    f.bank.actions.mockResolvedValue([pendingAction('later')]);
    f.bank.settle.mockResolvedValueOnce({ actionId: 'action_one', ok: true, status: 'cancelled', events: [] });
    await f.bridge.handle(f.message('/取消', 2));
    expect(f.bank.settle).toHaveBeenCalledExactlyOnceWith('action_one', 'cancel', undefined);
    expect(f.state.activeActionId).toBe('later');
    await f.bridge.handle(f.message('/确认', 3));
    expect(f.bank.settle).toHaveBeenLastCalledWith('later', 'confirm', undefined);
  });
  it('requires confirmation before a number-free OTP and never stores or echoes the OTP', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    await f.bridge.handle(f.message('/验证 246810', 2));
    expect(f.bank.settle).not.toHaveBeenCalled();
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toBe('请先发送 /确认，再发送 /验证 六位验证码。');
    await f.bridge.handle(f.message('/确认', 3));
    await f.bridge.handle(f.message('/验证 246810', 4));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'verify', '246810');
    expect(JSON.stringify(f.state)).not.toContain('246810');
  });
  it('preserves the exact current action and queue across a persisted restart', async () => {
    const f = fixture(); f.bank.actions.mockResolvedValue([pendingAction('action_one'), pendingAction('later')]);
    await f.bridge.handle(f.message('两笔操作'));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'weixin-confirmation-queue-'));
    try {
      const store = new WeixinStore(directory); await store.save(f.state);
      const restored = await store.load();
      const bridge = new WeixinBridge(restored, f.bank, f.sender, () => store.save(restored));
      await bridge.handle(f.message('/确认', 2));
      expect(f.bank.settle).toHaveBeenCalledExactlyOnceWith('action_one', 'confirm', undefined);
      expect(restored.activeActionId).toBe('action_one');
      expect(restored.confirmationQueue).toEqual(['action_one', 'later']);
      expect(restored.offered.later).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps the completed receipt if reading the next decision fails', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    f.bank.settle.mockResolvedValue({ actionId: 'action_one', ok: true, status: 'executed', events: [] });
    f.bank.actions.mockRejectedValue(new Error('network'));
    await f.bridge.handle(f.message('/确认 1', 2));
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('状态：已执行');
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('请发送 /待办');
    expect(f.sender.send.mock.calls.at(-1)?.[1]).not.toContain('银行请求结果暂时无法确认');
  });
  it('shows an unseen sole decision before accepting a subsequent bare slash confirmation', async () => {
    const f = fixture(); f.bank.actions.mockResolvedValue([pendingAction('unseen')]);
    await f.bridge.handle(f.message('/确认'));
    expect(f.bank.settle).not.toHaveBeenCalled();
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('请先核对');
    await f.bridge.handle(f.message('/确认', 2));
    expect(f.bank.settle).toHaveBeenCalledExactlyOnceWith('unseen', 'confirm', undefined);
  });
  it('never confirms a cached terminal action, and excludes non-decision attention records', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    f.bank.actions.mockResolvedValue([{ ...pendingAction('action_one'), status: 'locked' },
      { ...pendingAction('recover'), attention: 'recoverable' }]);
    await f.bridge.handle(f.message('/确认', 2));
    expect(f.bank.settle).not.toHaveBeenCalled();
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toBe('当前没有待确认的操作。');
  });
  it('does not fall back to cached decisions if current state cannot be read', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    f.bank.actions.mockRejectedValue(new Error('network'));
    await f.bridge.handle(f.message('/确认', 2));
    expect(f.bank.settle).not.toHaveBeenCalled();
    expect(f.bank.chat).toHaveBeenCalledTimes(1);
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('暂时无法确认');
  });
  it('deduplicates replayed bare confirmation messages without confirming the next workflow action', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    f.bank.actions.mockResolvedValue([pendingAction('action_one')]);
    await f.bridge.handle(f.message('/确认', 2));
    f.bank.actions.mockResolvedValue([pendingAction('next_action')]);
    await f.bridge.handle(f.message('/确认', 2));
    expect(f.bank.settle).toHaveBeenCalledTimes(1);
    expect(f.bank.actions).toHaveBeenCalledTimes(2);
  });
  it('short commands settle the original exact action and preserve the MFA prerequisite', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    expect(f.sender.send.mock.calls[0][1]).toContain('确认：/确认\n');
    await f.bridge.handle(f.message('/验证 1 246810', 2));
    expect(f.bank.settle).not.toHaveBeenCalled();
    await f.bridge.handle(f.message('/确认 1', 3));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'confirm', undefined);
    await f.bridge.handle(f.message('/验证 1 246810', 4));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'verify', '246810');
    expect(JSON.stringify(f.state)).not.toContain('246810');
  });
  it('keeps independent references for multiple pending actions instead of choosing the newest', async () => {
    const f = fixture();
    f.bank.chat.mockResolvedValue({ sessionId: 'demo:user', events: [gate,
      { type: 'confirmation_required', actionId: 'action_two', action: { ...summary, fields: [{ label: '收款人', value: '妈妈' }] } }] });
    f.bank.actions.mockResolvedValue([pendingAction('action_one'), pendingAction('action_two')]);
    await f.bridge.handle(f.message('两笔操作'));
    expect(f.state.offered.action_two).toBeUndefined();
    f.bank.settle.mockResolvedValueOnce({ actionId: 'action_one', ok: true, status: 'cancelled', events: [] });
    f.bank.actions.mockResolvedValue([pendingAction('action_two')]);
    await f.bridge.handle(f.message('/取消 1', 2));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'cancel', undefined);
    await f.bridge.handle(f.message('/确认 2', 3));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_two', 'confirm', undefined);
    const count = f.bank.settle.mock.calls.length;
    await f.bridge.handle(f.message('/确认 3', 4));
    expect(f.bank.settle).toHaveBeenCalledTimes(count);
  });
  it('offers the next workflow decision returned by settlement with a new short number', async () => {
    const f = fixture(); await f.bridge.handle(f.message('多步任务'));
    f.bank.settle.mockResolvedValue({ actionId: 'action_one', ok: true, status: 'executed', events: [
      { type: 'action_settled', actionId: 'action_one', status: 'executed' },
      { type: 'confirmation_required', actionId: 'next_action', action: summary },
    ] });
    f.bank.actions.mockResolvedValue([pendingAction('next_action')]);
    await f.bridge.handle(f.message('/确认 1', 2));
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('确认：/确认\n');
    expect(f.state.offered.next_action).toMatchObject({ confirmed: false, shortId: 2 });
    await f.bridge.handle(f.message('/确认 2', 3));
    expect(f.bank.settle).toHaveBeenLastCalledWith('next_action', 'confirm', undefined);
  });
  it('does not append a failure message to a completed or canceled result with no prose message', async () => {
    for (const status of ['executed', 'cancelled'] as const) {
      const f = fixture(); await f.bridge.handle(f.message('转账'));
      f.bank.settle.mockResolvedValue({ actionId: 'action_one', ok: true, status, events: [] });
      await f.bridge.handle(f.message('/确认 action_one', 2));
      const reply = f.sender.send.mock.calls.at(-1)?.[1];
      expect(reply).toContain(status === 'executed' ? '已执行' : '已取消');
      expect(reply).not.toContain('操作未完成');
      expect(reply).not.toContain('继续验证');
    }
  });
  it('prompts for verification without a false failure when the server omits its prose message', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    await f.bridge.handle(f.message('/确认 action_one', 2));
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('/验证 六位验证码');
    expect(f.sender.send.mock.calls.at(-1)?.[1]).not.toContain('操作未完成');
    expect(f.state.offered.action_one.confirmed).toBe(true);
  });
  it('resumes saved message parts without rerunning banking or resending the first part', async () => {
    const f = fixture();
    const text = ('业务说明\n' + '说明'.repeat(600) + '\n\n').repeat(3) + '/确认 action_one';
    f.bank.chat.mockResolvedValue({ sessionId: 'demo:user', events: [
      { type: 'message_end', message: { id: 'long', role: 'assistant', content: text, timestamp: 1 } },
    ] });
    f.sender.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'));
    await expect(f.bridge.handle(f.message('长消息'))).rejects.toThrow('offline');
    expect(Object.values(f.state.deliveries)[0].sent).toBe(1);
    await f.bridge.handle(f.message('长消息'));
    expect(f.bank.chat).toHaveBeenCalledOnce();
    const calls = f.sender.send.mock.calls;
    expect(calls[1][2]).toBe(calls[2][2]);
    expect([calls[0][1], ...calls.slice(2).map(call => call[1])].join('')).toBe(text);
    expect(calls.some(call => call[1].includes('/确认 action_one'))).toBe(true);
  });
  it('keeps server English diagnostics out of the public API error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: false,
      error: { code: 'VALIDATION', message: 'Internal schema detail at private/secret.ts:42' } }), { status: 400 }));
    const client = new BankingHttpClient('http://127.0.0.1:3000', fetcher);
    await expect(client.chat('查询', 'request')).rejects.toThrow('业务信息未通过检查');
  });
  it.each([
    { from_user_id: 'stranger' }, { group_id: 'group' }, { message_type: 2 },
    { message_state: 1 }, { context_token: '' }, { to_user_id: 'other-bot' }, { message_id: undefined },
    { message_id: Number.MAX_SAFE_INTEGER + 1 }, { item_list: [{ type: 1, is_completed: false }] },
  ])('丢弃非受信或不完整消息：%j', async patch => {
    const f = fixture(); expect(await f.bridge.handle({ ...f.message('查余额'), ...patch })).toBe(false);
    expect(f.bank.chat).not.toHaveBeenCalled(); expect(f.sender.send).not.toHaveBeenCalled();
  });
  it('接受协议中省略 message_state 的完整文字和无损 uint64 ID', async () => {
    const f = fixture(); const msg = { ...f.message('查余额', '18446744073709551610'), message_state: undefined };
    expect(await f.bridge.handle(msg)).toBe(true); expect(f.bank.chat).toHaveBeenCalledOnce();
  });
  it('只发送核验后的最终文本，附真实操作详情及显式命令', async () => {
    const f = fixture(); f.bank.chat.mockResolvedValue({ sessionId: 'demo:user', events: [
      { type: 'text_delta', delta: '余额999999' },
      { type: 'message_end', message: { id: 'm', role: 'assistant', content: '余额23580', timestamp: 0 } }, gate] });
    await f.bridge.handle(f.message('转账2000.37给张伟'));
    const reply = f.sender.send.mock.calls[0][1];
    expect(reply).toContain('余额23580'); expect(reply).not.toContain('999999');
    expect(reply).toContain('张伟'); expect(reply).toContain('¥2,000.37'); expect(reply).toContain('确认：/确认\n');
    expect(f.bank.settle).not.toHaveBeenCalled();
  });
  it('相同消息重复投递/重启不再进入模型或重复发回复', async () => {
    const f = fixture(); await f.bridge.handle(f.message('查余额'));
    const restored = new WeixinBridge(structuredClone(f.state), f.bank, f.sender, f.save);
    await restored.handle(f.message('查余额'));
    expect(f.bank.chat).toHaveBeenCalledOnce(); expect(f.sender.send).toHaveBeenCalledOnce();
    expect(f.bank.chat.mock.calls[0][1]).toMatch(/^weixin:[a-f0-9]{64}$/);
  });
  it('发送失败保留 outbox，重投只重发相同 clientId，不重做业务', async () => {
    const f = fixture(); f.sender.send.mockRejectedValueOnce(new Error('offline'));
    await expect(f.bridge.handle(f.message('查余额'))).rejects.toThrow('offline');
    await f.bridge.handle(f.message('查余额'));
    expect(f.bank.chat).toHaveBeenCalledOnce(); expect(f.sender.send.mock.calls[0][2]).toBe(f.sender.send.mock.calls[1][2]);
  });
  it('普通聊天确认没有结算权限，未知操作编号也不能验证', async () => {
    const f = fixture(); await f.bridge.handle(f.message('确认')); await f.bridge.handle(f.message('/验证 other 123456', 2));
    expect(f.bank.settle).not.toHaveBeenCalled();
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('不是本通道');
  });
  it('RED 必须先显式确认再提交验证码，验证码不写入通道状态', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    await f.bridge.handle(f.message('/验证 action_one 246810', 2)); expect(f.bank.settle).not.toHaveBeenCalled();
    await f.bridge.handle(f.message('/确认 action_one', 3));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'confirm', undefined);
    await f.bridge.handle(f.message('/验证 action_one 246810', 4));
    expect(f.bank.settle).toHaveBeenLastCalledWith('action_one', 'verify', '246810');
    expect(JSON.stringify(f.state)).not.toContain('246810');
  });
  it('错误码/熔断只回传服务端失败状态，不伪造成功', async () => {
    const f = fixture(); await f.bridge.handle(f.message('转账'));
    f.state.offered.action_one.confirmed = true;
    f.bank.settle.mockResolvedValue({ actionId: 'action_one', ok: false, status: 'locked', message: '验证失败，操作已锁定。', events: [] });
    await f.bridge.handle(f.message('/验证 action_one 000000', 2));
    expect(f.sender.send.mock.calls.at(-1)?.[1]).toContain('已锁定');
    expect(f.sender.send.mock.calls.at(-1)?.[1]).not.toContain('状态：executed');
  });
  it('银行超时结果未知，不声称未扣款或成功', async () => {
    const f = fixture(); f.bank.chat.mockRejectedValue(new Error('network'));
    await f.bridge.handle(f.message('转账'));
    expect(f.sender.send.mock.calls[0][1]).toContain('暂时无法确认');
    expect(f.sender.send.mock.calls[0][1]).not.toContain('尚未扣款');
  });
  it('重复最终事件合并，已结算的 gate 不再作为待办发送', () => {
    expect(renderEvents([gate, { type: 'action_settled', actionId: 'action_one', status: 'executed' }]).actionIds).toEqual([]);
  });
  it('HTTP 客户端仅访问本机接口并使用原授权路由', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { status: 'awaiting_mfa', events: [] } })));
    const client = new BankingHttpClient('http://127.0.0.1:3000', fetcher);
    await client.settle('action_one', 'verify', '246810');
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:3000/api/actions/action_one/verify');
    expect(fetcher.mock.calls[0][1]?.body).toBe('{"code":"246810"}');
  });
});

describe('通道配置与本地凭据', () => {
  const directories: string[] = [];
  afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
  it.each(['http://evil.example', 'https://127.0.0.1.evil.example', 'http://u:p@localhost:3000', 'http://localhost:3000/path'])('拒绝非本机银行地址 %s', value => {
    expect(() => bankingBaseUrl(value)).toThrow();
  });
  it.each(['http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://weixin.qq.com.evil.example'])('拒绝非微信凭据投递地址 %s', value => {
    expect(() => weixinBaseUrl(value)).toThrow();
  });
  it('原子保存并恢复 outbox 和绑定身份；同目录不能同时启动两个 worker', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bank-weixin-')); directories.push(directory);
    const store = new WeixinStore(directory); const f = fixture();
    await store.save(f.state); expect(await store.load()).toEqual(f.state);
    const release = await store.lock(); await expect(store.lock()).rejects.toThrow('已在运行'); await release();
    const again = await store.lock(); await again();
    expect(await readFile(path.join(directory, 'state.json'), 'utf8')).toContain('test-token');
  });
});

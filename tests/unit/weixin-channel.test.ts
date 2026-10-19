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
function fixture() {
  const state = emptyState();
  state.auth = { botId: 'bot', ownerId: 'owner', token: 'test-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
  const bank = { chat: vi.fn<BankingChannel['chat']>().mockResolvedValue({ sessionId: 'demo:user', events: [gate] }),
    actions: vi.fn<BankingChannel['actions']>().mockResolvedValue([]),
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
    expect(reply).toContain('张伟'); expect(reply).toContain('¥2,000.37'); expect(reply).toContain('/确认 action_one');
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

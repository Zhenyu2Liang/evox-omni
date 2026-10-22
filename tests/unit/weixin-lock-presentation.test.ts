/**
 * Unit: WeChat channel — the TERMINAL MFA lock as it is actually rendered to a WeChat user, plus
 * the cleaning boundary around every event/card that could carry an internal diagnostic.
 *
 * A locked action is the one state a chat user cannot click through, so the reply is a four-part
 * sentence built from the server's AUTHORITATIVE fields (`status` + typed `failure`): status block →
 * typed refusal → "no verification entry any more" → how to lift the restriction. It must never
 * offer `继续验证：/验证 <id>`, never announce a success status and never repeat the server
 * `message` (a refusal is rendered from its typed `failure`, not from text).
 *
 * Pure by construction: a fake `BankingChannel` of `vi.fn()`s, an `emptyState()` with the bound
 * owner and an already-offered action, and hand-written stream events/cards. No DB, no model, no
 * network — the renderers under test (`bridge.ts#settleReply`, `banking-client.ts#renderEvents`,
 * `presentation.ts`) are pure functions fed through `WeixinBridge.handle`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WeixinMessage } from 'pi-weixinbot/src/types.ts';
import { WeixinBridge } from '../../channels/weixin/bridge';
import { renderEvents, type ActionResult, type BankingChannel } from '../../channels/weixin/banking-client';
import { emptyState } from '../../channels/weixin/state';
import { label, renderBusinessCard } from '../../channels/weixin/presentation';
import { createTranslator } from '../../lib/i18n/shared';
import type { AgentStreamEvent, ChatCard } from '../../lib/contracts/agent';
import type { PendingActionSummary } from '../../lib/contracts/security';

/** The channel always renders in the product's default locale (`bridge.ts` → `createTranslator`). */
const t = createTranslator('zh-CN');
const ACTION = 'action_one';

/** The exact sentences the server's authorization outcome carries (`security/security-gateway.ts`). */
const SERVER = {
  exhausted: '验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。',
  breaker: '当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。',
  retryable: '验证码错误，请重试。剩余尝试次数：2。',
};

/** Inputs that must never be echoed: block payload, raw JSON, stack trace, missing-value text. */
const HOSTILE = [
  '__SECURITY_BLOCK__{"decisionKind":"deny"}',
  '{"decisionKind":"deny"}',
  'Error: boom\n    at x (f:1:1)',
  'undefined',
  '[object Object]',
];

const summary: PendingActionSummary = { title: '转账', toolName: 'transfer_money', tier: 'RED', requiresMfa: true,
  fields: [{ label: '收款人', value: '张伟' }, { label: '金额', value: '¥2,000.37' }] };

/** A complete trusted private text message from the bound owner. */
const message = (text: string, id: number | string = 1): WeixinMessage => ({ message_id: id,
  from_user_id: 'owner', to_user_id: 'bot', context_token: 'context', message_type: 1, message_state: 2,
  item_list: [{ type: 1, text_item: { text } }] });

/** A bound channel whose only server answer is `outcome`; the action was already offered+confirmed. */
function fakeChannel(outcome: ActionResult) {
  const state = emptyState();
  state.auth = { botId: 'bot', ownerId: 'owner', token: 'test-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
  state.offered[ACTION] = { confirmed: true };
  const bank = {
    chat: vi.fn<BankingChannel['chat']>().mockResolvedValue({ sessionId: 'demo:user', events: [] }),
    actions: vi.fn<BankingChannel['actions']>().mockResolvedValue([]),
    settle: vi.fn<BankingChannel['settle']>().mockResolvedValue(outcome),
    plans: vi.fn<BankingChannel['plans']>().mockResolvedValue([]),
    plan: vi.fn<BankingChannel['plan']>(),
    controlPlan: vi.fn<BankingChannel['controlPlan']>(),
    schedules: vi.fn<BankingChannel['schedules']>().mockResolvedValue({ tasks: [], notifications: [] }),
    tickSchedules: vi.fn<BankingChannel['tickSchedules']>().mockResolvedValue({ evaluatedAt: 0, dispatches: [] }),
  };
  const sender = { send: vi.fn().mockResolvedValue(undefined) };
  const bridge = new WeixinBridge(state, bank, sender, vi.fn().mockResolvedValue(undefined));
  return { state, bank, sender, bridge };
}

/** The text of the LAST reply the channel pushed to WeChat. */
const lastReply = (sender: { send: ReturnType<typeof vi.fn> }): string =>
  String(sender.send.mock.calls.at(-1)?.[1]);

/** Submit one verification code through the real bridge and return the delivered reply. */
async function verify(outcome: ActionResult): Promise<string> {
  const channel = fakeChannel(outcome);
  expect(await channel.bridge.handle(message(`/验证 ${ACTION} 246810`))).toBe(true);
  expect(channel.bank.settle).toHaveBeenCalledWith(ACTION, 'verify', '246810');
  return lastReply(channel.sender);
}

/** The four parts `bridge.ts#settleReply` must join with a blank line for a locked outcome. */
const lockedText = (reason: string): string => [
  `操作编号：${ACTION}\n状态：已锁定`,
  reason,
  '当前状态：该操作已锁定，不再提供验证码入口，也不会执行。',
  '解除方式：请在网页安全中心解除限制；解除后需要重新发起这笔操作，系统不会自动执行原操作。',
].join('\n\n');

describe('微信锁定终态的上屏文案', () => {
  it('第三次错误验证码：四段锁定说明，不再提供验证入口', async () => {
    const reply = await verify({ actionId: ACTION, ok: false, status: 'locked', code: 'CIRCUIT_OPEN',
      failure: { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', actionId: ACTION, attemptsUsed: 3, attemptsLeft: 0, maxAttempts: 3 },
      message: SERVER.exhausted, events: [] });
    expect(reply).toBe(lockedText(t('chat.error.actionLocked')));
    expect(reply).toContain('状态：已锁定');
    expect(reply).not.toContain('继续验证：');
    expect(reply).not.toContain('/验证');
    expect(reply).not.toContain('状态：executed');
    expect(reply).not.toContain('状态：已执行');
    expect(reply).not.toContain(SERVER.exhausted);
  });

  it('熔断开启：锁定说明改用安全验证已锁定，仍无验证入口', async () => {
    const reply = await verify({ actionId: ACTION, ok: false, status: 'locked', code: 'CIRCUIT_OPEN',
      failure: { code: 'CIRCUIT_OPEN', reason: 'circuit_open', actionId: ACTION, attemptsLeft: 0, maxAttempts: 3 },
      message: SERVER.breaker, events: [] });
    expect(reply).toBe(lockedText(t('chat.error.securityLocked')));
    expect(reply).not.toBe(lockedText(t('chat.error.actionLocked')));
    expect(reply).not.toContain('继续验证：');
    expect(reply).not.toContain('/验证');
    expect(reply).not.toContain(SERVER.breaker);
  });

  it('解锁后再提交验证码仍是锁定：同一安全验证已锁定文案，无入口', async () => {
    const reply = await verify({ actionId: ACTION, ok: false, status: 'locked', code: 'CIRCUIT_OPEN',
      failure: { code: 'CIRCUIT_OPEN', reason: 'mfa_session_locked', actionId: ACTION, attemptsLeft: 0, maxAttempts: 3 },
      message: SERVER.breaker, events: [] });
    expect(reply).toBe(lockedText(t('chat.error.securityLocked')));
    expect(reply).toContain(t('chat.error.securityLocked'));
    expect(reply).not.toContain('继续验证：');
    expect(reply).not.toContain('/验证');
  });

  it('单次错误验证码：状态块带唯一续接入口与剩余次数', async () => {
    const reply = await verify({ actionId: ACTION, ok: false, status: 'awaiting_mfa', code: 'MFA_FAILED',
      failure: { code: 'MFA_FAILED', reason: 'mfa_code_invalid', actionId: ACTION, attemptsUsed: 1, attemptsLeft: 2, maxAttempts: 3 },
      message: SERVER.retryable, events: [] });
    const remaining = t('chat.error.verificationRemaining', { count: 2 });
    expect(reply).toBe(`操作编号：${ACTION}\n状态：等待验证码\n继续验证：/验证 ${ACTION} 六位验证码\n\n${remaining}`);
    expect(reply).toContain('状态：等待验证码');
    expect(reply).toContain(`继续验证：/验证 ${ACTION} 六位验证码`);
    expect(reply).toContain(remaining);
    expect(remaining).toContain('2');
    expect(reply).not.toContain(SERVER.retryable);
    expect(reply).not.toContain(t('chat.error.actionLocked'));
    expect(reply).not.toContain('已锁定');
  });

  it.each(['confirmed', 'executed', 'failed', 'cancelled', 'pending', 'locked', 'awaiting_mfa'])(
    '只有 awaiting_mfa 给出继续验证入口（%s）', async status => {
      const reply = await verify({ actionId: ACTION, ok: false, status,
        message: '服务端已受理该请求，结果以操作记录为准。', events: [] });
      expect(reply).toContain(`操作编号：${ACTION}\n状态：${label(status)}`);
      expect(reply.includes('继续验证：')).toBe(status === 'awaiting_mfa');
      expect(reply.includes(`/验证 ${ACTION} 六位验证码`)).toBe(status === 'awaiting_mfa');
      if (status === 'awaiting_mfa') expect(reply).toContain(`继续验证：/验证 ${ACTION} 六位验证码`);
    });

  it('locked 且 code/failure 都缺失时回落安全检查提示，不崩溃也无入口', async () => {
    const reply = await verify({ actionId: ACTION, ok: false, status: 'locked',
      message: '验证失败，操作已锁定。', events: [] });
    expect(reply).toBe(lockedText(t('chat.error.securityDenied')));
    expect(reply).toContain(`操作编号：${ACTION}\n状态：已锁定`);
    expect(reply).not.toContain('继续验证：');
    expect(reply).not.toContain('/验证');
    expect(reply).not.toContain('验证失败，操作已锁定。');
  });
});

describe('微信事件渲染：security_event、兜底句与内部诊断', () => {
  const gateEvent: AgentStreamEvent = { type: 'confirmation_required', actionId: ACTION, action: summary };
  const lockedEvent: AgentStreamEvent = { type: 'security_event', kind: 'locked', actionId: ACTION,
    code: 'CIRCUIT_OPEN', reason: 'circuit_open' };

  it('locked 的 security_event 撤销 gate，后续事件无法复活验证入口', () => {
    const withoutRefusal = renderEvents([gateEvent]);
    const refused = renderEvents([gateEvent, lockedEvent]);
    expect(withoutRefusal.actionIds).toEqual([ACTION]);
    expect(withoutRefusal.text).not.toContain(t('chat.error.securityLocked'));
    expect(refused.actionIds).toEqual([]);
    expect(refused.text).toContain(t('chat.error.securityLocked'));
    expect(refused.text).not.toContain(`/验证 ${ACTION}`);
    // 已结算之后又下发同一张卡片，也不能复活被拒操作的验证入口。
    const resurrected = renderEvents([gateEvent, lockedEvent,
      { type: 'action_settled', actionId: ACTION, status: 'locked' }, gateEvent]);
    expect(resurrected.actionIds).toEqual([]);
    expect(resurrected.text).not.toContain(`/验证 ${ACTION}`);
    expect(resurrected.text.split(t('chat.error.securityLocked'))).toHaveLength(2);
  });

  it.each(['injection', 'audit', 'note'])('kind=%s 的 security_event 只审计，不上屏', kind => {
    const event: AgentStreamEvent = { type: 'security_event', kind, actionId: ACTION, message: '扫描到提示注入样本' };
    expect(renderEvents([event]).text).toBe(renderEvents([]).text);
    expect(renderEvents([event], { emptyNotice: false }).text).toBe('');
    expect(renderEvents([event]).text).not.toContain('扫描到提示注入样本');
  });

  it('emptyNotice:false 关闭兜底句，默认仍发送', () => {
    const filler = '本次请求已处理，请在网页查看业务详情；没有确认或验证的业务不会执行。';
    expect(renderEvents([]).text).toBe(filler);
    expect(renderEvents([], { emptyNotice: false }).text).toBe('');
    expect(renderEvents([{ type: 'text_delta', delta: '余额' }, { type: 'done' }], { emptyNotice: false }).text).toBe('');
  });

  it.each(HOSTILE)('事件携带的内部诊断不上屏：%j', hostile => {
    const text = renderEvents([
      { type: 'security_event', kind: 'locked', actionId: ACTION, code: 'CIRCUIT_OPEN', reason: 'circuit_open', message: hostile },
      { type: 'security_event', kind: 'injection', message: hostile },
      { type: 'error', message: hostile },
    ]).text;
    expect(text).toBe([t('chat.error.securityLocked'), t('chat.error.toolFailed')].join('\n\n'));
    for (const fragment of ['__SECURITY_BLOCK__', 'decisionKind', '\n    at ', 'boom']) {
      expect(text).not.toContain(fragment);
    }
  });
});

describe('微信卡片与状态词的兜底渲染', () => {
  it.each(HOSTILE)('业务提示卡只回目录文案：%j', hostile => {
    const rendered = renderBusinessCard({ type: 'error', message: hostile });
    expect(rendered).toBe(`业务提示：${t('chat.error.toolFailed')}`);
    for (const fragment of ['__SECURITY_BLOCK__', 'decisionKind', '\n    at ', 'boom']) {
      expect(rendered).not.toContain(fragment);
    }
  });

  it('授权卡正文由 renderEvents 生成，卡片自带的 message/hint/mfaHint 不上屏', () => {
    const hostileSummary: PendingActionSummary = { ...summary, mfaHint: HOSTILE[0] };
    const card: ChatCard = { type: 'mfa', actionId: ACTION, action: hostileSummary, status: 'locked',
      message: HOSTILE[0], hint: HOSTILE[2] };
    expect(renderBusinessCard(card)).toBe('');
    expect(renderBusinessCard({ type: 'confirmation', action: hostileSummary })).toBe('');
    const text = renderEvents([{ type: 'card', card }]).text;
    expect(text).toContain(`操作编号：${ACTION}`);
    for (const fragment of ['__SECURITY_BLOCK__', 'decisionKind', '\n    at ']) expect(text).not.toContain(fragment);
  });

  it('工具事件的 message/label 字段只经公开摘要输出目录文案', () => {
    const text = renderEvents([{ type: 'tool_end', toolEvent: { toolCallId: 'c1', toolName: 'transfer_money',
      status: 'error', summary: HOSTILE[0], label: HOSTILE[2], debugDetail: HOSTILE[0],
      debugArguments: { decisionKind: 'deny' } } }]).text;
    expect(text).toBe(t('chat.error.toolFailed'));
  });

  it('字段缺失仍回「字段不完整」，不据此推断业务结果', () => {
    const malformed: ChatCard[] = [{ type: 'cards', data: { hostile: HOSTILE[0] } },
      { type: 'transactions', data: HOSTILE[1] }];
    for (const card of malformed) {
      const rendered = renderBusinessCard(card);
      expect(rendered).toContain('字段不完整');
      expect(rendered).not.toContain('__SECURITY_BLOCK__');
      expect(rendered).not.toContain('decisionKind');
    }
  });

  it.each([
    ['pending', '等待确认'], ['awaiting_mfa', '等待验证码'], ['confirmed', '已确认，正在处理'],
    ['executed', '已执行'], ['failed', '失败'], ['cancelled', '已取消'],
    ['locked', '已锁定'], ['needs_reconciliation', '结果待人工核对'],
  ])('真实状态 %s 渲染为 %s', (value, expected) => expect(label(value)).toBe(expected));

  it.each([...HOSTILE, '', '有 空格', 'a'.repeat(65), '已锁定'])('非状态文本 %j 渲染为未知状态', value => {
    expect(label(value)).toBe('未知状态');
  });

  it('未登记但形状合法的枚举原样透出，64 字符仍是合法令牌', () => {
    expect(label('ARCHIVED')).toBe('ARCHIVED');
    expect(label('a'.repeat(64))).toBe('a'.repeat(64));
    expect(label('a'.repeat(65))).toBe('未知状态');
  });
});

describe('微信锁定授权卡片的去重', () => {
  const lockedCard: ChatCard = { type: 'mfa', actionId: ACTION, action: summary, status: 'locked' };
  const doubled: AgentStreamEvent[] = [{ type: 'card', card: lockedCard },
    { type: 'message_end', message: { id: 'm1', role: 'tool', content: '', timestamp: 0, cards: [lockedCard] } }];

  it('流式卡片与 message_end 中的同一张锁定卡只渲染一次', () => {
    const once = renderEvents([{ type: 'card', card: lockedCard }]);
    const duplicated = renderEvents(doubled);
    expect(duplicated.text).toBe(once.text);
    expect(duplicated.text.match(/操作编号：action_one/g)).toHaveLength(1);
    expect(duplicated.text.match(/\/验证 action_one/g)).toHaveLength(1);
  });

  it('锁定事件撤销入口后，重复卡片不再给出验证入口且只留一条拒绝说明', () => {
    const result = renderEvents([...doubled, { type: 'security_event', kind: 'locked', actionId: ACTION,
      code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', attemptsLeft: 0, maxAttempts: 3 }]);
    expect(result.actionIds).toEqual([]);
    expect(result.text).not.toContain('/验证');
    expect(result.text).toContain(t('chat.error.actionLocked'));
    expect(result.text.split(t('chat.error.actionLocked'))).toHaveLength(2);
  });
});

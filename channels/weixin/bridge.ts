import { createHash } from 'node:crypto';
import type { WeixinMessage } from 'pi-weixinbot/src/types.ts';
import type { BankingChannel } from './banking-client';
import { BankingApiError, renderEvents } from './banking-client';
import type { WeixinState } from './state';
import { HELP, handleChannelCommand } from './commands';
import { label } from './presentation';

export interface WeixinSender {
  send(to: string, text: string, clientId: string, contextToken: string): Promise<void>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** 单绑定用户、串行处理。群聊、陌生人和机器人回声不进入模型。 */
export class WeixinBridge {
  constructor(readonly state: WeixinState, private readonly bank: BankingChannel,
    private readonly sender: WeixinSender, private readonly save: () => Promise<void>) {}

  async handle(message: WeixinMessage): Promise<boolean> {
    const auth = this.state.auth;
    if (!auth || message.from_user_id !== auth.ownerId || message.group_id || message.message_type !== 1 ||
        (message.message_state !== undefined && message.message_state !== 2) || !message.context_token ||
        message.item_list?.some(item => item.is_completed === false)) return false;
    if (message.to_user_id && message.to_user_id !== auth.botId) return false;
    const id = typeof message.message_id === 'string' && /^\d{1,30}$/.test(message.message_id) ? message.message_id :
      Number.isSafeInteger(message.message_id) ? String(message.message_id) :
      message.item_list?.find(item => item.msg_id)?.msg_id;
    if (!id) return false;
    const text = message.item_list?.filter(item => item.type === 1).map(item => item.text_item?.text || '').join('\n').trim();
    const key = digest(`${auth.botId}\0${auth.ownerId}\0${id}`);
    let delivery = this.state.deliveries[key];
    if (!delivery) {
      let reply: string;
      try { reply = text ? await this.respond(text, `weixin:${key}`) : '目前仅支持文字消息，请输入银行需求。'; }
      catch (error) { reply = error instanceof BankingApiError ? error.message : '银行请求结果暂时无法确认。请在网页核对操作记录，不要据此判断已成功或资金未变。'; }
      // 验证码只存在于本次 HTTP 请求，不持久化消息正文。
      delivery = { replies: Array.from(reply.matchAll(/[\s\S]{1,1600}/gu), match => match[0]), sent: 0 };
      this.state.deliveries[key] = delivery;
      const keys = Object.keys(this.state.deliveries);
      for (const old of keys.slice(0, Math.max(0, keys.length - 2000))) {
        if (this.state.deliveries[old].sent === this.state.deliveries[old].replies.length) delete this.state.deliveries[old];
      }
      await this.save();
    }
    while (delivery.sent < delivery.replies.length) {
      await this.sender.send(auth.ownerId, delivery.replies[delivery.sent], `bank-${key}-${delivery.sent}`, message.context_token);
      delivery.sent++;
      await this.save();
    }
    return true;
  }

  private async respond(text: string, requestId: string): Promise<string> {
    const channelReply = await handleChannelCommand(text, this.bank, this.state);
    if (channelReply !== undefined) return channelReply;
    const command = /^\/(确认|验证|取消|恢复操作)\s+([A-Za-z0-9_-]{1,128})(?:\s+(\d{6}))?$/.exec(text);
    if (command) {
      const [, verb, id, code] = command;
      const offered = this.state.offered[id];
      if (!offered) return '该操作不是本通道提供的操作，请核对编号，或在网页处理。';
      if (verb === '验证' && (!code || !offered.confirmed)) return `请先发送 /确认 ${id}，再发送 /验证 ${id} 六位验证码。`;
      if (verb !== '验证' && code) return '确认和取消命令不接收验证码。';
      const outcome = await this.bank.settle(id, verb === '确认' ? 'confirm' : verb === '验证' ? 'verify' : verb === '恢复操作' ? 'recover' : 'cancel', code);
      if (verb === '确认' && outcome.status === 'awaiting_mfa') offered.confirmed = true;
      const rendered = this.present(outcome.events);
      const next = outcome.status === 'awaiting_mfa' ? `\n继续验证：/验证 ${id} 六位验证码` : '';
      return [`操作编号：${id}\n状态：${label(outcome.status)}${next}`, outcome.message || '', rendered].filter(Boolean).join('\n\n');
    }
    if (text.startsWith('/')) return `命令格式不正确。\n${HELP}`;
    if (text.length > 4000) return '消息过长，请将银行需求缩短至 4000 字以内。';
    return this.present((await this.bank.chat(text, requestId)).events);
  }

  private present(events: Parameters<typeof renderEvents>[0]): string {
    const rendered = renderEvents(events);
    for (const id of rendered.actionIds) this.state.offered[id] ??= { confirmed: false };
    for (const id of rendered.planIds) this.state.plans[id] = true;
    return rendered.text;
  }
}

import { createHash } from 'node:crypto';
import type { WeixinMessage } from 'pi-weixinbot/src/types.ts';
import type { ActionResult, BankingChannel } from './banking-client';
import { BankingApiError, renderEvents } from './banking-client';
import type { WeixinState } from './state';
import { HELP, handleChannelCommand, offerActions, decisionActions } from './commands';
import { securityNotice } from '../../lib/public-text';
import { createTranslator } from '../../lib/i18n/shared';
import { channelText, label } from './presentation';
import { splitReply } from './message-chunks';
import { actionReference, resolveActionReference } from './action-references';

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
      delivery = { replies: splitReply(reply), sent: 0 };
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
    const currentCommand = /^(\/确认|\/取消)$|^\/验证\s+(\d{6})$/.exec(text);
    if (currentCommand) {
      // Bind the command to the displayed queue head; never silently advance on stale state.
      const actions = await this.bank.actions();
      const pending = decisionActions(actions);
      const active = pending.find(action => action.id === this.state.activeActionId);
      if (!pending.length) { offerActions(actions, this.state); return '当前没有待确认的操作。'; }
      if (!active || !Object.hasOwn(this.state.offered, active.id)) {
        return `请先核对当前操作，再发送 /确认。\n\n${offerActions(actions, this.state)}`;
      }
      text = currentCommand[2] ? `/验证 ${active.id} ${currentCommand[2]}` : `${currentCommand[1]} ${active.id}`;
    }
    const command = /^\/(确认|验证|取消|恢复操作)\s+([A-Za-z0-9_-]{1,128})(?:\s+(\d{6}))?$/.exec(text);
    if (command) {
      const [, verb, reference, code] = command;
      const id = resolveActionReference(this.state, reference);
      if (!id) return '该操作不是本通道提供的操作，请核对编号，或在网页处理。';
      const offered = this.state.offered[id];
      const display = actionReference(this.state, id);
      const sequential = id === this.state.activeActionId;
      if (verb === '验证' && (!code || !offered.confirmed)) return sequential
        ? '请先发送 /确认，再发送 /验证 六位验证码。'
        : `请先发送 /确认 ${display}，再发送 /验证 ${display} 六位验证码。`;
      if (verb !== '验证' && code) return '确认和取消命令不接收验证码。';
      const outcome = await this.bank.settle(id, verb === '确认' ? 'confirm' : verb === '验证' ? 'verify' : verb === '恢复操作' ? 'recover' : 'cancel', code);
      if (verb === '确认' && outcome.status === 'awaiting_mfa') offered.confirmed = true;
      const terminal = !['pending', 'awaiting_mfa'].includes(outcome.status);
      if (terminal) {
        this.state.confirmationQueue = this.state.confirmationQueue.filter(queued => queued !== id);
        if (sequential) this.state.activeActionId = undefined;
      }
      return this.settleReply(id, outcome, sequential, terminal);
    }
    if (text.startsWith('/')) return `命令格式不正确。\n\n${HELP}`;
    if (text.length > 4000) return '消息过长，请将银行需求缩短至 4000 字以内。';
    return this.present((await this.bank.chat(text, requestId)).events);
  }

  /**
   * Compose a settle reply from the server's AUTHORITATIVE status and typed refusal. A terminal
   * `locked` outcome must state the reason, that no verification entry is offered any more, and how
   * to lift the restriction — and must never hint that another code can be submitted.
   */
  private async settleReply(id: string, outcome: ActionResult, sequential: boolean, terminal: boolean): Promise<string> {
    const t = createTranslator('zh-CN');
    // A settle reply carries its own status block; the chat-only "本次请求已处理…" filler would
    // contradict a lock, so it is suppressed here.
    const rendered = await this.present(outcome.events, { emptyNotice: false, advanceQueue: terminal, settledId: terminal ? id : undefined });
    const reference = actionReference(this.state, id);
    const status = `${sequential ? '' : `操作编号：${reference}\n`}状态：${label(outcome.status)}`;
    if (outcome.status === 'locked') {
      return [status,
        securityNotice(outcome.failure ?? { code: outcome.code }, t),
        '当前状态：该操作已锁定，不再提供验证码入口，也不会执行。',
        '解除方式：请在网页安全中心解除限制；解除后需要重新发起这笔操作，系统不会自动执行原操作。',
        rendered].filter(Boolean).join('\n\n');
    }
    const pending = outcome.status === 'awaiting_mfa';
    const refusal = outcome.failure?.reason === 'mfa_code_invalid' || outcome.failure?.reason === 'mfa_session_locked'
      ? securityNotice(outcome.failure, t) : undefined;
    const message = refusal ?? (outcome.message ? channelText(outcome.message, t, 'chat.error.toolFailed')
      : outcome.status === 'needs_reconciliation' ? t('chat.error.unknownOutcome')
      : outcome.status === 'failed' || !rendered && !['executed', 'cancelled', 'confirmed', 'awaiting_mfa', 'pending'].includes(outcome.status)
        ? t('chat.error.toolFailed') : '');
    return [...new Set([status + (pending ? `\n继续验证：/验证${sequential ? '' : ` ${reference}`} 六位验证码` : ''), message, rendered].filter(Boolean))].join('\n\n');
  }

  private async present(events: Parameters<typeof renderEvents>[0], options: { emptyNotice?: boolean; advanceQueue?: boolean; settledId?: string } = {}): Promise<string> {
    const rendered = renderEvents(events, { emptyNotice: false, renderAction: () => '' });
    for (const id of rendered.actionIds) if (!this.state.confirmationQueue.includes(id)) this.state.confirmationQueue.push(id);
    for (const id of rendered.planIds) this.state.plans[id] = true;
    let queue = '';
    if (rendered.actionIds.length || options.advanceQueue) {
      try {
        const actions = (await this.bank.actions()).filter(action => action.id !== options.settledId);
        queue = offerActions(actions, this.state);
        if (!actions.length) queue = '';
      } catch {
        queue = '待确认操作暂时无法读取，请发送 /待办 重新查看后再确认。';
      }
    }
    return [rendered.text, queue].filter(Boolean).join('\n\n') || (options.emptyNotice === false ? ''
      : '本次请求已处理，请在网页查看业务详情；没有确认或验证的业务不会执行。');
  }
}

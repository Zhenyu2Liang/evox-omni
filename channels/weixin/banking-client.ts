import type { AgentStreamEvent, ChatTurnResponse, ToolEventView } from '../../lib/contracts/agent';
import type { PendingActionSummary, SecurityFailure } from '../../lib/contracts/security';
import { bankingBaseUrl } from './config';
import type { TaskPlan } from '../../lib/contracts/task';
import type { ScheduleInbox, ScheduleTickResult } from '../../lib/contracts/schedule';
import { renderBusinessCard, channelText, renderPlan, type SurfacedAction } from './presentation';
import { publicToolSummary } from '../../lib/tool-feedback';
import { securityNotice } from '../../lib/public-text';
import { createTranslator } from '../../lib/i18n/shared';

export interface ActionResult {
  actionId: string; ok: boolean; status: string; message?: string; requiresMfa?: boolean;
  /** Server-owned refusal type (`MFA_FAILED`/`MFA_LOCKED`/`CIRCUIT_OPEN`/...); never inferred from text. */
  code?: string;
  attemptsLeft?: number;
  maxAttempts?: number;
  /** The complete structured refusal, when the outcome is a security refusal. */
  failure?: SecurityFailure;
  events: AgentStreamEvent[];
}
export interface BankingChannel {
  chat(message: string, requestId: string): Promise<ChatTurnResponse>;
  actions(): Promise<SurfacedAction[]>;
  settle(id: string, command: 'confirm' | 'verify' | 'cancel' | 'recover', code?: string): Promise<ActionResult>;
  plans(): Promise<TaskPlan[]>;
  plan(id: string): Promise<TaskPlan>;
  controlPlan(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'rollback'): Promise<TaskPlan>;
  schedules(): Promise<ScheduleInbox>;
  tickSchedules(): Promise<ScheduleTickResult>;
}

export class BankingApiError extends Error {}

/** 复用 Web 的身份、授权、熔断、回执和模型续接入口；通道没有 SDK 写入能力。 */
export class BankingHttpClient implements BankingChannel {
  readonly baseUrl: string;
  constructor(baseUrl: string, private readonly fetcher: typeof fetch = fetch) { this.baseUrl = bankingBaseUrl(baseUrl); }
  private async request<T>(route: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const result = await response.json() as { ok: boolean; data: T; error?: { code: string; message: string } };
    if (!response.ok || !result.ok) {
      if (response.status < 500 && typeof result.error?.message === 'string' && /^[A-Z_]+$/.test(result.error.code)) {
        throw new BankingApiError(`服务端提示（${result.error.code}）：${result.error.message.slice(0, 400)}\n请核对操作记录后处理。`);
      }
      // 不回显请求、HTTP 原文或验证码；业务不明时不推断“资金未变”。
      throw new Error('银行服务暂未完成请求，请在网页核对操作记录后再处理。');
    }
    return result.data;
  }
  async health(): Promise<{ llmMode: string }> { return this.request('/api/health'); }
  chat(message: string, requestId: string): Promise<ChatTurnResponse> {
    return this.request('/api/chat?stream=0', { message, requestId });
  }
  actions(): Promise<SurfacedAction[]> { return this.request('/api/actions'); }
  settle(id: string, command: 'confirm' | 'verify' | 'cancel' | 'recover', code?: string): Promise<ActionResult> {
    return this.request(`/api/actions/${encodeURIComponent(id)}/${command}`, command === 'verify' ? { code } : {});
  }
  async plans(): Promise<TaskPlan[]> { return (await this.request<{ plans: TaskPlan[] }>('/api/tasks')).plans; }
  plan(id: string): Promise<TaskPlan> { return this.request(`/api/tasks/${encodeURIComponent(id)}`); }
  controlPlan(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'rollback'): Promise<TaskPlan> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}`, { action });
  }
  schedules(): Promise<ScheduleInbox> { return this.request('/api/schedules'); }
  tickSchedules(): Promise<ScheduleTickResult> { return this.request('/api/schedules/tick', {}); }
}

export function renderAction(id: string, summary: PendingActionSummary): string {
  return [summary.title, ...summary.fields.map(field => `${field.label}：${field.value}`),
    `风险等级：${summary.tier}`, `操作编号：${id}`, '尚未执行。',
    `确认：/确认 ${id}`, ...(summary.requiresMfa ? [`确认后验证：/验证 ${id} 六位验证码`] : []),
    `取消：/取消 ${id}`].join('\n');
}

export interface RenderEventOptions {
  /**
   * Append the "本次请求已处理…" sentence when no event produced any text. A chat turn always says
   * something; a settle reply already carries its own authoritative status block.
   */
  emptyNotice?: boolean;
}

/** 只发送服务端已完成核验的 message_end，绝不转发原始流或工具参数。 */
export function renderEvents(events: readonly AgentStreamEvent[], options: RenderEventOptions = {}): { text: string; actionIds: string[]; planIds: string[] } {
  const messages = new Map<string, string>();
  const gates = new Map<string, string>();
  const notices: string[] = [];
  const cards = new Map<string, string>();
  const plans = new Map<string, TaskPlan>();
  const settled = new Set<string>();
  const locked = new Set<string>();
  const feedback = new Map<string, string>();
  const t = createTranslator('zh-CN');
  const addFeedback = (event: ToolEventView) => {
    const key = `${event.messageId || ''}:${event.toolCallId}`;
    if (event.status === 'error' || event.status === 'needs_reconciliation' || (event.status === 'blocked' && !event.actionId)) {
      const message = publicToolSummary(event, t);
      if (message) feedback.set(key, message);
    } else feedback.delete(key);
  };
  const addCard = (card: import('../../lib/contracts/agent').ChatCard) => {
    if (card.type === 'confirmation' && card.action.actionId) {
      gates.set(card.action.actionId, renderAction(card.action.actionId, card.action)); return;
    }
    if (card.type === 'mfa') {
      if (card.action) gates.set(card.actionId, renderAction(card.actionId, card.action)); return;
    }
    if (card.type === 'plan') { addPlan(card.plan); return; }
    // 查询类保留最新投影；回执按公开内容去重，避免 card + message_end 双发。
    const key = ['receipt', 'transfer', 'scheduled', 'contacts'].includes(card.type) ? JSON.stringify(card) : card.type;
    cards.set(key, renderBusinessCard(card));
  };
  const addPlan = (plan: TaskPlan) => {
    const previous = plans.get(plan.id);
    if (!previous || (plan.generation ?? 0) >= (previous.generation ?? 0)) plans.set(plan.id, plan);
  };
  for (const event of events) {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.content.trim()) {
      messages.set(event.message.id, event.message.content);
    }
    if (event.type === 'message_end') for (const card of event.message.cards || []) addCard(card);
    if (event.type === 'message_end') for (const tool of event.message.toolEvents || []) addFeedback(tool);
    if (event.type === 'tool_end') addFeedback(event.toolEvent);
    if (event.type === 'confirmation_required') gates.set(event.actionId, renderAction(event.actionId, event.action));
    if (event.type === 'mfa_required' && event.action) gates.set(event.actionId, renderAction(event.actionId, event.action));
    if (event.type === 'card') addCard(event.card);
    if (event.type === 'plan_update') addPlan(event.plan);
    if (event.type === 'tool_end' && event.toolEvent.status === 'success' &&
        ['transfer_money', 'subscribe_investment', 'redeem_investment', 'consume_virtual_card'].includes(event.toolEvent.toolName)) {
      // 先查询再扣/入账时，旧资产快照不再冒充写操作后的当前余额。
      cards.delete('balance'); cards.delete('dashboard');
    }
    if (event.type === 'action_settled') settled.add(event.actionId);
    if (event.type === 'security_event' && event.kind === 'locked') {
      // A security refusal is published from its TYPED fields only — never the raw payload text.
      // Non-`locked` kinds (injection-scan notes) stay audit-only and render nothing.
      notices.push(securityNotice({ code: event.code, reason: event.reason,
        attemptsLeft: event.attemptsLeft, maxAttempts: event.maxAttempts }, t));
      // A refused action can never offer a verification entry again.
      if (event.actionId) locked.add(event.actionId);
    }
    if (event.type === 'error') notices.push(channelText(event.message, t, 'chat.error.toolFailed'));
  }
  for (const id of settled) gates.delete(id);
  for (const id of locked) gates.delete(id);
  const body = [...messages.values(), ...cards.values(), ...[...plans.values()].map(renderPlan), ...gates.values(),
    ...new Set([...feedback.values(), ...notices])].filter(Boolean).join('\n\n');
  const text = body || (options.emptyNotice === false ? '' : '本次请求已处理，请在网页查看业务详情；没有确认或验证的业务不会执行。');
  return { text, actionIds: [...gates.keys()], planIds: [...plans.keys()] };
}

import type { AgentStreamEvent, ChatTurnResponse } from '../../lib/contracts/agent';
import type { PendingAction, PendingActionSummary } from '../../lib/contracts/security';
import { bankingBaseUrl } from './config';

export interface ActionResult {
  actionId: string; ok: boolean; status: string; message?: string; requiresMfa?: boolean;
  events: AgentStreamEvent[];
}
export interface BankingChannel {
  chat(message: string, requestId: string): Promise<ChatTurnResponse>;
  actions(): Promise<PendingAction[]>;
  settle(id: string, command: 'confirm' | 'verify' | 'cancel', code?: string): Promise<ActionResult>;
}

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
      // 不回显请求、HTTP 原文或验证码；业务不明时不推断“资金未变”。
      throw new Error('银行服务暂未完成请求，请在网页核对操作记录后再处理。');
    }
    return result.data;
  }
  async health(): Promise<{ llmMode: string }> { return this.request('/api/health'); }
  chat(message: string, requestId: string): Promise<ChatTurnResponse> {
    return this.request('/api/chat?stream=0', { message, requestId });
  }
  actions(): Promise<PendingAction[]> { return this.request('/api/actions'); }
  settle(id: string, command: 'confirm' | 'verify' | 'cancel', code?: string): Promise<ActionResult> {
    return this.request(`/api/actions/${encodeURIComponent(id)}/${command}`, command === 'verify' ? { code } : {});
  }
}

export function renderAction(id: string, summary: PendingActionSummary): string {
  return [summary.title, ...summary.fields.map(field => `${field.label}：${field.value}`),
    `风险等级：${summary.tier}`, `操作编号：${id}`, '尚未执行。',
    `确认：/确认 ${id}`, ...(summary.requiresMfa ? [`确认后验证：/验证 ${id} 六位验证码`] : []),
    `取消：/取消 ${id}`].join('\n');
}

/** 只发送服务端已完成核验的 message_end，绝不转发原始流或工具参数。 */
export function renderEvents(events: readonly AgentStreamEvent[]): { text: string; actionIds: string[] } {
  const messages = new Map<string, string>();
  const gates = new Map<string, string>();
  const notices: string[] = [];
  for (const event of events) {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.content.trim()) {
      messages.set(event.message.id, event.message.content);
    }
    if (event.type === 'confirmation_required') gates.set(event.actionId, renderAction(event.actionId, event.action));
    if (event.type === 'mfa_required' && event.action) gates.set(event.actionId, renderAction(event.actionId, event.action));
    if (event.type === 'card' && event.card.type === 'confirmation' && event.card.action.actionId) {
      gates.set(event.card.action.actionId, renderAction(event.card.action.actionId, event.card.action));
    }
    if (event.type === 'action_settled') gates.delete(event.actionId);
    if (event.type === 'error') notices.push(event.message);
  }
  return { text: [...messages.values(), ...gates.values(), ...notices].join('\n\n') ||
    '本次请求已处理，请在网页查看业务详情；没有确认或验证的业务不会执行。', actionIds: [...gates.keys()] };
}

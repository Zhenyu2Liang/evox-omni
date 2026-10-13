import type { RiskLevel } from './risk';
import type { PendingActionStatus, PendingActionSummary } from './security';
import type { TaskPlan } from './task';

export type { PendingActionSummary } from './security';
export type { TaskPlan } from './task';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolEventView {
  toolCallId: string;
  toolName: string;
  tier?: RiskLevel;
  status: 'started' | 'success' | 'error' | 'blocked' | 'updated';
  label?: string;
  summary?: string;
}

export type ChatCard =
  | { type: 'balance'; data: unknown }
  | { type: 'transfer'; data: unknown }
  | { type: 'confirmation'; action: PendingActionSummary }
  | { type: 'mfa'; actionId: string; hint?: string; action?: PendingActionSummary; status?: string; message?: string }
  | { type: 'transactions'; data: unknown }
  | { type: 'spending'; data: unknown }
  | { type: 'cards'; data: unknown }
  | { type: 'investments'; data: unknown }
  | { type: 'subscriptions'; data: unknown }
  | { type: 'anomaly'; data: unknown }
  | { type: 'plan'; plan: TaskPlan }
  | { type: 'error'; message: string };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  /** Server offers this only before gateway/executor/write entry, including trusted preflight refusal. */
  retryRequest?: string;
  cards?: ChatCard[];
  toolEvents?: ToolEventView[];
}

export interface ChatTurnRequest { sessionId?: string; requestId?: string; message: string; }

export type AgentStreamEvent =
  | { type: 'session'; sessionId: string; runId?: string }
  | { type: 'message_start'; message: ChatMessage }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolEvent: ToolEventView }
  | { type: 'tool_end'; toolEvent: ToolEventView }
  | { type: 'card'; card: ChatCard }
  | { type: 'plan_update'; plan: TaskPlan; generation?: number }
  | { type: 'confirmation_required'; action: PendingActionSummary; actionId: string }
  | { type: 'mfa_required'; actionId: string; hint?: string; action?: PendingActionSummary }
  | { type: 'action_settled'; actionId: string; status: PendingActionStatus; message?: string }
  | { type: 'security_event'; kind: string; message: string }
  | { type: 'message_end'; message: ChatMessage }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ChatTurnResponse { sessionId: string; runId?: string; events: AgentStreamEvent[]; }

import type { RiskLevel } from './risk';
import type { PendingActionStatus, PendingActionSummary } from './security';
import type { TaskPlan } from './task';

export type { PendingActionSummary } from './security';
export type { TaskPlan } from './task';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

/** Business receipts contain only validated public result fields, never tool arguments. */
export type BusinessReceipt =
  | { kind: 'budget'; name: string; amount: string; purpose?: string; status: 'RESERVED' | 'USED' | 'RELEASED'; dueDate?: number }
  | { kind: 'investmentPurchase' | 'investmentRedemption'; success: boolean; amount: string; newBalance: string; occurredAt: number; redemptionValuation?: string; settlementRounding?: 'HALF_UP'; productName?: string; remainingShares?: string; redeemedShares?: string; netValuePerUnit?: string; feeAmount?: string };

export interface ContactCardView {
  name: string;
  phone: string;
  bank?: string;
  remark?: string;
}

export interface ScheduledCardView {
  name: string;
  kind: 'REMINDER' | 'PAYMENT' | 'TRANSFER';
  runAt: number;
  status: 'SCHEDULED' | 'DISPATCHING' | 'AWAITING_CONFIRMATION' | 'DONE' | 'FAILED' | 'CANCELLED';
  requiresConfirmation: boolean;
}

export interface DashboardCardView {
  totalAssets: string;
  checkingBalance: string;
  creditAvailable: string;
  monthSpend: string;
  month: string;
  asOf: number;
}

export interface ToolEventView {
  toolCallId: string;
  toolName: string;
  /** Stable presentation owner; provider call IDs alone can be reused across responses. */
  messageId?: string;
  /** Exact pending action associated with this provider call, when authorization is required. */
  actionId?: string;
  tier?: RiskLevel;
  status: 'started' | 'success' | 'error' | 'blocked' | 'updated' | 'cancelled' | 'needs_reconciliation';
  label?: string;
  summary?: string;
  errorCode?: import('@/lib/errors').ErrorCode;
  /** Typed facts a catalog message may need to render this refusal (e.g. remaining attempts). */
  errorParams?: Record<string, string | number>;
  /** Server-sanitized diagnostics; rendered only when the developer preference is enabled. */
  debugArguments?: unknown;
  /** Model-facing correction or execution diagnostics; never rendered as public error text. */
  debugDetail?: string;
}

export type ChatCard =
  | { type: 'balance'; data: unknown }
  | { type: 'transfer'; data: unknown }
  | { type: 'confirmation'; action: PendingActionSummary }
  | { type: 'mfa'; actionId: string; hint?: string; action?: PendingActionSummary; status?: string; message?: string }
  | { type: 'transactions'; data: unknown }
  | { type: 'spending'; data: unknown }
  | { type: 'cards'; data: unknown; issuanceActionId?: string }
  | { type: 'investments'; data: unknown }
  | { type: 'subscriptions'; data: unknown }
  | { type: 'contacts'; data: ContactCardView[] }
  | { type: 'dashboard'; data: DashboardCardView }
  | { type: 'scheduled'; data: ScheduledCardView[]; created: boolean }
  | { type: 'receipt'; data: BusinessReceipt }
  | { type: 'anomaly'; data: unknown }
  | { type: 'plan'; plan: TaskPlan }
  | { type: 'error'; message: string; code?: import('../errors').ErrorCode };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Optional server-authored preview; the original financial explanation remains expandable. */
  financialSummary?: string;
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
  | { type: 'reply_progress'; phase: 'generating' | 'checking' | 'repairing' }
  | { type: 'tool_start'; toolEvent: ToolEventView }
  | { type: 'tool_end'; toolEvent: ToolEventView }
  | { type: 'card'; card: ChatCard; messageId?: string }
  | { type: 'plan_update'; plan: TaskPlan; generation?: number; messageId?: string }
  | { type: 'confirmation_required'; action: PendingActionSummary; actionId: string }
  | { type: 'mfa_required'; actionId: string; hint?: string; action?: PendingActionSummary }
  | { type: 'action_settled'; actionId: string; status: PendingActionStatus; message?: string }
  | {
      type: 'security_event';
      kind: string;
      code?: string;
      reason?: string;
      actionId?: string;
      attemptsLeft?: number;
      maxAttempts?: number;
      message?: string;
    }
  | { type: 'message_end'; message: ChatMessage }
  | { type: 'error'; message: string; code?: import('../errors').ErrorCode }
  | { type: 'done' };

export interface ChatTurnResponse { sessionId: string; runId?: string; events: AgentStreamEvent[]; }

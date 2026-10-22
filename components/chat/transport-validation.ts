import { z } from 'zod';
import type { AgentStreamEvent, ChatMessage } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';

const id = z.string().min(1);
const timestamp = z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000);
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const money = z.string().regex(/^-?\d+\.\d{2}$/);
const tier = z.enum(['GREEN', 'YELLOW', 'RED']);
const errorCode = z.enum(['VALIDATION', 'NOT_FOUND', 'INSUFFICIENT_FUNDS', 'LIMIT_EXCEEDED', 'SECURITY_DENIED', 'MFA_FAILED', 'MFA_LOCKED', 'CIRCUIT_OPEN', 'CONFLICT', 'TOOL_FAILED', 'INTERNAL']);
const actionStatus = z.enum(['pending', 'awaiting_mfa', 'confirmed', 'executed', 'failed', 'cancelled', 'locked', 'needs_reconciliation']);
const action = z.object({
  actionId: id.optional(), title: z.string(), toolName: id, tier,
  fields: z.array(z.object({ label: z.string(), value: z.string() })),
  requiresMfa: z.boolean(), amount: money.optional(), mfaHint: z.string().optional(),
  status: actionStatus.optional(), message: z.string().optional(),
});
const toolEvent = z.object({
  toolCallId: id, toolName: id, messageId: id.optional(), actionId: id.optional(), tier: tier.optional(),
  status: z.enum(['started', 'updated', 'success', 'error', 'blocked', 'cancelled', 'needs_reconciliation']),
  label: z.string().optional(), summary: z.string().optional(), errorCode: errorCode.optional(),
  errorParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(), debugDetail: z.string().optional(),
  debugArguments: z.unknown().optional(),
});
const plan = z.object({
  id, sessionId: id, goal: z.string(),
  status: z.enum(['pending', 'running', 'paused', 'waiting_confirmation', 'success', 'failed', 'cancelled']),
  createdAt: timestamp, updatedAt: timestamp, generation: z.number().int().nonnegative().optional(),
  nodes: z.array(z.object({ id, name: z.string(), dependencies: z.array(id), after: z.array(id).optional(),
    kind: z.enum(['tool', 'condition', 'note']), tool: id.optional() })),
  results: z.array(z.object({ id, name: z.string(), tool: id.optional(), error: z.string().optional(),
    status: z.enum(['pending', 'running', 'waiting_confirmation', 'waiting_verification', 'success', 'failed', 'cancelled', 'skipped']),
    compensation: z.object({ status: z.enum(['reverted', 'retained', 'conflict']), message: z.string(), completedAt: timestamp }).optional(),
  })),
});
const transaction = z.object({ id, accountId: id, amount: money, currency: z.string(),
  direction: z.enum(['DEBIT', 'CREDIT']), category: z.string(), merchant: z.string(), occurredAt: timestamp, isAnomaly: z.boolean() });
const bankCard = z.object({ id, type: z.enum(['DEBIT', 'CREDIT', 'VIRTUAL']), network: z.string(), numberMasked: z.string(),
  status: z.enum(['ACTIVE', 'FROZEN', 'LOST', 'PENDING']), creditLimit: money.optional(), availableLimit: money.optional(), monthlyLimit: money.optional(),
  limits: z.array(z.object({ category: z.string(), amount: money })),
});
const product = z.object({ id, code: z.string(), name: z.string(), riskLevel: z.enum(['R1', 'R2', 'R3', 'R4', 'R5']),
  annualYieldRate: decimal, termDays: z.number().int().nonnegative(), minAmount: money, description: z.string().optional() });
const holding = z.object({ id, productId: id, productName: z.string(), product, amount: money, status: z.enum(['HOLDING', 'REDEEMED']),
  marketValue: decimal.optional(), profit: decimal.optional(), boughtAt: timestamp, riskLevel: z.enum(['R1', 'R2', 'R3', 'R4', 'R5']) });
const receipt = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('budget'), name: z.string(), amount: money, status: z.enum(['RESERVED', 'USED', 'RELEASED']), purpose: z.string().optional(), dueDate: timestamp.optional() }),
  z.object({ kind: z.enum(['investmentPurchase', 'investmentRedemption']), success: z.boolean(), amount: money, newBalance: money, occurredAt: timestamp,
    redemptionValuation: decimal.optional(), settlementRounding: z.literal('HALF_UP').optional() }),
]);
const card = z.discriminatedUnion('type', [
  z.object({ type: z.literal('balance'), data: z.object({ totalAvailable: money, currency: z.string(), asOf: timestamp,
    accounts: z.array(z.object({ id, type: z.enum(['CHECKING', 'SAVINGS']), name: z.string(), numberMasked: z.string(), balance: money, currency: z.string() })) }) }),
  z.object({ type: z.literal('transfer'), data: z.object({ success: z.literal(true), transactionId: id, sourceAccountId: id,
    newBalance: money, amount: money, occurredAt: timestamp, recipient: z.object({ name: z.string(), phone: z.string(), bank: z.string().optional() }) }) }),
  z.object({ type: z.literal('confirmation'), action }),
  z.object({ type: z.literal('mfa'), actionId: id, hint: z.string().optional(), action: action.partial({ toolName: true }).optional(), status: actionStatus.optional(), message: z.string().optional() }),
  z.object({ type: z.literal('transactions'), data: z.array(transaction) }),
  z.object({ type: z.literal('spending'), data: z.object({ month: z.string(), total: money, prevTotal: money, momChangePct: decimal,
    byCategory: z.array(z.object({ category: z.string(), amount: money, share: decimal })),
    monthlyTrend: z.array(z.object({ month: z.string(), amount: money })),
    topMerchant: z.object({ merchant: z.string(), amount: money, count: z.number().int().nonnegative() }).nullable(), largest: transaction.nullable(),
  }) }),
  z.object({ type: z.literal('cards'), data: z.array(bankCard) }),
  z.object({ type: z.literal('investments'), data: z.object({ products: z.array(product).optional(), holdings: z.array(holding).optional(),
    comparison: z.object({ products: z.array(product), highestRateId: id.optional(), lowestRiskId: id.optional() }).optional() }) }),
  z.object({ type: z.literal('subscriptions'), data: z.array(z.object({ id, name: z.string(), amount: money, cycle: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']),
    nextChargeAt: timestamp, status: z.enum(['ACTIVE', 'CANCELLED']), remind: z.boolean() })) }),
  z.object({ type: z.literal('contacts'), data: z.array(z.object({ name: z.string(), phone: z.string(), bank: z.string().optional(), remark: z.string().optional() })) }),
  z.object({ type: z.literal('dashboard'), data: z.object({ totalAssets: decimal, checkingBalance: money, creditAvailable: money, monthSpend: money, month: z.string(), asOf: timestamp }) }),
  z.object({ type: z.literal('scheduled'), created: z.boolean(), data: z.array(z.object({ name: z.string(), kind: z.enum(['REMINDER', 'PAYMENT', 'TRANSFER']), runAt: timestamp,
    status: z.enum(['SCHEDULED', 'DISPATCHING', 'AWAITING_CONFIRMATION', 'DONE', 'FAILED', 'CANCELLED']), requiresConfirmation: z.boolean() })) }),
  z.object({ type: z.literal('receipt'), data: receipt }),
  z.object({ type: z.literal('anomaly'), data: z.object({ anomalies: z.array(z.object({ transaction, reason: z.string(), severity: z.enum(['low', 'medium', 'high']), acknowledged: z.boolean().optional() })),
    cards: z.array(bankCard).optional(), scanned: z.number().int().nonnegative(), generatedAt: timestamp }) }),
  z.object({ type: z.literal('plan'), plan }),
  z.object({ type: z.literal('error'), message: z.string(), code: errorCode.optional() }),
]);
const message = z.object({ id, role: z.enum(['user', 'assistant', 'system', 'tool']), content: z.string(), timestamp,
  retryRequest: z.string().optional(), cards: z.array(card).optional(), toolEvents: z.array(toolEvent).optional() }).superRefine((value, context) => {
  if (value.role === 'tool' && (value.content !== '' || value.toolEvents?.length !== 1 ||
      value.toolEvents[0].messageId !== value.id)) {
    context.addIssue({ code: 'custom', message: 'A tool row must identify exactly one call and contain no prose.' });
  }
  if ((value.role === 'assistant' || value.role === 'user') &&
      ((value.cards?.length ?? 0) > 0 || (value.toolEvents?.length ?? 0) > 0)) {
    context.addIssue({ code: 'custom', message: 'Prose messages cannot own tool results or business cards.' });
  }
});
const event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), sessionId: id, runId: id.optional() }),
  z.object({ type: z.enum(['message_start', 'message_end']), message }),
  z.object({ type: z.literal('text_delta'), delta: z.string() }),
  z.object({ type: z.literal('reply_progress'), phase: z.enum(['generating', 'checking', 'repairing']) }),
  z.object({ type: z.enum(['tool_start', 'tool_end']), toolEvent }),
  z.object({ type: z.literal('card'), card, messageId: id.optional() }),
  z.object({ type: z.literal('plan_update'), plan, generation: z.number().int().nonnegative().optional(), messageId: id.optional() }),
  z.object({ type: z.literal('confirmation_required'), actionId: id, action }),
  z.object({ type: z.literal('mfa_required'), actionId: id, action: action.optional(), hint: z.string().optional() }),
  z.object({ type: z.literal('action_settled'), actionId: id, status: actionStatus, message: z.string().optional() }),
  z.object({ type: z.literal('security_event'), kind: id, code: z.string().optional(), reason: z.string().optional(),
    actionId: id.optional(), attemptsLeft: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().nonnegative().optional(), message: z.string().optional() }),
  z.object({ type: z.literal('error'), message: z.string(), code: errorCode.optional() }),
  z.object({ type: z.literal('done') }),
]);

/** Validate before folding; retain the original payload and exact financial strings. */
export function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  return event.safeParse(value).success;
}

/** History and streamed messages share the same renderer requirements. */
export function isChatMessage(value: unknown): value is ChatMessage {
  return message.safeParse(value).success;
}

/** Plan restoration accepts only complete renderable snapshots. */
export function isTaskPlan(value: unknown): value is TaskPlan {
  return plan.safeParse(value).success;
}

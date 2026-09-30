/**
 * subscription — `list_subscriptions`, `cancel_subscription`, `set_subscription_reminder`
 *
 * Subscription reads and mutations. TypeBox param schemas; `execute` is meant to call the Banking
 * SDK and THROW `AppError` on failure. The `run<X>(userId, args)` runners are the model-free path
 * used by `executeDirect`; they CATCH and return `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `list_subscriptions` 🟢 GREEN; `cancel_subscription` / `set_subscription_reminder`
 * 🟡 YELLOW (require confirmation). Tier is decided by `security/`, NOT here. `userId` is
 * SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/* --------------------------------------------------------- list_subscriptions */

/** `list_subscriptions` params — none. */
export const ListSubscriptionsParams = Type.Object({});
export type ListSubscriptionsArgs = Static<typeof ListSubscriptionsParams>;

/** Registered AgentTool for `list_subscriptions` (🟢 GREEN). */
export const listSubscriptionsTool: AgentTool<ListSubscriptionsArgs> = {
  name: 'list_subscriptions',
  label: '订阅列表',
  description: '列出当前用户的自动续费订阅（金额、周期、下次扣费、状态）。',
  parameters: ListSubscriptionsParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.subscription.listSubscriptions(userId)`. */
export async function runListSubscriptions(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* -------------------------------------------------------- cancel_subscription */

/** `cancel_subscription` params. */
export const CancelSubscriptionParams = Type.Object({
  subscriptionId: Type.String({ description: '订阅 id' }),
});
export type CancelSubscriptionArgs = Static<typeof CancelSubscriptionParams>;

/** Registered AgentTool for `cancel_subscription` (🟡 YELLOW). */
export const cancelSubscriptionTool: AgentTool<CancelSubscriptionArgs> = {
  name: 'cancel_subscription',
  label: '取消订阅',
  description: '取消指定自动续费订阅（需要用户确认）。',
  parameters: CancelSubscriptionParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.subscription.cancelSubscription(subscriptionId)`. */
export async function runCancelSubscription(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* -------------------------------------------------- set_subscription_reminder */

/** `set_subscription_reminder` params. */
export const SetSubscriptionReminderParams = Type.Object({
  subscriptionId: Type.String({ description: '订阅 id' }),
  remind: Type.Boolean({ description: 'true 开启扣费提醒，false 关闭' }),
});
export type SetSubscriptionReminderArgs = Static<typeof SetSubscriptionReminderParams>;

/** Registered AgentTool for `set_subscription_reminder` (🟡 YELLOW). */
export const setSubscriptionReminderTool: AgentTool<SetSubscriptionReminderArgs> = {
  name: 'set_subscription_reminder',
  label: '订阅提醒',
  description: '开启/关闭指定订阅的扣费提醒（需要用户确认）。',
  parameters: SetSubscriptionReminderParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.subscription.setSubscriptionReminder(subscriptionId, remind)`. */
export async function runSetSubscriptionReminder(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

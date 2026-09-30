/**
 * subscription — `list_subscriptions`, `cancel_subscription`, `set_subscription_reminder`
 *
 * Subscription reads and mutations. TypeBox param schemas; `execute` calls the Banking SDK and
 * THROWS `AppError` on failure. The `run<X>(userId, args)` runners are the model-free path used by
 * `executeDirect`; they CATCH and return `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `list_subscriptions` 🟢 GREEN; `cancel_subscription` / `set_subscription_reminder`
 * 🟡 YELLOW (require confirmation). Tier is decided by `security/`, NOT here. `userId` is
 * SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import { banking } from '@/banking-sdk';
import type { SubscriptionCycle } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { AppError } from '@/lib/errors';
import { formatCNY } from '@/lib/money';
import type { ToolExecutionResult } from './index';

/** Chinese labels for a subscription billing cycle (for user-facing summaries). */
const CYCLE_LABELS: Record<SubscriptionCycle, string> = {
  MONTHLY: '每月',
  QUARTERLY: '每季',
  YEARLY: '每年',
};

/* --------------------------------------------------------- list_subscriptions */

/** `list_subscriptions` params — none. */
export const ListSubscriptionsParams = Type.Object({});
export type ListSubscriptionsArgs = Static<typeof ListSubscriptionsParams>;

/** Build the `list_subscriptions` tool bound to `userId` (🟢 GREEN — auto-executes). */
export function createListSubscriptionsTool(
  userId: string,
): AgentTool<typeof ListSubscriptionsParams> {
  return {
    name: 'list_subscriptions',
    label: '订阅列表',
    description: '列出当前用户的自动续费订阅（金额、周期、下次扣费、状态）。',
    parameters: ListSubscriptionsParams,
    execute: async (_toolCallId, params) => {
      const result = await runListSubscriptions(userId, params as Record<string, unknown>);
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? '查询订阅失败');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '查询订阅成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.subscription.listSubscriptions(userId)`. */
export async function runListSubscriptions(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const subs = await banking.subscription.listSubscriptions(userId);
    const summary =
      subs.length === 0
        ? '当前没有自动续费订阅'
        : `共 ${subs.length} 个订阅：${subs
            .map((sub) => {
              const cycle = CYCLE_LABELS[sub.cycle] ?? sub.cycle;
              const remind = sub.remind ? '，已开启提醒' : '';
              return `${sub.name} ${formatCNY(sub.amount)}/${cycle}，下次扣费 ${formatDateTime(
                sub.nextChargeAt,
              )}${remind}`;
            })
            .join('；')}`;
    return { ok: true, data: subs, summary };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

/* -------------------------------------------------------- cancel_subscription */

/** `cancel_subscription` params. */
export const CancelSubscriptionParams = Type.Object({
  subscriptionId: Type.String({ description: '订阅 id' }),
});
export type CancelSubscriptionArgs = Static<typeof CancelSubscriptionParams>;

/** Build the `cancel_subscription` tool bound to `userId` (🟡 YELLOW — confirmation enforced by `security/`). */
export function createCancelSubscriptionTool(
  userId: string,
): AgentTool<typeof CancelSubscriptionParams> {
  return {
    name: 'cancel_subscription',
    label: '取消订阅',
    description: '取消指定自动续费订阅（需要用户确认）。',
    parameters: CancelSubscriptionParams,
    execute: async (_toolCallId, params) => {
      const result = await runCancelSubscription(userId, params as Record<string, unknown>);
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? '取消订阅失败');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '取消订阅成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.subscription.cancelSubscription(subscriptionId)`. */
export async function runCancelSubscription(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const { subscriptionId } = args as unknown as CancelSubscriptionArgs;
  try {
    const sub = await banking.subscription.cancelSubscription(subscriptionId);
    const cycle = CYCLE_LABELS[sub.cycle] ?? sub.cycle;
    return {
      ok: true,
      data: sub,
      summary: `已取消订阅「${sub.name}」（原 ${formatCNY(sub.amount)}/${cycle}）`,
    };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

/* -------------------------------------------------- set_subscription_reminder */

/** `set_subscription_reminder` params. */
export const SetSubscriptionReminderParams = Type.Object({
  subscriptionId: Type.String({ description: '订阅 id' }),
  remind: Type.Boolean({ description: 'true 开启扣费提醒，false 关闭' }),
});
export type SetSubscriptionReminderArgs = Static<typeof SetSubscriptionReminderParams>;

/** Build the `set_subscription_reminder` tool bound to `userId` (🟡 YELLOW — confirmation enforced by `security/`). */
export function createSetSubscriptionReminderTool(
  userId: string,
): AgentTool<typeof SetSubscriptionReminderParams> {
  return {
    name: 'set_subscription_reminder',
    label: '订阅提醒',
    description: '开启/关闭指定订阅的扣费提醒（需要用户确认）。',
    parameters: SetSubscriptionReminderParams,
    execute: async (_toolCallId, params) => {
      const result = await runSetSubscriptionReminder(userId, params as Record<string, unknown>);
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? '设置订阅提醒失败');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '设置订阅提醒成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.subscription.setSubscriptionReminder(subscriptionId, remind)`. */
export async function runSetSubscriptionReminder(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const input = args as unknown as SetSubscriptionReminderArgs;
  try {
    const sub = await banking.subscription.setSubscriptionReminder(
      input.subscriptionId,
      input.remind,
    );
    const action = sub.remind ? '开启' : '关闭';
    return {
      ok: true,
      data: sub,
      summary: `已${action}订阅「${sub.name}」的扣费提醒`,
    };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

/**
 * card — `get_cards`, `set_card_limit`, `freeze_card`, `unfreeze_card`, `apply_virtual_card`,
 * `report_lost_card`, `replace_card`.
 *
 * Card reads and mutations. TypeBox param schemas; `execute` returns native Pi success or failure content.
 * The `run<X>(userId, args, opts?)` runners are the model-free path used by
 * `executeDirect`; they CATCH and return `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `get_cards` GREEN; `set_card_limit` YELLOW (confirmation);
 * `freeze_card` / `unfreeze_card` / `apply_virtual_card` / `report_lost_card` / `replace_card` RED
 * (confirmation and MFA).
 * The tier is decided by `security/`, NOT here — this module only declares capability. `userId` is
 * SERVER-INJECTED; the model never supplies it.
 *
 * Two loss flows are deliberately distinct: `freeze_card`/`unfreeze_card` are a REVERSIBLE temporary
 * lock, while `report_lost_card` is TERMINAL (the card stays `LOST` and is never revived) —
 * `replace_card` issues a new card for an already-lost card.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import type { CardStatus, CardType, CardView } from '@/banking-sdk';
import { centsToMoney, formatCNY, moneyToCents } from '@/lib/money';
import type { ToolExecutionResult, ToolRunOptions } from './index';
import { MoneyParameter } from './money-schema';
import { toModelToolResult, toolFailure } from './result';
import { SPENDING_CATEGORIES } from '@/lib/contracts/spending';

/** Chinese labels for a card type (for user-facing summaries). */
const CARD_TYPE_LABELS: Record<CardType, string> = {
  DEBIT: '借记卡',
  CREDIT: '信用卡',
  VIRTUAL: '虚拟卡',
};

/** Chinese labels for a card status (for user-facing summaries). */
const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  ACTIVE: '正常',
  FROZEN: '已冻结',
  LOST: '已挂失',
  PENDING: '待激活',
};

/** One short fragment per card, e.g. `借记卡 ****8821（正常）`. */
function describeCard(card: CardView): string {
  const type = CARD_TYPE_LABELS[card.type] ?? card.type;
  const status = CARD_STATUS_LABELS[card.status] ?? card.status;
  return `${type} ${card.numberMasked}（${status}）`;
}

/* ------------------------------------------------------------------ get_cards */

/** `get_cards` params — none. */
export const GetCardsParams = Type.Object({});
export type GetCardsArgs = Static<typeof GetCardsParams>;

/** Build the `get_cards` tool bound to `userId` (🟢 GREEN — auto-executes). */
export function createGetCardsTool(userId: string): AgentTool<typeof GetCardsParams> {
  return {
    name: 'get_cards',
    label: '我的卡片',
    description: '查询当前用户全部银行卡（借记卡/信用卡/虚拟卡）及状态、额度。',
    parameters: GetCardsParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runGetCards(userId, params as Record<string, unknown>));
    },
  };
}

/** Model-free runner — `banking.card.getCards(userId)`. */
export async function runGetCards(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const cards = await banking.card.getCards(userId);
    const summary =
      cards.length === 0
        ? '当前没有银行卡'
        : `共 ${cards.length} 张卡片：${cards.map(describeCard).join('、')}`;
    return { ok: true, data: cards, summary };
  } catch (e) {
    return toolFailure(e);
  }
}
/* -------------------------------------------------------------- set_card_limit */

/** `set_card_limit` params (SDK `SetCardLimitInput` minus nothing — all fields come from the model). */
export const SetCardLimitParams = Type.Object({
  cardId: Type.String({ description: '卡片 id' }),
  category: Type.Union(SPENDING_CATEGORIES.map(category => Type.Literal(category)), { description: 'Supported spending category.' }),
  amount: MoneyParameter,
});
export type SetCardLimitArgs = Static<typeof SetCardLimitParams>;

/** Build the `set_card_limit` tool bound to `userId` (🟡 YELLOW — confirmation enforced by `security/`). */
export function createSetCardLimitTool(userId: string): AgentTool<typeof SetCardLimitParams> {
  return {
    name: 'set_card_limit',
    label: '设置分类限额',
    description: '为指定卡片设置某个消费分类的限额，不影响授信额度（需要用户确认）。',
    parameters: SetCardLimitParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runSetCardLimit(userId, params));
    },
  };
}

/** Model-free runner — `banking.card.setCardLimit({ cardId, category, amount })`. */
export async function runSetCardLimit(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const input = args as unknown as SetCardLimitArgs;
  try {
    const card = await banking.card.setCardLimit({
      userId,
      cardId: input.cardId,
      category: input.category,
      amount: centsToMoney(moneyToCents(input.amount)),
    });
    const limit = card.limits.find((entry) => entry.category === input.category);
    const amount = limit ? limit.amount : input.amount;
    return {
      ok: true,
      data: card,
      summary: `已为卡片 ${card.numberMasked} 的「${input.category}」设置分类消费限额 ${formatCNY(amount)}`,
    };
  } catch (e) {
    return toolFailure(e);
  }
}

/* ----------------------------------------------------------------- freeze_card */

/** `freeze_card` params. */
export const FreezeCardParams = Type.Object({
  cardId: Type.String({ description: '卡片 id' }),
});
export type FreezeCardArgs = Static<typeof FreezeCardParams>;

/** Build the `freeze_card` tool bound to `userId`; RED confirmation and MFA are enforced by security. */
export function createFreezeCardTool(userId: string): AgentTool<typeof FreezeCardParams> {
  return {
    name: 'freeze_card',
    label: '冻结卡片',
    description: '临时锁卡：冻结指定卡片，可随时解冻（需要用户确认）。',
    parameters: FreezeCardParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runFreezeCard(userId, params));
    },
  };
}

/** Model-free runner — `banking.card.freezeCard(cardId)`. */
export async function runFreezeCard(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const { cardId } = args as unknown as FreezeCardArgs;
  try {
    const card = await banking.card.freezeCard(cardId, userId);
    const status = CARD_STATUS_LABELS[card.status] ?? card.status;
    return { ok: true, data: card, summary: `卡片 ${card.numberMasked} 已冻结（当前状态：${status}）` };
  } catch (e) {
    return toolFailure(e);
  }
}

/* --------------------------------------------------------------- unfreeze_card */

/** `unfreeze_card` params. */
export const UnfreezeCardParams = Type.Object({
  cardId: Type.String({ description: '卡片 id' }),
});
export type UnfreezeCardArgs = Static<typeof UnfreezeCardParams>;

/** Build the `unfreeze_card` tool bound to `userId` (🔴 RED — MFA enforced by `security/`). */
export function createUnfreezeCardTool(userId: string): AgentTool<typeof UnfreezeCardParams> {
  return {
    name: 'unfreeze_card',
    label: '解冻卡片',
    description: '解除临时锁卡：解冻指定卡片（高风险，需要短信验证码验证）。',
    parameters: UnfreezeCardParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runUnfreezeCard(userId, params));
    },
  };
}

/** Model-free runner — `banking.card.unfreezeCard(cardId)`. */
export async function runUnfreezeCard(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const { cardId } = args as unknown as UnfreezeCardArgs;
  try {
    const card = await banking.card.unfreezeCard(cardId, userId);
    const status = CARD_STATUS_LABELS[card.status] ?? card.status;
    return { ok: true, data: card, summary: `卡片 ${card.numberMasked} 已解冻（当前状态：${status}）` };
  } catch (e) {
    return toolFailure(e);
  }
}

/* ------------------------------------------------------------ report_lost_card */

/** `report_lost_card` params (SDK `ReportLostCardInput` + `cardId`). */
export const ReportLostCardParams = Type.Object({
  cardId: Type.String({ description: '卡片 id' }),
  reason: Type.Optional(Type.String({ description: '挂失原因' })),
});
export type ReportLostCardArgs = Static<typeof ReportLostCardParams>;

/** Build the `report_lost_card` tool bound to `userId` (🔴 RED — MFA enforced by `security/`). */
export function createReportLostCardTool(userId: string): AgentTool<typeof ReportLostCardParams> {
  return {
    name: 'report_lost_card',
    label: '挂失卡片',
    description: '正式挂失：挂失指定卡片，挂失永久且不可恢复，如需继续用卡请补办新卡（高风险，需要短信验证码验证）。',
    parameters: ReportLostCardParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runReportLostCard(userId, params));
    },
  };
}

/** Model-free runner — `banking.card.reportLostCard(cardId, { reason })`. */
export async function runReportLostCard(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const input = args as unknown as ReportLostCardArgs;
  try {
    const card = await banking.card.reportLostCard(input.cardId, userId, { reason: input.reason });
    const reason = input.reason ? `（原因：${input.reason}）` : '';
    return { ok: true, data: card, summary: `卡片 ${card.numberMasked} 已挂失${reason}` };
  } catch (e) {
    return toolFailure(e);
  }
}

/* --------------------------------------------------------- apply_virtual_card */

/** `apply_virtual_card` params (SDK `ApplyVirtualCardInput` minus the server-owned `userId`). */
export const ApplyVirtualCardParams = Type.Object({
  monthlyLimit: Type.Optional(MoneyParameter),
});
export type ApplyVirtualCardArgs = Static<typeof ApplyVirtualCardParams>;

/** Build the `apply_virtual_card` tool bound to `userId` (🔴 RED — MFA enforced by `security/`). */
export function createApplyVirtualCardTool(userId: string): AgentTool<typeof ApplyVirtualCardParams> {
  return {
    name: 'apply_virtual_card',
    label: '申请虚拟卡',
    description: '申请一张虚拟卡，可选设置月限额（高风险，需要短信验证码验证）。',
    parameters: ApplyVirtualCardParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runApplyVirtualCard(userId, params));
    },
  };
}

/**
 * Model-free runner — `banking.card.applyVirtualCard({ userId, monthlyLimit, idempotencyKey })`.
 * `opts.idempotencyKey` is the at-most-once execution identity: a replay of the SAME key returns the
 * original card instead of issuing a second one.
 */
export async function runApplyVirtualCard(
  userId: string,
  args: Record<string, unknown>,
  opts?: ToolRunOptions,
): Promise<ToolExecutionResult> {
  const input = args as unknown as ApplyVirtualCardArgs;
  try {
    const card = await banking.card.applyVirtualCard({
      userId,
      monthlyLimit: input.monthlyLimit,
      idempotencyKey: opts?.idempotencyKey,
    });
    const limit = card.monthlyLimit === undefined ? '未设置月限额' : `月限额 ${formatCNY(card.monthlyLimit)}`;
    return { ok: true, data: card, summary: `虚拟卡 ${card.numberMasked} 已开通（${limit}）` };
  } catch (e) {
    return toolFailure(e);
  }
}

/* ------------------------------------------------------------------ replace_card */

/** `replace_card` params. */
export const ReplaceCardParams = Type.Object({
  cardId: Type.String({ description: '原卡片 id' }),
});
export type ReplaceCardArgs = Static<typeof ReplaceCardParams>;

/** Build the `replace_card` tool bound to `userId` (🔴 RED — MFA enforced by `security/`). */
export function createReplaceCardTool(userId: string): AgentTool<typeof ReplaceCardParams> {
  return {
    name: 'replace_card',
    label: '补办卡片',
    description: '为已挂失的卡片补办一张新卡，原卡片保持挂失状态（高风险，需要短信验证码验证）。',
    parameters: ReplaceCardParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runReplaceCard(userId, params));
    },
  };
}

/** Model-free runner — `banking.card.replaceCard(cardId, userId)`. */
export async function runReplaceCard(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const { cardId } = args as unknown as ReplaceCardArgs;
  try {
    const card = await banking.card.replaceCard(cardId, userId);
    const status = CARD_STATUS_LABELS[card.status] ?? card.status;
    return { ok: true, data: card, summary: `已为原挂失卡片补办新卡 ${card.numberMasked}（当前状态：${status}）` };
  } catch (e) {
    return toolFailure(e);
  }
}

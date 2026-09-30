/**
 * card — `get_cards`, `set_card_limit`, `freeze_card`, `unfreeze_card`, `report_lost_card`,
 * `apply_virtual_card`
 *
 * Card reads and mutations. TypeBox param schemas; `execute` is meant to call the Banking SDK and
 * THROW `AppError` on failure. The `run<X>(userId, args)` runners are the model-free path used by
 * `executeDirect`; they CATCH and return `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `get_cards` 🟢 GREEN; `set_card_limit` / `freeze_card` / `apply_virtual_card` 🟡 YELLOW
 * (require confirmation); `unfreeze_card` / `report_lost_card` 🔴 RED (require MFA).
 * The tier is decided by `security/`, NOT here — this module only declares capability. `userId` is
 * SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/* ------------------------------------------------------------------ get_cards */

/** `get_cards` params — none. */
export const GetCardsParams = Type.Object({});
export type GetCardsArgs = Static<typeof GetCardsParams>;

/** Registered AgentTool for `get_cards` (🟢 GREEN). */
export const getCardsTool: AgentTool<GetCardsArgs> = {
  name: 'get_cards',
  label: '我的卡片',
  description: '查询当前用户全部银行卡（借记卡/信用卡/虚拟卡）及状态、额度。',
  parameters: GetCardsParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.card.getCards(userId)`. */
export async function runGetCards(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* -------------------------------------------------------------- set_card_limit */

/** `set_card_limit` params (SDK `SetCardLimitInput`). */
export const SetCardLimitParams = Type.Object({
  cardId: Type.String({ description: '卡片 id' }),
  category: Type.String({ description: '限额分类，如 娱乐/餐饮/购物/出行' }),
  amount: Type.Number({ description: '该分类限额（CNY）' }),
});
export type SetCardLimitArgs = Static<typeof SetCardLimitParams>;

/** Registered AgentTool for `set_card_limit` (🟡 YELLOW). */
export const setCardLimitTool: AgentTool<SetCardLimitArgs> = {
  name: 'set_card_limit',
  label: '设置卡片限额',
  description: '为指定卡片设置某消费分类的限额（需要用户确认）。',
  parameters: SetCardLimitParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.card.setCardLimit({ cardId, category, amount })`. */
export async function runSetCardLimit(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* ----------------------------------------------------------------- freeze_card */

/** `freeze_card` params. */
export const FreezeCardParams = Type.Object({
  cardId: Type.String({ description: '卡片 id' }),
});
export type FreezeCardArgs = Static<typeof FreezeCardParams>;

/** Registered AgentTool for `freeze_card` (🟡 YELLOW). */
export const freezeCardTool: AgentTool<FreezeCardArgs> = {
  name: 'freeze_card',
  label: '冻结卡片',
  description: '冻结指定卡片（需要用户确认）。',
  parameters: FreezeCardParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.card.freezeCard(cardId)`. */
export async function runFreezeCard(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* --------------------------------------------------------------- unfreeze_card */

/** `unfreeze_card` params. */
export const UnfreezeCardParams = Type.Object({
  cardId: Type.String({ description: '卡片 id' }),
});
export type UnfreezeCardArgs = Static<typeof UnfreezeCardParams>;

/** Registered AgentTool for `unfreeze_card` (🔴 RED). */
export const unfreezeCardTool: AgentTool<UnfreezeCardArgs> = {
  name: 'unfreeze_card',
  label: '解冻卡片',
  description: '解冻指定卡片（高风险，需要短信验证码验证）。',
  parameters: UnfreezeCardParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.card.unfreezeCard(cardId)`. */
export async function runUnfreezeCard(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* ------------------------------------------------------------ report_lost_card */

/** `report_lost_card` params (SDK `ReportLostCardInput`). */
export const ReportLostCardParams = Type.Object({
  cardId: Type.String({ description: '卡片 id' }),
  reason: Type.Optional(Type.String({ description: '挂失原因' })),
});
export type ReportLostCardArgs = Static<typeof ReportLostCardParams>;

/** Registered AgentTool for `report_lost_card` (🔴 RED). */
export const reportLostCardTool: AgentTool<ReportLostCardArgs> = {
  name: 'report_lost_card',
  label: '挂失卡片',
  description: '对指定卡片进行挂失（高风险，需要短信验证码验证）。',
  parameters: ReportLostCardParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.card.reportLostCard(cardId, { reason })`. */
export async function runReportLostCard(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* ---------------------------------------------------------- apply_virtual_card */

/** `apply_virtual_card` params (SDK `ApplyVirtualCardInput`; `userId` is server-injected). */
export const ApplyVirtualCardParams = Type.Object({
  label: Type.Optional(Type.String({ description: '虚拟卡备注/用途' })),
});
export type ApplyVirtualCardArgs = Static<typeof ApplyVirtualCardParams>;

/** Registered AgentTool for `apply_virtual_card` (🟡 YELLOW). */
export const applyVirtualCardTool: AgentTool<ApplyVirtualCardArgs> = {
  name: 'apply_virtual_card',
  label: '申请虚拟卡',
  description: '为当前用户申请一张虚拟卡（需要用户确认）。',
  parameters: ApplyVirtualCardParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.card.applyVirtualCard({ userId, label })`. */
export async function runApplyVirtualCard(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

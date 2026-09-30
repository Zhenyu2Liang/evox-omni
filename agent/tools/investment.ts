/**
 * investment — `list_investments`, `compare_investments`, `get_investment_holdings`,
 * `subscribe_investment`, `redeem_investment`
 *
 * Investment product/holding reads and subscribe/redeem mutations. TypeBox param schemas;
 * `execute` is meant to call the Banking SDK and THROW `AppError` on failure. The
 * `run<X>(userId, args)` runners are the model-free path used by `executeDirect`; they CATCH and
 * return `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `list_investments` / `compare_investments` / `get_investment_holdings` 🟢 GREEN;
 * `subscribe_investment` / `redeem_investment` 🔴 RED (require MFA). Tier is decided by
 * `security/`, NOT here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/* ----------------------------------------------------------- list_investments */

/** `list_investments` params (SDK `ProductQuery`). */
export const ListInvestmentsParams = Type.Object({
  riskLevel: Type.Optional(Type.String({ description: '风险等级过滤：R1 | R2 | R3 | R4 | R5' })),
});
export type ListInvestmentsArgs = Static<typeof ListInvestmentsParams>;

/** Registered AgentTool for `list_investments` (🟢 GREEN). */
export const listInvestmentsTool: AgentTool<ListInvestmentsArgs> = {
  name: 'list_investments',
  label: '理财产品',
  description: '列出理财产品（代码、风险等级、预期年化、期限、起投金额），可按风险等级过滤。',
  parameters: ListInvestmentsParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.investment.listProducts({ riskLevel })`. */
export async function runListInvestments(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* -------------------------------------------------------- compare_investments */

/** `compare_investments` params — product ids to compare. */
export const CompareInvestmentsParams = Type.Object({
  productIds: Type.Array(Type.String(), { minItems: 1, description: '要比较的产品 id 列表' }),
});
export type CompareInvestmentsArgs = Static<typeof CompareInvestmentsParams>;

/** Registered AgentTool for `compare_investments` (🟢 GREEN). */
export const compareInvestmentsTool: AgentTool<CompareInvestmentsArgs> = {
  name: 'compare_investments',
  label: '对比理财',
  description: '对比多个理财产品，标出最高预期收益率与最低风险的产品。',
  parameters: CompareInvestmentsParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.investment.compareInvestments(productIds)`. */
export async function runCompareInvestments(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* --------------------------------------------------- get_investment_holdings */

/** `get_investment_holdings` params — none. */
export const GetInvestmentHoldingsParams = Type.Object({});
export type GetInvestmentHoldingsArgs = Static<typeof GetInvestmentHoldingsParams>;

/** Registered AgentTool for `get_investment_holdings` (🟢 GREEN). */
export const getInvestmentHoldingsTool: AgentTool<GetInvestmentHoldingsArgs> = {
  name: 'get_investment_holdings',
  label: '我的持仓',
  description: '列出当前用户的理财持仓（产品、本金、市值、收益、状态）。',
  parameters: GetInvestmentHoldingsParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.investment.listHoldings(userId)`. */
export async function runGetInvestmentHoldings(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* ------------------------------------------------------ subscribe_investment */

/** `subscribe_investment` params (SDK `SubscribeInvestmentInput`; `userId` server-injected). */
export const SubscribeInvestmentParams = Type.Object({
  productId: Type.String({ description: '产品 id' }),
  amount: Type.Number({ description: '申购金额（CNY，需 ≥ 产品起投金额）' }),
});
export type SubscribeInvestmentArgs = Static<typeof SubscribeInvestmentParams>;

/** Registered AgentTool for `subscribe_investment` (🔴 RED). */
export const subscribeInvestmentTool: AgentTool<SubscribeInvestmentArgs> = {
  name: 'subscribe_investment',
  label: '申购理财',
  description: '申购指定理财产品（高风险，需要短信验证码验证）。',
  parameters: SubscribeInvestmentParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.investment.subscribeInvestment({ userId, productId, amount })`. */
export async function runSubscribeInvestment(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* --------------------------------------------------------- redeem_investment */

/** `redeem_investment` params (SDK `RedeemInvestmentInput`; `userId` server-injected). */
export const RedeemInvestmentParams = Type.Object({
  holdingId: Type.String({ description: '持仓 id' }),
});
export type RedeemInvestmentArgs = Static<typeof RedeemInvestmentParams>;

/** Registered AgentTool for `redeem_investment` (🔴 RED). */
export const redeemInvestmentTool: AgentTool<RedeemInvestmentArgs> = {
  name: 'redeem_investment',
  label: '赎回理财',
  description: '赎回指定理财持仓（高风险，需要短信验证码验证）。',
  parameters: RedeemInvestmentParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.investment.redeemInvestment({ userId, holdingId })`. */
export async function runRedeemInvestment(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

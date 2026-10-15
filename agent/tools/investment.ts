/**
 * investment — `list_investments`, `compare_investments`, `get_investment_holdings`,
 * `subscribe_investment`, `redeem_investment`
 *
 * Investment product/holding reads and subscribe/redeem mutations. TypeBox param schemas;
 * `execute` returns native Pi success or failure content. The `run<X>(userId, args)`
 * runners are the model-free path used by `executeDirect`; they CATCH and return
 * `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `list_investments` / `compare_investments` / `get_investment_holdings` 🟢 GREEN;
 * `subscribe_investment` / `redeem_investment` 🔴 RED (require MFA). Tier is decided by
 * `security/`, NOT here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import type {
  HoldingView,
  InvestResult,
  InvestmentComparison,
  InvestmentRiskLevel,
  ProductView,
} from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { addMoney, centsToMoney, formatCNY, moneyToCents, type MoneyInput } from '@/lib/money';
import { addDecimal, formatDecimalCNY, rateRatioToPercent } from '@/lib/decimal';
import type { ToolExecutionResult, ToolRunOptions } from './index';
import { MoneyParameter } from './money-schema';
import { toModelToolResult, toolFailure } from './result';

/* ----------------------------------------------------------- list_investments */

/** `list_investments` params (SDK `ProductQuery`). */
export const ListInvestmentsParams = Type.Object({
  riskLevel: Type.Optional(Type.Union([
    Type.Literal('R1'), Type.Literal('R2'), Type.Literal('R3'), Type.Literal('R4'), Type.Literal('R5'),
  ], { description: 'Investment risk filter from R1 through R5.' })),
});
export type ListInvestmentsArgs = Static<typeof ListInvestmentsParams>;

/** Registered AgentTool for `list_investments` (🟢 GREEN). */
export function createListInvestmentsTool(
  userId: string,
): AgentTool<typeof ListInvestmentsParams> {
  return {
    name: 'list_investments',
    label: '理财产品',
    description: '列出理财产品（代码、风险等级、预期年化、期限、起投金额），可按风险等级过滤。',
    parameters: ListInvestmentsParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runListInvestments(userId, params));
    },
  };
}

/** Model-free runner — `banking.investment.listProducts({ riskLevel })`. */
export async function runListInvestments(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const riskLevel = args.riskLevel as InvestmentRiskLevel | undefined;
    const products: ProductView[] = await banking.investment.listProducts(
      riskLevel === undefined ? {} : { riskLevel },
    );
    if (products.length === 0) {
      return { ok: true, data: products, summary: '暂无符合条件的理财产品。' };
    }
    const detail = products
      .map(
        (p) =>
          `${p.code} ${p.name}（${p.riskLevel}，预期年化 ${rateRatioToPercent(p.annualYieldRate)}%，期限 ${p.termDays} 天，起投 ${formatCNY(p.minAmount)}）`,
      )
      .join('；');
    return {
      ok: true,
      data: products,
      summary: `共 ${products.length} 只理财产品：${detail}。`,
    };
  } catch (e) {
    return toolFailure(e);
  }
}

/* -------------------------------------------------------- compare_investments */

/** `compare_investments` params — product ids to compare. */
export const CompareInvestmentsParams = Type.Object({
  productIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: 'Product IDs to compare.' }),
});
export type CompareInvestmentsArgs = Static<typeof CompareInvestmentsParams>;

/** Registered AgentTool for `compare_investments` (🟢 GREEN). */
export function createCompareInvestmentsTool(
  userId: string,
): AgentTool<typeof CompareInvestmentsParams> {
  return {
    name: 'compare_investments',
    label: '对比理财',
    description: '对比多个理财产品，标出最高预期收益率与最低风险的产品。',
    parameters: CompareInvestmentsParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runCompareInvestments(userId, params));
    },
  };
}

/** Model-free runner — `banking.investment.compareInvestments(productIds)`. */
export async function runCompareInvestments(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const productIds = args.productIds;
    if (!Array.isArray(productIds) || productIds.length === 0 || productIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw new AppError('VALIDATION', 'Investment comparison requires non-empty product IDs.');
    }
    const comparison: InvestmentComparison = await banking.investment.compareInvestments(
      productIds,
    );
    const byId = new Map(comparison.products.map((p) => [p.id, p]));
    const top = comparison.highestRateId ? byId.get(comparison.highestRateId) : undefined;
    const low = comparison.lowestRiskId ? byId.get(comparison.lowestRiskId) : undefined;
    const parts = [`已对比 ${comparison.products.length} 只理财产品`];
    if (top) parts.push(`最高预期年化：${top.name} ${rateRatioToPercent(top.annualYieldRate)}%`);
    if (low) parts.push(`最低风险：${low.name}（${low.riskLevel}）`);
    return { ok: true, data: comparison, summary: `${parts.join('；')}。` };
  } catch (e) {
    return toolFailure(e);
  }
}

/* --------------------------------------------------- get_investment_holdings */

/** `get_investment_holdings` params — none. */
export const GetInvestmentHoldingsParams = Type.Object({});
export type GetInvestmentHoldingsArgs = Static<typeof GetInvestmentHoldingsParams>;

/** Registered AgentTool for `get_investment_holdings` (🟢 GREEN). */
export function createGetInvestmentHoldingsTool(
  userId: string,
): AgentTool<typeof GetInvestmentHoldingsParams> {
  return {
    name: 'get_investment_holdings',
    label: '我的持仓',
    description: '列出当前用户的理财持仓（产品、本金、市值、收益、状态）。',
    parameters: GetInvestmentHoldingsParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runGetInvestmentHoldings(userId, params as Record<string, unknown>));
    },
  };
}

/** Model-free runner — `banking.investment.listHoldings(userId)`. */
export async function runGetInvestmentHoldings(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const holdings: HoldingView[] = await banking.investment.listHoldings(userId);
    if (holdings.length === 0) {
      return { ok: true, data: holdings, summary: '当前没有理财持仓。' };
    }
    const principal = holdings.reduce((sum, holding) => addMoney(sum, holding.amount), '0.00');
    const profit = holdings.reduce((sum, holding) => addDecimal(sum, holding.profit ?? '0'), '0');
    return {
      ok: true,
      data: holdings,
      summary: `Holdings: ${holdings.length}; total principal: ${formatCNY(principal)}; total estimated return: ${formatDecimalCNY(profit)}.`,
    };
  } catch (e) {
    return toolFailure(e);
  }
}

/* ------------------------------------------------------ subscribe_investment */

/** `subscribe_investment` params (SDK `SubscribeInvestmentInput`; `userId` server-injected). */
export const SubscribeInvestmentParams = Type.Object({
  productId: Type.String({ minLength: 1, description: 'Investment product ID.' }),
  amount: MoneyParameter,
});
export type SubscribeInvestmentArgs = Static<typeof SubscribeInvestmentParams>;

/** Registered AgentTool for `subscribe_investment` (🔴 RED). */
export function createSubscribeInvestmentTool(
  userId: string,
): AgentTool<typeof SubscribeInvestmentParams> {
  return {
    name: 'subscribe_investment',
    label: '申购理财',
    description: '申购指定理财产品（高风险，需要短信验证码验证）。',
    parameters: SubscribeInvestmentParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runSubscribeInvestment(userId, params));
    },
  };
}

/** Model-free runner — `banking.investment.subscribeInvestment({ userId, productId, amount, idempotencyKey })`. */
export async function runSubscribeInvestment(
  userId: string,
  args: Record<string, unknown>,
  opts?: ToolRunOptions,
): Promise<ToolExecutionResult> {
  try {
    const productId = args.productId;
    const amount = centsToMoney(moneyToCents(args.amount));
    if (typeof productId !== 'string' || productId === '') {
      throw new AppError('VALIDATION', 'subscribe_investment 需要 productId');
    }
    const result: InvestResult = await banking.investment.subscribeInvestment({
      userId,
      productId,
      amount,
      // Replay uses the server-owned action or plan-node identity.
      idempotencyKey: opts?.idempotencyKey,
    });
    const balance =
      result.newBalance != null ? `，账户余额 ${formatCNY(result.newBalance)}` : '';
    return {
      ok: true,
      data: result,
      summary: `已认购 ${formatCNY(result.amount)}，持仓号 ${result.holdingId}（产品 ${result.productId}）${balance}。`,
    };
  } catch (e) {
    return toolFailure(e);
  }
}

/* --------------------------------------------------------- redeem_investment */

/** `redeem_investment` params (SDK `RedeemInvestmentInput`; `userId` server-injected). */
export const RedeemInvestmentParams = Type.Object({
  holdingId: Type.String({ minLength: 1, description: 'Owned holding ID for redemption.' }),
  redeemAmount: Type.Optional(MoneyParameter),
});
export type RedeemInvestmentArgs = Static<typeof RedeemInvestmentParams>;

/** Registered AgentTool for `redeem_investment` (🔴 RED). */
export function createRedeemInvestmentTool(
  userId: string,
): AgentTool<typeof RedeemInvestmentParams> {
  return {
    name: 'redeem_investment',
    label: '赎回理财',
    description: '赎回指定理财持仓；不填金额表示全额赎回，填写较小金额则按该本金部分赎回（部分赎回）；服务端展示到账金额，再经短信验证码验证。',
    parameters: RedeemInvestmentParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runRedeemInvestment(userId, params));
    },
  };
}

/** Model-free runner — `banking.investment.redeemInvestment({ userId, holdingId, redeemAmount, expectedRedemptionAmount, idempotencyKey })`. */
export async function runRedeemInvestment(
  userId: string,
  args: Record<string, unknown>,
  opts?: ToolRunOptions,
): Promise<ToolExecutionResult> {
  try {
    const holdingId = args.holdingId;
    if (typeof holdingId !== 'string' || holdingId === '') {
      throw new AppError('VALIDATION', 'redeem_investment 需要 holdingId');
    }
    const result: InvestResult = await banking.investment.redeemInvestment({
      userId,
      holdingId,
      // Absent ⇒ FULL redemption of the whole holding; a smaller positive principal portion ⇒ PARTIAL.
      redeemAmount: args.redeemAmount as MoneyInput | undefined,
      expectedRedemptionAmount: args.expectedRedemptionAmount as MoneyInput | undefined,
      // At-most-once: forwarded verbatim to the SDK's `idempotencyKey` (absent ⇒ unchanged behavior).
      idempotencyKey: opts?.idempotencyKey,
    });
    const balance =
      result.newBalance != null ? `，账户余额 ${formatCNY(result.newBalance)}` : '';
    return {
      ok: true,
      data: result,
      summary: result.partial
        ? `已部分赎回持仓 ${result.holdingId}，赎回本金 ${formatCNY(result.redeemedPrincipal ?? result.amount)}，到账 ${formatCNY(result.amount)}${result.remainingPrincipal != null ? `，剩余本金 ${formatCNY(result.remainingPrincipal)}` : ''}${balance}。`
        : `已赎回持仓 ${result.holdingId}，到账 ${formatCNY(result.amount)}${balance}。`,
    };
  } catch (e) {
    return toolFailure(e);
  }
}

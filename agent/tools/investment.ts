/**
 * investment — `list_investments`, `compare_investments`, `get_investment_holdings`,
 * `subscribe_investment`, `redeem_investment`
 *
 * Investment product/holding reads and subscribe/redeem mutations. TypeBox param schemas;
 * `execute` calls the Banking SDK and THROWS `AppError` on failure. The `run<X>(userId, args)`
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
  SubscribeInvestmentInput,
  ProductView,
} from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { addMoney, centsToMoney, formatCNY, moneyToCents, type MoneyInput } from '@/lib/money';
import { addDecimal, formatDecimalCNY, rateRatioToPercent } from '@/lib/decimal';
import type { ToolExecutionResult, ToolRunOptions } from './index';
import { MoneyParameter } from './money-schema';

/* ----------------------------------------------------------- list_investments */

/** `list_investments` params (SDK `ProductQuery`). */
export const ListInvestmentsParams = Type.Object({
  riskLevel: Type.Optional(Type.String({ description: '风险等级过滤：R1 | R2 | R3 | R4 | R5' })),
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
      const result = await runListInvestments(userId, params);
      if (!result.ok) throw new AppError('TOOL_FAILED', result.error ?? 'list_investments failed');
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.investment.listProducts({ riskLevel })`. */
export async function runListInvestments(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const riskLevel =
      typeof args.riskLevel === 'string' ? (args.riskLevel as InvestmentRiskLevel) : undefined;
    const products: ProductView[] = await banking.investment.listProducts(
      riskLevel ? { riskLevel } : {},
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
    return { ok: false, error: AppError.from(e).message };
  }
}

/* -------------------------------------------------------- compare_investments */

/** `compare_investments` params — product ids to compare. */
export const CompareInvestmentsParams = Type.Object({
  productIds: Type.Array(Type.String(), { minItems: 1, description: '要比较的产品 id 列表' }),
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
      const result = await runCompareInvestments(userId, params);
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'compare_investments failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
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
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new AppError('VALIDATION', 'compare_investments 需要至少一个产品 id');
    }
    const comparison: InvestmentComparison = await banking.investment.compareInvestments(
      productIds.map((id) => String(id)),
    );
    const byId = new Map(comparison.products.map((p) => [p.id, p]));
    const top = comparison.highestRateId ? byId.get(comparison.highestRateId) : undefined;
    const low = comparison.lowestRiskId ? byId.get(comparison.lowestRiskId) : undefined;
    const parts = [`已对比 ${comparison.products.length} 只理财产品`];
    if (top) parts.push(`最高预期年化：${top.name} ${rateRatioToPercent(top.annualYieldRate)}%`);
    if (low) parts.push(`最低风险：${low.name}（${low.riskLevel}）`);
    return { ok: true, data: comparison, summary: `${parts.join('；')}。` };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
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
    execute: async () => {
      const result = await runGetInvestmentHoldings(userId, {});
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'get_investment_holdings failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
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
    return { ok: false, error: AppError.from(e).message };
  }
}

/* ------------------------------------------------------ subscribe_investment */

/** `subscribe_investment` params (SDK `SubscribeInvestmentInput`; `userId` server-injected). */
export const SubscribeInvestmentParams = Type.Object({
  productId: Type.String({ description: '产品 id' }),
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
      const result = await runSubscribeInvestment(userId, params);
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'subscribe_investment failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
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
      // At-most-once: the SERVER-INJECTED `opts.idempotencyKey` (the gated-`PendingAction` /
      // plan-node path) is forwarded verbatim to the SDK's `idempotencyKey`, so a replay of the SAME
      // action/node reuses its ledger effect instead of debiting twice. Absent ⇒ unchanged behavior.
      // The SDK input type does not (yet) declare the field, so the object is cast minimally — this
      // compiles whether or not the SDK adds `idempotencyKey` to `SubscribeInvestmentInput`.
      idempotencyKey: opts?.idempotencyKey,
    } as SubscribeInvestmentInput);
    const balance =
      result.newBalance != null ? `，账户余额 ${formatCNY(result.newBalance)}` : '';
    return {
      ok: true,
      data: result,
      summary: `已认购 ${formatCNY(result.amount)}，持仓号 ${result.holdingId}（产品 ${result.productId}）${balance}。`,
    };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

/* --------------------------------------------------------- redeem_investment */

/** `redeem_investment` params (SDK `RedeemInvestmentInput`; `userId` server-injected). */
export const RedeemInvestmentParams = Type.Object({
  holdingId: Type.String({ description: '持仓 id' }),
});
export type RedeemInvestmentArgs = Static<typeof RedeemInvestmentParams>;

/** Registered AgentTool for `redeem_investment` (🔴 RED). */
export function createRedeemInvestmentTool(
  userId: string,
): AgentTool<typeof RedeemInvestmentParams> {
  return {
    name: 'redeem_investment',
    label: '赎回理财',
    description: '全额赎回指定理财持仓（不支持部分赎回）；服务端展示到账金额，再经短信验证码验证。',
    parameters: RedeemInvestmentParams,
    execute: async (_toolCallId, params) => {
      const result = await runRedeemInvestment(userId, params);
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'redeem_investment failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.investment.redeemInvestment({ userId, holdingId, idempotencyKey })`. */
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
      expectedRedemptionAmount: args.expectedRedemptionAmount as MoneyInput | undefined,
      // At-most-once: forwarded verbatim to the SDK's `idempotencyKey` (absent ⇒ unchanged behavior).
      idempotencyKey: opts?.idempotencyKey,
    });
    const balance =
      result.newBalance != null ? `，账户余额 ${formatCNY(result.newBalance)}` : '';
    return {
      ok: true,
      data: result,
      summary: `已赎回持仓 ${result.holdingId}，到账 ${formatCNY(result.amount)}${balance}。`,
    };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}

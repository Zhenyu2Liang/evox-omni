/**
 * investment — `list_investments`, `compare_investments`, `get_investment_holdings`,
 * `subscribe_investment`, `redeem_investment`
 *
 * Investment product/holding reads and subscribe/redeem mutations. TypeBox param schemas;
 * `execute` returns native Pi success or failure content. The `run<X>(userId, args)` runners are
 * the model-free path used by `executeDirect`; they CATCH and return
 * `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `list_investments` / `compare_investments` / `get_investment_holdings` 🟢 GREEN;
 * `subscribe_investment` / `redeem_investment` 🔴 RED (require MFA). Tier is decided by
 * `security/`, NOT here. `userId` is SERVER-INJECTED; the model never supplies it.
 *
 * Positions are 「净值 + 份额」 (`docs/cn/investments.md`): a subscription converts the paid amount
 * into shares at the product's published net value, and a redemption states an explicit server
 * 口径 (`mode` = `SHARES` / `AMOUNT` / `ALL`). There is no default口径 and no 「赎回本金 + 额外收益」
 * interpretation: `redemptionRequest` enforces the parameter form HERE, before any SDK call. Share
 * conversion, settlement rounding, cost consumption and profit are computed ONLY by the SDK's
 * fixed-point helpers (`banking-sdk/net-value.ts`); this module renders those numbers and never
 * recomputes them with floating-point arithmetic.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import { NET_VALUE_DECIMALS, REDEMPTION_FEE_RULE } from '@/banking-sdk';
import type {
  HoldingView,
  InvestResult,
  InvestmentComparison,
  InvestmentRiskLevel,
  ProductView,
  RedeemMode,
} from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { CNY, addMoney, centsToMoney, formatCNY, moneyToCents } from '@/lib/money';
import { addDecimal, compareDecimal, formatDecimalCNY, multiplyDecimal, rateRatioToPercent } from '@/lib/decimal';
import { businessCalendarParts } from '@/lib/date';
import type { ToolExecutionResult, ToolRunOptions } from './index';
import { MoneyParameter } from './money-schema';
import { NetValueParameter, SharesParameter, canonicalNetValue, canonicalShareCount } from './decimal-schema';
import { toModelToolResult, toolFailure } from './result';

/* -------------------------------------------------------------------- shared */

/** Redemption口径 labels — the model- and user-facing wording of `RedeemMode`. */
const REDEMPTION_MODE_LABEL: Record<RedeemMode, string> = {
  SHARES: '按份额赎回',
  AMOUNT: '按金额赎回',
  ALL: '全部赎回',
};

/** Every profit figure rendered here is a simulated estimate and must say so. */
const SIMULATED_PROFIT_NOTICE = '收益为模拟估算，不承诺保本。';

/** A fact a legacy record does not carry: stated explicitly, never invented. */
const HISTORY_INSUFFICIENT = '历史数据不足';

/** Net values display at the SDK's 4-decimal scale; canonical text drops the trailing zeros. */
function netValueText(netValue: string): string {
  const [integer, fraction = ''] = netValue.split('.');
  return `${integer}.${fraction.padEnd(NET_VALUE_DECIMALS, '0')}`;
}

/** Business (UTC+08:00) date of a net value date — a date, not an instant. */
function netValueDateText(ts: number): string {
  const { year, month, day } = businessCalendarParts(ts);
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `净值 + 净值日期` (or the explicit 「历史数据不足」 marker) for one valuation. */
function netValueLine(netValue: string | undefined, netValueDate: number | undefined, label: string): string {
  if (netValue === undefined) return `${label} ${HISTORY_INSUFFICIENT}`;
  const date = netValueDate === undefined ? '' : `（净值日期 ${netValueDateText(netValueDate)}）`;
  return `${label} ${netValueText(netValue)} 元/份${date}`;
}

/** Display-only percentage of the SDK's dimensionless ratio, HALF_UP to two fractional digits. */
function percentText(ratio: string): string {
  return `${formatDecimalCNY(multiplyDecimal(ratio, '100')).replace(CNY, '')}%`;
}

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
          `${p.code} ${p.name}（${p.riskLevel}，预期年化 ${rateRatioToPercent(p.annualYieldRate)}%，期限 ${p.termDays} 天，起投 ${formatCNY(p.minAmount)}${p.latestNetValuePerUnit === undefined ? '' : `，最新净值 ${netValueText(p.latestNetValuePerUnit)} 元/份`}）`,
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
    description: '列出当前用户的理财持仓（份额、最新净值与净值日期、持仓市值、剩余持仓成本、持仓收益、持仓收益率、累计收益、状态）。',
    parameters: GetInvestmentHoldingsParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runGetInvestmentHoldings(userId, params as Record<string, unknown>));
    },
  };
}

/**
 * One holding rendered with the seven 「净值 + 份额」 facts. Every fact the recorded data cannot
 * support is marked 「历史数据不足」 — a missing share count or net value is never filled with an
 * invented number, and market value / profit / profit rate are the SDK's own figures, not
 * recomputed here.
 */
function holdingLine(holding: HoldingView): string {
  const estimate = holding.valueBasis === 'MIGRATED_ESTIMATE' ? '（估算）' : '';
  const marketValue = holding.marketValue !== undefined && holding.latestNetValue !== undefined
    ? `${formatDecimalCNY(holding.marketValue)}${estimate}`
    : HISTORY_INSUFFICIENT;
  return [
    `持仓 ${holding.productName}（${holding.riskLevel}）`,
    `持仓份额 ${holding.shares === undefined ? HISTORY_INSUFFICIENT : `${holding.shares} 份`}`,
    netValueLine(holding.latestNetValue, holding.latestNetValueDate, '最新净值'),
    `持仓市值 ${marketValue}`,
    `剩余持仓成本 ${formatCNY(holding.amount)}`,
    `持仓收益 ${holding.profit === undefined ? HISTORY_INSUFFICIENT : formatDecimalCNY(holding.profit)}`,
    `持仓收益率 ${holding.profitRate === undefined ? HISTORY_INSUFFICIENT : percentText(holding.profitRate)}`,
    `累计收益 ${holding.cumulativeProfit === undefined ? HISTORY_INSUFFICIENT : formatDecimalCNY(holding.cumulativeProfit)}`,
  ].join('；');
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
      summary: `共有 ${holdings.length} 笔理财持仓，合计剩余成本 ${formatCNY(principal)}，合计持仓收益 ${formatDecimalCNY(profit)}。${holdings.map(holdingLine).join('。')}。${SIMULATED_PROFIT_NOTICE}`,
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
    description: '申购指定理财产品：服务端按产品最新净值把申购金额折算为份额（高风险，需要短信验证码验证）。',
    parameters: SubscribeInvestmentParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runSubscribeInvestment(userId, params));
    },
  };
}

/**
 * Read the CURRENT holdings right after a committed write — the very read `get_investment_holdings`
 * publishes (`banking.investment.listHoldings`), taken AFTER the mutation committed, so the chat can
 * show the position the user actually holds now (`agent/card-emitter.ts`).
 *
 * `undefined` means "no usable re-read". The write already happened, so an unavailable read degrades
 * to projecting only the receipt card: it never turns a successful mutation into a failed tool call
 * and never invents an empty holding list.
 */
async function currentHoldings(userId: string): Promise<HoldingView[] | undefined> {
  try {
    const holdings = await banking.investment.listHoldings(userId);
    return Array.isArray(holdings) ? holdings : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach the post-write holdings snapshot to a committed write's result. ADDITIVE presentation
 * evidence only: every authoritative `InvestResult` field (amount, shares, realized profit, …) keeps
 * its meaning, and the field is omitted entirely when the re-read was unavailable.
 */
function withHoldings(
  result: InvestResult,
  holdings: HoldingView[] | undefined,
): InvestResult | (InvestResult & { holdings: HoldingView[] }) {
  return holdings === undefined ? result : { ...result, holdings };
}

/**
 * The net value a just-committed subscription executed at, read back from the holding's own purchase
 * record (`HoldingPurchase.netValuePerUnit`) in the post-write holdings snapshot.
 *
 * PRESENTATION ONLY: `InvestResult` is the authoritative outcome of the purchase, so a snapshot that
 * does not carry the record (an unavailable re-read, a legacy holding) reports 「历史数据不足」 instead
 * of re-pricing anything or turning an already-committed write into a failed tool call.
 */
function executedNetValue(
  holdings: readonly HoldingView[] | undefined,
  holdingId: string,
): { netValue?: string; netValueDate?: number } {
  const holding = holdings?.find((entry) => entry.id === holdingId);
  if (holding === undefined) return {};
  const purchase = holding.purchases?.[holding.purchases.length - 1];
  const fromPurchase = purchase?.netValuePerUnit !== undefined;
  const netValue = fromPurchase ? purchase?.netValuePerUnit : holding.latestNetValue;
  const netValueDate = fromPurchase ? purchase?.netValueDate : holding.latestNetValueDate;
  return {
    ...(netValue !== undefined ? { netValue } : {}),
    ...(netValueDate !== undefined ? { netValueDate } : {}),
  };
}

/** Display lookup cannot turn an already committed write into a failure or expose internal IDs. */
async function writtenProductName(result: InvestResult, holdings: readonly HoldingView[] | undefined): Promise<string> {
  const ownedName = holdings?.find(holding => holding.id === result.holdingId)?.product?.name;
  if (ownedName) return ownedName;
  try { return (await banking.investment.listProducts({})).find(product => product.id === result.productId)?.name || '该理财产品'; }
  catch { return '该理财产品'; }
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
    const holdings = await currentHoldings(userId);
    const executed = executedNetValue(holdings, result.holdingId);
    const productName = await writtenProductName(result, holdings);
    const parts = [
      `已认购「${productName}」${formatCNY(result.amount)}${result.addedToExisting ? '（合并至原持仓）' : ''}`,
      `申购份额 ${result.subscribedShares === undefined ? HISTORY_INSUFFICIENT : `${result.subscribedShares} 份`}`,
      netValueLine(executed.netValue, executed.netValueDate, '成交净值'),
      `持仓总份额 ${result.totalShares === undefined ? HISTORY_INSUFFICIENT : `${result.totalShares} 份`}`,
    ];
    if (result.newBalance != null) parts.push(`账户余额 ${formatCNY(result.newBalance)}`);
    return {
      ok: true,
      data: { ...withHoldings(result, holdings), productName },
      summary: `${parts.join('；')}。${SIMULATED_PROFIT_NOTICE}`,
    };
  } catch (e) {
    return toolFailure(e);
  }
}

/* --------------------------------------------------------- redeem_investment */

/**
 * `redeem_investment` params (SDK `RedeemInvestmentInput`; `userId` and the execution identity are
 * server-owned). `mode` is REQUIRED: a redemption states its口径, there is no default.
 */
export const RedeemInvestmentParams = Type.Object({
  holdingId: Type.String({ minLength: 1, description: 'Owned holding ID for redemption.' }),
  mode: Type.Union([Type.Literal('SHARES'), Type.Literal('AMOUNT'), Type.Literal('ALL')], {
    description: '赎回口径，必须显式给出：SHARES 按份额、AMOUNT 按金额、ALL 全部赎回。没有默认口径，混用口径会被拒绝。',
  }),
  shares: Type.Optional(SharesParameter),
  amount: Type.Optional(MoneyParameter),
  expectedShares: Type.Optional(SharesParameter),
  expectedPositionVersion: Type.Optional(Type.Integer({ minimum: 0, description: 'Server-owned position version at approval.' })),
  expectedNetValue: Type.Optional(NetValueParameter),
  expectedNetValueDate: Type.Optional(Type.Integer({
    description: 'Server-snapshotted net value business date (epoch ms) of the approved quote.',
  })),
  expectedSettlementAmount: Type.Optional(MoneyParameter),
});
export type RedeemInvestmentArgs = Static<typeof RedeemInvestmentParams>;

/** Registered AgentTool for `redeem_investment` (🔴 RED). */
export function createRedeemInvestmentTool(
  userId: string,
): AgentTool<typeof RedeemInvestmentParams> {
  return {
    name: 'redeem_investment',
    label: '赎回理财',
    description: '按明确口径赎回理财持仓：mode=SHARES 需给 shares，mode=AMOUNT 需给 amount（按最新净值折算份额），mode=ALL 全部赎回且不接受份额或金额。口径必须显式：用户只给了金额而没说明口径时，先确认是「按份额」还是「按金额」，不存在「赎回本金后再额外支付收益」。服务端展示赎回份额、成交净值、到账金额与费用口径后，再经短信验证码验证。',
    parameters: RedeemInvestmentParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runRedeemInvestment(userId, params));
    },
  };
}

/** The clarification the server contract demands when no口径 is stated — there is no default口径. */
const REDEEM_MODE_REQUIRED = '赎回需要明确口径：请确认按「份额」还是按「金额」赎回';

/** A resolved口径 plus exactly the one input field that口径 owns. */
interface RedemptionRequest {
  mode: RedeemMode;
  shares?: string;
  amount?: string;
}

/**
 * Resolve and validate the redemption口径 at the TOOL boundary — not in a prompt: `SHARES` requires
 * `shares`, `AMOUNT` requires `amount`, `ALL` accepts neither, and a mixed口径 or the retired
 * principal field `redeemAmount` is refused before the SDK is reached.
 *
 * A user-supplied amount is never read as a principal to be repaid "plus profit": without a口径 the
 * caller is asked to clarify, so no settlement can be minted from a guess.
 */
function redemptionRequest(args: Record<string, unknown>): RedemptionRequest {
  if (args.redeemAmount !== undefined) {
    throw new AppError('VALIDATION', REDEEM_MODE_REQUIRED, {
      redeemAmount: args.redeemAmount,
      reason: 'PRINCIPAL_MODE_RETIRED',
    });
  }
  const mode = args.mode;
  if (mode !== 'SHARES' && mode !== 'AMOUNT' && mode !== 'ALL') {
    throw new AppError('VALIDATION', REDEEM_MODE_REQUIRED, {
      mode: typeof mode === 'string' ? mode : null,
    });
  }
  if (mode === 'ALL') {
    if (args.shares !== undefined || args.amount !== undefined) {
      throw new AppError('VALIDATION', '赎回口径不可混用：全额赎回不接受份额或金额', {
        mode,
        shares: args.shares ?? null,
        amount: args.amount ?? null,
      });
    }
    return { mode };
  }
  if (mode === 'SHARES') {
    if (args.amount !== undefined) {
      throw new AppError('VALIDATION', '赎回口径不可混用：按份额赎回不能同时给出赎回金额', { mode });
    }
    if (args.shares === undefined) {
      throw new AppError('VALIDATION', '按份额赎回需要给出赎回份额（最多 6 位小数）', { mode });
    }
    const shares = canonicalShareCount(args.shares);
    if (compareDecimal(shares, '0') <= 0) throw new AppError('VALIDATION', '赎回份额必须大于零', { shares });
    return { mode, shares };
  }
  if (args.shares !== undefined) {
    throw new AppError('VALIDATION', '赎回口径不可混用：按金额赎回不能同时给出赎回份额', { mode });
  }
  if (args.amount === undefined) {
    throw new AppError('VALIDATION', '按金额赎回需要给出赎回金额', { mode });
  }
  const amount = centsToMoney(moneyToCents(args.amount));
  if (moneyToCents(amount) <= 0n) throw new AppError('VALIDATION', '赎回金额必须大于零', { amount });
  return { mode, amount };
}

/**
 * The server-minted confirmation snapshot (`security/security-gateway.ts` `redemptionSnapshot`),
 * forwarded so the SDK can reject a stale authorization inside the write transaction. It is
 * canonicalized here because the SDK compares it against freshly read values.
 */
function approvedSnapshot(args: Record<string, unknown>): {
  expectedPositionVersion?: number;
  expectedShares?: string;
  expectedNetValue?: string;
  expectedNetValueDate?: number;
  expectedSettlementAmount?: string;
} {
  const snapshot: {
    expectedPositionVersion?: number;
    expectedShares?: string;
    expectedNetValue?: string;
    expectedNetValueDate?: number;
    expectedSettlementAmount?: string;
  } = {};
  if (args.expectedPositionVersion !== undefined) {
    if (typeof args.expectedPositionVersion !== 'number' || !Number.isSafeInteger(args.expectedPositionVersion) || args.expectedPositionVersion < 0) {
      throw new AppError('VALIDATION', '持仓版本必须是非负整数');
    }
    snapshot.expectedPositionVersion = args.expectedPositionVersion;
  }
  if (args.expectedShares !== undefined) snapshot.expectedShares = canonicalShareCount(args.expectedShares);
  if (args.expectedNetValue !== undefined) snapshot.expectedNetValue = canonicalNetValue(args.expectedNetValue);
  if (args.expectedNetValueDate !== undefined) {
    if (typeof args.expectedNetValueDate !== 'number' || !Number.isSafeInteger(args.expectedNetValueDate)) {
      throw new AppError('VALIDATION', '净值日期必须是 UTC epoch 毫秒整数', { value: args.expectedNetValueDate });
    }
    snapshot.expectedNetValueDate = args.expectedNetValueDate;
  }
  if (args.expectedSettlementAmount !== undefined) {
    snapshot.expectedSettlementAmount = centsToMoney(moneyToCents(args.expectedSettlementAmount));
  }
  return snapshot;
}

/** The redemption fee口径 — the field is kept although the simulation waives the fee. */
function feeLine(feeAmount: string | undefined, feeRule: string | undefined): string {
  const amount = feeAmount === undefined ? HISTORY_INSUFFICIENT : formatCNY(feeAmount);
  if (feeRule === REDEMPTION_FEE_RULE) {
    return `费用口径 ${REDEMPTION_FEE_RULE}（模拟环境不收取赎回费，赎回费 ${amount}）`;
  }
  return `费用口径 ${feeRule ?? HISTORY_INSUFFICIENT}（赎回费 ${amount}）`;
}

/**
 * The model-facing redemption summary: the口径, redeemed shares, the net value it settled at (with
 * its business date), the credited amount, the fee口径, the remaining shares and cost, and the
 * realized profit — all of it server-returned, none of it recomputed.
 */
function redemptionSummary(result: InvestResult, productName: string): string {
  const remaining = result.remainingShares;
  const remainingCost = result.remainingCost ?? result.remainingPrincipal;
  const closed = remaining !== undefined && compareDecimal(remaining, '0') === 0;
  const parts = [
    `${result.mode === undefined ? '已赎回' : `已${REDEMPTION_MODE_LABEL[result.mode]}`}「${productName}」`,
    `赎回份额 ${result.redeemedShares === undefined ? HISTORY_INSUFFICIENT : `${result.redeemedShares} 份`}`,
    netValueLine(result.netValuePerUnit, result.netValueDate, '成交净值'),
    `预计到账 ${formatCNY(result.amount)}`,
    feeLine(result.feeAmount, result.feeRule),
    `剩余份额 ${remaining === undefined ? HISTORY_INSUFFICIENT : `${remaining} 份${closed ? '（持仓已结清）' : ''}`}`,
    `剩余成本 ${remainingCost === undefined ? HISTORY_INSUFFICIENT : formatCNY(remainingCost)}`,
    `已实现收益 ${result.realizedProfit === undefined ? HISTORY_INSUFFICIENT : formatCNY(result.realizedProfit)}`,
  ];
  if (result.newBalance != null) parts.push(`账户余额 ${formatCNY(result.newBalance)}`);
  return `${parts.join('；')}。${SIMULATED_PROFIT_NOTICE}`;
}

/**
 * Model-free runner — `banking.investment.redeemInvestment({ userId, holdingId, mode, shares, amount,
 * expectedShares, expectedNetValue, expectedNetValueDate, expectedSettlementAmount, idempotencyKey })`.
 * The口径 is validated before the SDK is called; the execution identity stays server-owned
 * (`opts.idempotencyKey`), so a repeat replays the persisted redemption instead of settling twice.
 */
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
    const request = redemptionRequest(args);
    // Old parked decisions have no position version and cannot authorize a new execution.
    if (opts?.fence && args.expectedPositionVersion === undefined) {
      throw new AppError('CONFLICT', '持仓授权缺少版本，请重新发起并确认赎回');
    }
    const result: InvestResult = await banking.investment.redeemInvestment({
      userId,
      holdingId,
      mode: request.mode,
      ...(request.shares !== undefined ? { shares: request.shares } : {}),
      ...(request.amount !== undefined ? { amount: request.amount } : {}),
      ...approvedSnapshot(args),
      // At-most-once: the server-owned execution identity, forwarded verbatim to `idempotencyKey`.
      idempotencyKey: opts?.idempotencyKey,
    });
    // The redemption is committed: re-read the position (a replay reports TODAY's position) and
    // project it as the post-write holdings card. An unavailable re-read leaves the receipt alone.
    const holdings = await currentHoldings(userId);
    // Closing redemptions disappear from current holdings; the catalog still names the original product.
    const displayName = await writtenProductName(result, holdings);
    return {
      ok: true,
      data: { ...withHoldings(result, holdings), productName: displayName },
      summary: redemptionSummary(result, displayName),
    };
  } catch (e) {
    return toolFailure(e);
  }
}

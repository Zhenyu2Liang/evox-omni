/**
 * Banking SDK — public DTOs (the SDK's frozen public API surface).
 *
 * Rules:
 *  - These types cross the SDK boundary; downstream layers (`agent`, `planner`, `app`,
 *    `components`) import them from the SDK barrel (`banking-sdk/index.ts`).
 *  - They are VIEW MODELS: the SDK implementation maps Prisma rows onto these. Prisma model
 *    types MUST NOT leak out of the SDK.
 *  - Money is canonical CNY decimal text; rates and percentages are decimal text. Timestamps are epoch
 *    milliseconds (`number`), matching `lib/contracts`.
 */

import type { MoneyAmount, MoneyInput } from '../lib/money';
import type { DecimalAmount } from '../lib/decimal';

/**
 * Financial decimal INPUT (canonical decimal text) — the decimal counterpart of `MoneyInput`:
 * net values, share counts and rates never arrive as JavaScript numbers.
 */
export type DecimalInput = DecimalAmount;
/* ------------------------------------------------------------------ account */

export type AccountType = 'CHECKING' | 'SAVINGS';

export interface AccountView {
  id: string;
  type: AccountType;
  name: string;
  /** Masked account number, e.g. `****8821`. */
  numberMasked: string;
  /** Current balance in CNY. */
  balance: MoneyAmount;
  currency: string;
}

export interface BalanceView {
  /** Sum of all account balances (CNY). */
  totalAvailable: MoneyAmount;
  currency: string;
  accounts: AccountView[];
  /** Epoch ms. */
  asOf: number;
}

/* -------------------------------------------------------------- transaction */

export type TransactionDirection = 'DEBIT' | 'CREDIT';
export type TransactionChannel = 'APP' | 'CARD' | 'TRANSFER' | 'SUBSCRIPTION';

export interface TransactionView {
  id: string;
  accountId: string;
  /** Signed amount (CNY): negative = expense, positive = income. */
  amount: MoneyAmount;
  currency: string;
  direction: TransactionDirection;
  category: string;
  merchant: string;
  channel?: TransactionChannel;
  remark?: string;
  counterpartyId?: string;
  /** Epoch ms. */
  occurredAt: number;
  isAnomaly: boolean;
  anomalyReason?: string;
}

export interface TransactionQuery {
  /** Inclusive lower bound (epoch ms). */
  from?: number;
  /** Exclusive upper bound (epoch ms); the range is [from, to). */
  to?: number;
  category?: string;
  /** Max rows returned, most recent first; when provided, must be 1–200. */
  limit?: number;
}

export interface SpendingQuery {
  /** `YYYY-MM` window; defaults to the current month. */
  month?: string;
}

export interface CategorySpend {
  category: string;
  amount: MoneyAmount;
  /** Share of total spend, percent 0–100. */
  share: string;
}

export interface MerchantSpend {
  merchant: string;
  amount: MoneyAmount;
  count: number;
}

export interface MonthlyTrendPoint {
  /** `YYYY-MM`. */
  month: string;
  amount: MoneyAmount;
}

export interface SpendingAnalysis {
  /** `YYYY-MM` window analysed. */
  month: string;
  /** Total spend in the window (positive CNY). */
  total: MoneyAmount;
  /** Total spend in the previous month (positive CNY). */
  prevTotal: MoneyAmount;
  /** Month-over-month change, percent (0 when `prevTotal` is 0). */
  momChangePct: string;
  /** All booked consumption, including flagged rows. */
  bookedTotal: MoneyAmount;
  /** Flagged consumption is reported separately, never silently omitted. */
  flaggedTotal: MoneyAmount;
  /** Stable category keys for compiled workflow conditions. */
  categoryTotals: Record<string, MoneyAmount>;
  byCategory: CategorySpend[];
  topMerchant: MerchantSpend | null;
  /** Rolling window of the most recent months, oldest → newest. */
  monthlyTrend: MonthlyTrendPoint[];
  /** Largest single spend in the window, or null. */
  largest: TransactionView | null;
}

export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface AnomalyItem {
  acknowledged?: boolean;
  transaction: TransactionView;
  reason: string;
  severity: AnomalySeverity;
}

export interface AnomalyReport {
  cards?: CardView[];
  anomalies: AnomalyItem[];
  /** Number of transactions scanned. */
  scanned: number;
  /** Epoch ms. */
  generatedAt: number;
}

/* ------------------------------------------------------------------ contact */

export interface ContactView {
  id: string;
  name: string;
  phone: string;
  bank?: string;
  remark?: string;
}

/* ----------------------------------------------------------------- transfer */

export interface TransferInput {
  userId: string;
  /** Resolve recipient by explicit contact id… */
  contactId?: string;
  /** …or by phone… */
  phone?: string;
  /** …or by name (ambiguous name → `CONFLICT`). */
  name?: string;
  /** Positive CNY amount. */
  amount: MoneyInput;
  remark?: string;
  /** Funding account; defaults to the user's primary CHECKING account. */
  sourceAccountId?: string;
  /**
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT
   * double-debit: the ledger row id is derived deterministically from (userId, key), and the
   * existing row is returned instead of writing a second one. Absent → unchanged behavior.
   */
  idempotencyKey?: string;
}

export interface TransferRecipient {
  contactId?: string;
  name: string;
  phone: string;
  bank?: string;
}

export interface TransferResult {
  success: true;
  transactionId: string;
  /** Server-resolved funding account; also persisted in the original execution receipt. */
  sourceAccountId: string;
  /** Funding-account balance after the debit (CNY). */
  newBalance: MoneyAmount;
  recipient: TransferRecipient;
  amount: MoneyAmount;
  remark?: string;
  /** Epoch ms. */
  occurredAt: number;
}

/* ---------------------------------------------------------------------- card */

export type CardType = 'DEBIT' | 'CREDIT' | 'VIRTUAL';
export type CardStatus = 'ACTIVE' | 'FROZEN' | 'LOST' | 'PENDING';

export interface CardLimitView {
  category: string;
  amount: MoneyAmount;
}

export interface CardView {
  id: string;
  type: CardType;
  network: string;
  numberMasked: string;
  status: CardStatus;
  creditLimit?: MoneyAmount;
  availableLimit?: MoneyAmount;
  monthlyLimit?: MoneyAmount;
  /** Id of the replacement card issued for this (lost) card; historical reference only. */
  replacedByCardId?: string;
  /** Settlement CHECKING account id bound to this card (virtual cards); absent when unbound. */
  linkedAccountId?: string;
  /** Masked settlement-account number of the bound account, e.g. `****8821`; absent when unbound. */
  linkedAccountNumber?: string;
  /** Bound account's available balance (CNY); absent when the card is unbound. */
  accountAvailableBalance?: MoneyAmount;
  /**
   * Amount currently payable by this card (CNY): the bound account balance, capped by the remaining
   * monthly limit of the card FAMILY's business month — `demoNow()` for a read, the enforced instant
   * inside `consumeCard`. A `null` monthly limit is unlimited (governed by the account balance).
   */
  payableAmount?: MoneyAmount;
  limits: CardLimitView[];
}

export interface SetCardLimitInput {
  /** Trusted caller identity, injected by the server runner. */
  userId: string;
  cardId: string;
  category: string;
  /** CNY cap for the category. */
  amount: MoneyInput;
}

export interface ReportLostCardInput {
  reason?: string;
}

export interface ApplyVirtualCardInput {
  userId: string;
  /** Optional monthly limit configuration in CNY; never inferred from a free-text label. */
  monthlyLimit?: MoneyInput;
  /**
   * Optional settlement CHECKING account id to bind. When supplied the server validates ownership
   * and account type; when omitted the user's default CHECKING account is bound.
   */
  linkedAccountId?: string;
  /**
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT issue a
   * second card: the card id is derived deterministically from (userId, key), and the existing
   * virtual card is replayed (same `id`) instead of creating another one. Absent → unchanged
   * behavior (every call issues a NEW card with a freshly generated masked number).
   */
  idempotencyKey?: string;
}

/* ------------------------------------------------------------- card spend */

/**
 * Public parameter set of `consumeCard`. It carries NO consumption instant: the booking time and the
 * UTC+08:00 billing month it is attributed to are SERVER-owned. A deterministic test seam exists
 * ONLY through the separate `ConsumeCardOptions` argument, never through this object.
 */
export interface ConsumeCardInput {
  /** Trusted caller identity, injected by the server runner. */
  userId: string;
  cardId: string;
  /** Positive CNY amount to spend, as decimal text. */
  amount: MoneyInput;
  /** One of the supported spending categories; defaults to `其他`. */
  category?: string;
  /** Merchant label shown in the ledger; defaults to a local-simulation label. */
  merchant?: string;
  /**
   * Optional execution identity. When supplied, a repeated call with the SAME key replays the
   * persisted consumption instead of charging again (the SDK persists the original result).
   */
  executionKey?: string;
}

/**
 * INTERNAL, TEST-ONLY second argument of `consumeCard` — deliberately NOT part of
 * `ConsumeCardInput`.
 *
 * The booking instant of a card consumption decides BOTH the ledger time AND the UTC+08:00 billing
 * month the monthly limit is counted against. On the public parameter set it would let a caller
 * back-date a spend out of the current month and spend the same limit twice, so it lives in a
 * separate argument that no HTTP body, tool-argument object or model output can reach.
 */
export interface ConsumeCardOptions {
  /**
   * Test-only clock seam: the business instant (epoch ms, or a `Date`) this ONE consumption is
   * booked at, which also selects the billing month it is attributed to AND the month the returned
   * card projection reports. Omitted — the production path — means the project business clock
   * (`demoNow()`). Never persisted, never read back.
   */
  now?: number | Date;
}

/** One successful local card consumption row (see `CardConsumption`). */
export interface CardConsumptionView {
  id: string;
  cardId: string;
  accountId: string;
  /** Positive CNY magnitude of the spend. */
  amount: MoneyAmount;
  currency: string;
  category: string;
  merchant: string;
  /** Epoch ms. */
  occurredAt: number;
  /** Replay identity, when one was supplied. */
  executionKey?: string;
  /** Epoch ms. */
  createdAt: number;
}

export interface ConsumeCardResult {
  consumption: CardConsumptionView;
  /** Card view after the spend, in the same business month the limit was enforced (payable updated). */
  card: CardView;
  /** Bound account's available balance (CNY) after the debit. */
  accountAvailableBalance: MoneyAmount;
}

export interface CardConsumptionQuery {
  /** Restrict to a single card; omit for all of the user's cards. */
  cardId?: string;
  /** Max rows returned, newest first; defaults to 20 and is capped at 200. */
  limit?: number;
}

/* -------------------------------------------------------------- subscription */

export type SubscriptionCycle = 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export type SubscriptionStatus = 'ACTIVE' | 'CANCELLED';

export interface SubscriptionView {
  id: string;
  name: string;
  amount: MoneyAmount;
  cycle: SubscriptionCycle;
  /** Next charge, epoch ms. */
  nextChargeAt: number;
  status: SubscriptionStatus;
  remind: boolean;
}

/* --------------------------------------------------------------- investment */

export type InvestmentRiskLevel = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type HoldingStatus = 'HOLDING' | 'REDEEMED';
/**
 * The explicit口径 a redemption must state (see `docs/cn/investments.md`, 「赎回口径」):
 * `SHARES` — redeem a given share count; `AMOUNT` — redeem a CNY amount, converted to shares at the
 * current net value; `ALL` — redeem every held share and close the holding. Mixing口径 is rejected.
 */
export type RedeemMode = 'SHARES' | 'AMOUNT' | 'ALL';

export interface ProductView {
  id: string;
  code: string;
  name: string;
  riskLevel: InvestmentRiskLevel;
  /** Expected annual yield as a dimensionless ratio (e.g. "0.032575" means 3.2575%). */
  annualYieldRate: DecimalAmount;
  termDays: number;
  /** Minimum subscription amount (CNY). */
  minAmount: MoneyAmount;
  description?: string;
  /** Latest SIMULATED net value per unit (4 fractional digits); absent when none is published. */
  latestNetValuePerUnit?: DecimalAmount;
  /** Business date (epoch ms) the published net value applies to; absent with no net value. */
  latestNetValueDate?: number;
}

export interface ProductQuery {
  riskLevel?: InvestmentRiskLevel;
}

export interface InvestmentComparison {
  products: ProductView[];
  /** Product id with the highest `annualYieldRate`, if any. */
  highestRateId?: string;
  /** Product id with the lowest risk level, if any. */
  lowestRiskId?: string;
}

export interface HoldingView {
  product: ProductView;
  id: string;
  productId: string;
  productName: string;
  riskLevel: InvestmentRiskLevel;
  /**
   * REMAINING position cost (剩余持仓成本, CNY) — the field keeps its name and meaning: subscription
   * amounts paid minus the cost consumed by redemptions. It is NOT a market value and NOT a
   * redemption口径.
   */
  amount: MoneyAmount;
  /** Held share count (6 fractional digits); absent when the holding records no usable shares. */
  shares?: DecimalAmount;
  /** Published net value per unit this valuation used; absent when the product has no net value. */
  latestNetValue?: DecimalAmount;
  /** Business date (epoch ms) of `latestNetValue`; absent with no net value. */
  latestNetValueDate?: number;
  /** Unrounded market value (CNY) — `shares × latestNetValue`, exact, never settlement-rounded. */
  marketValue?: DecimalAmount;
  /** Unrealized profit (CNY): `marketValue − amount`, when the position can be valued. */
  profit?: DecimalAmount;
  /** `profit ÷ amount` as a dimensionless ratio (displayed as a percentage); absent at zero cost. */
  profitRate?: DecimalAmount;
  /**
   * Realized profit already booked by this holding's redemptions (CNY, may be negative). The SDK
   * always populates it; optional only so partial holding literals (the UI display tests) still
   * compile while call sites migrate.
   */
  realizedProfit?: MoneyAmount;
  /** `realizedProfit + profit` (CNY); absent when the position cannot be valued. */
  cumulativeProfit?: DecimalAmount;
  /**
   * How `marketValue` was derived. `NET_VALUE` — shares × published net value;
   * `MIGRATED_ESTIMATE` — shares derived from an old booked value (估算);
   * `HISTORICAL_DATA_INSUFFICIENT` — no usable shares or no net value, so `marketValue` falls back
   * to the remaining cost and no profit is reported (历史数据不足). The SDK always populates it;
   * optional only so partial holding literals (the UI display tests) still compile while call sites
   * migrate.
   */
  valueBasis?: 'NET_VALUE' | 'MIGRATED_ESTIMATE' | 'HISTORICAL_DATA_INSUFFICIENT';
  /** Epoch ms. */
  boughtAt: number;
  status: HoldingStatus;
  /** Epoch ms of the most recent purchase in this holding; absent when no purchase history is recorded. */
  lastPurchaseAt?: number;
  /** Purchases recorded on this holding, oldest → newest (absent when no history is recorded). */
  purchases?: HoldingPurchase[];
  /** Redemptions recorded on this holding, oldest → newest (absent when no history is recorded). */
  redemptions?: HoldingRedemption[];
}

/** One recorded subscription that added cost and shares to a holding (oldest → newest in `HoldingView.purchases`). */
export interface HoldingPurchase {
  /** CNY amount paid by this purchase. */
  amount: MoneyAmount;
  /** Epoch ms of this purchase. */
  at: number;
  /** Remaining cost of the holding after this purchase was aggregated in (CNY). */
  totalPrincipal: MoneyAmount;
  /** Unrounded market value of the holding after this purchase (CNY). */
  marketValue: DecimalAmount;
  /** Shares bought by this purchase (`FLOOR(amount ÷ net value, 6 位小数)`); absent on old records. */
  shares?: DecimalAmount;
  /** Net value per unit this purchase was priced at; absent on old records. */
  netValuePerUnit?: DecimalAmount;
  /** Business date (epoch ms) of `netValuePerUnit`; absent on old records. */
  netValueDate?: number;
  /** Held shares after this purchase; absent on old records. */
  totalShares?: DecimalAmount;
  /** Funding-account balance after this purchase (CNY). */
  newBalance: MoneyAmount;
  /** Server-resolved funding account. */
  sourceAccountId: string;
  /** Execution identity of this purchase, when the caller supplied one. */
  executionKey?: string;
}

/** One recorded partial redemption of a holding (oldest → newest in `HoldingView.redemptions`). */
export interface HoldingRedemption {
  /** Epoch ms of this redemption. */
  at: number;
  /** Which口径 this redemption stated. */
  mode: RedeemMode;
  /** Shares redeemed. */
  shares: DecimalAmount;
  /** Net value per unit this redemption settled at. */
  netValuePerUnit: DecimalAmount;
  /** Business date (epoch ms) of `netValuePerUnit`; absent when the product published none. */
  netValueDate?: number;
  /** CNY credited to the funding account (HALF_UP to cents, once). */
  settledAmount: MoneyAmount;
  /** Redemption fee charged (CNY); always `0.00` under the simulated fee rule. */
  feeAmount: MoneyAmount;
  /** The fee rule applied; always `SIMULATED_NONE`. */
  feeRule: string;
  /** Position cost consumed by this redemption (CNY) — the booked cost basis that is gone. */
  cost: MoneyAmount;
  /** `settledAmount − cost` booked as realized profit by this redemption (CNY, may be negative). */
  realizedProfit: MoneyAmount;
}

export interface SubscribeInvestmentInput {
  userId: string;
  productId: string;
  /** CNY amount; must be ≥ product `minAmount`. */
  amount: MoneyInput;
  /**
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT
   * double-debit: the full original result, including the original account balance, is replayed
   * from the transactionally persisted evidence (the holding's `subscribeResult` for the creating
   * purchase, or the matching `purchaseHistory` record for one aggregated into an existing holding).
   * The creating purchase stores the key on `InvestmentHolding.idempotencyKey`; an aggregation
   * stores it in the appended `purchaseHistory` record. The planner passes `nodeExecutionKey(taskId, nodeId)`.
   * Absent → unchanged behavior.
   */
  idempotencyKey?: string;
}

export interface RedeemInvestmentInput {
  userId: string;
  holdingId: string;
  /**
   * The redemption口径 — `SHARES` (redeem `shares`), `AMOUNT` (redeem `amount`, converted to shares at
   * the current net value) or `ALL` (redeem every held share and close the holding).
   *
   * OPTIONAL only for source compatibility: the SDK validates it at RUNTIME before reading any
   * mutable state, so a missing or unknown口径 throws `AppError('VALIDATION')` asking the user to
   * confirm「份额」or「金额」. There is no default口径 — silently guessing is exactly what
   * `docs/cn/investments.md` forbids.
   */
  mode?: RedeemMode;
  /** Shares to redeem; required for `mode: 'SHARES'`, rejected for every other口径. */
  shares?: DecimalInput;
  /** CNY amount to redeem; required for `mode: 'AMOUNT'`, rejected for every other口径. */
  amount?: MoneyInput;
  /**
   * @deprecated The old PRINCIPAL-based redemption口径, kept only so legacy callers still compile.
   * Never honoured: any supplied value is REJECTED at runtime with the same clarification error as a
   * missing `mode`, because「赎回本金」is not a redemption口径 any more.
   */
  redeemAmount?: MoneyInput;
  /** Server-snapshotted amount to be credited (CNY) shown before MFA; a change requires a new decision. */
  expectedSettlementAmount?: MoneyInput;
  /**
   * @deprecated Alias of `expectedSettlementAmount` — both always meant the amount credited. Still
   * accepted, compared exactly like `expectedSettlementAmount`.
   */
  expectedRedemptionAmount?: MoneyInput;
  /** Server-snapshotted redemption share count shown before MFA. */
  expectedShares?: DecimalInput;
  /** Server-snapshotted net value per unit shown before MFA. */
  expectedNetValue?: DecimalInput;
  /** Server-snapshotted net value business date (epoch ms) shown before MFA. */
  expectedNetValueDate?: number;
  /**
   * Optional idempotency key — the redemption's EXECUTION IDENTITY. A repeat with the SAME
   * key on an already-REDEEMED holding REPLAYS the original redemption and original balance;
   * a repeat of a PARTIAL redemption replays the stored partial outcome from `redemptionHistory`
   * without crediting again. A DISTINCT (or absent) key on an already-REDEEMED holding always
   * throws `CONFLICT` — never a false success. The identity and original result are persisted on
   * the holding (`redeemExecutionKey` / `redeemResult` / `redemptionHistory`); the planner passes
   * `nodeExecutionKey(taskId, nodeId)`.
   */
  idempotencyKey?: string;
}

export interface InvestResult {
  success: boolean;
  holdingId: string;
  productId: string;
  /** CNY amount moved by this operation: paid by a subscription, credited by a redemption. */
  amount: MoneyAmount;
  /** Funding-account balance after the operation (CNY). */
  newBalance: MoneyAmount;
  /** Server-resolved funding account. */
  sourceAccountId: string;
  /** Epoch ms. */
  occurredAt: number;
  /** Exact, unrounded CNY market value of the redeemed shares (before the single settlement rounding). */
  redemptionValuation?: DecimalAmount;
  /** Rounding rule applied once when a redemption is settled. */
  settlementRounding?: 'HALF_UP';
  /** Present on a PARTIAL redemption: the holding stays `HOLDING` with fewer shares and less cost. */
  partial?: boolean;
  /** Redemption口径 applied, when this result is a redemption. */
  mode?: RedeemMode;
  /** Shares redeemed (absent when an old-format redemption record is replayed). */
  redeemedShares?: DecimalAmount;
  /** Shares left in the holding after a redemption. */
  remainingShares?: DecimalAmount;
  /** Net value per unit a redemption settled at. */
  netValuePerUnit?: DecimalAmount;
  /** Business date (epoch ms) of `netValuePerUnit`. */
  netValueDate?: number;
  /** Redemption fee charged (CNY); always `0.00` under the simulated fee rule. */
  feeAmount?: MoneyAmount;
  /** The fee rule applied; always `SIMULATED_NONE`. */
  feeRule?: string;
  /** `amount − redeemedPrincipal` booked as realized profit by this redemption (CNY, may be negative). */
  realizedProfit?: MoneyAmount;
  /** REMAINING position cost (剩余持仓成本, CNY) left after a redemption. */
  remainingCost?: MoneyAmount;
  /** @deprecated Renamed: the COST consumed by this redemption (CNY), never a principal payout口径. */
  redeemedPrincipal?: MoneyAmount;
  /** REMAINING position cost (剩余持仓成本, CNY) left after a PARTIAL redemption. */
  remainingPrincipal?: MoneyAmount;
  /** Unrounded market value left after a PARTIAL redemption (CNY). */
  remainingMarketValue?: DecimalAmount;
  /** `remainingMarketValue - remainingCost` after a PARTIAL redemption. */
  remainingProfit?: DecimalAmount;
  /** Present on a subscription: the shares bought by this purchase. */
  subscribedShares?: DecimalAmount;
  /** Present on a subscription: the holding's total shares after this purchase. */
  totalShares?: DecimalAmount;
  /** Present on a subscription: `true` when the amount was aggregated into an existing `HOLDING`. */
  addedToExisting?: boolean;
  /** Epoch ms of the purchase recorded by this subscription. */
  lastPurchaseAt?: number;
}

/* -------------------------------------------------------------------- budget */

export type BudgetStatus = 'RESERVED' | 'USED' | 'RELEASED';

export interface BudgetView {
  id: string;
  name: string;
  amount: MoneyAmount;
  purpose?: string;
  status: BudgetStatus;
  /** Epoch ms. */
  dueDate?: number;
  /** Epoch ms. */
  createdAt: number;
}

export interface ReserveBudgetInput {
  userId: string;
  name: string;
  amount: MoneyInput;
  purpose?: string;
  /** Epoch ms. */
  dueDate?: number;
  /**
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT create a
     * second budget for this user: only that owner's persisted reservation is replayed (same `id`). The planner
   * passes `nodeExecutionKey(taskId, nodeId)`. Absent → unchanged behavior.
   */
  idempotencyKey?: string;
}

/* --------------------------------------------------------------- task (sched) */

export type ScheduledTaskKind = 'REMINDER' | 'PAYMENT' | 'TRANSFER';
export type ScheduledTaskStatus = 'SCHEDULED' | 'DISPATCHING' | 'AWAITING_CONFIRMATION' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface ScheduledTaskView {
  id: string;
  name: string;
  kind: ScheduledTaskKind;
  payload?: Record<string, unknown>;
  /** Epoch ms. */
  runAt: number;
  status: ScheduledTaskStatus;
  requiresConfirmation: boolean;
  /** Epoch ms. */
  createdAt: number;
  dispatchTaskId?: string;
  deliveredAt?: number;
  dispatchError?: string;
}

export interface CreateScheduledTaskInput {
  userId: string;
  name: string;
  kind: ScheduledTaskKind;
  payload?: Record<string, unknown>;
  /** Epoch ms. */
  runAt: number;
  /**
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT create a
   * second scheduled task: the already-persisted task is replayed (same `id`) instead. The planner
   * passes `nodeExecutionKey(taskId, nodeId)`. Absent → unchanged behavior.
   */
  idempotencyKey?: string;
}

/* ----------------------------------------------------------------- dashboard */

export interface DashboardSummary {
  /** Cash plus active estimated holding values (CNY), without settlement rounding. */
  totalAssets: DecimalAmount;
  /** Primary CHECKING account balance (CNY). */
  checkingBalance: MoneyAmount;
  /** Sum of credit-card available limits (CNY). */
  creditAvailable: MoneyAmount;
  /** Current-month spend (positive CNY). */
  monthSpend: MoneyAmount;
  /** `YYYY-MM`. */
  month: string;
  recentTransactions: TransactionView[];
  latestAnomaly: AnomalyItem | null;
  /** Epoch ms. */
  asOf: number;
}

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
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT issue a
   * second card: the card id is derived deterministically from (userId, key), and the existing
   * virtual card is replayed (same `id`) instead of creating another one. Absent → unchanged
   * behavior (every call issues a NEW card with a freshly generated masked number).
   */
  idempotencyKey?: string;
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
  /** Principal invested (CNY). */
  amount: MoneyAmount;
  /** Unrounded estimated market value (CNY), independent of settlement precision. */
  marketValue?: DecimalAmount;
  /** `marketValue - amount`, when `marketValue` is known. */
  profit?: DecimalAmount;
  /** Epoch ms. */
  boughtAt: number;
  status: HoldingStatus;
  /** Epoch ms of the most recent purchase in this holding; absent when no purchase history is recorded. */
  lastPurchaseAt?: number;
  /** Purchases recorded on this holding, oldest → newest (absent when no history is recorded). */
  purchases?: HoldingPurchase[];
}

/** One recorded subscription that added principal to a holding (oldest → newest in `HoldingView.purchases`). */
export interface HoldingPurchase {
  /** CNY amount added by this purchase. */
  amount: MoneyAmount;
  /** Epoch ms of this purchase. */
  at: number;
  /** Principal of the holding after this purchase was aggregated in (CNY). */
  totalPrincipal: MoneyAmount;
  /** Unrounded estimated market value after this purchase (CNY). */
  marketValue: DecimalAmount;
  /** Funding-account balance after this purchase (CNY). */
  newBalance: MoneyAmount;
  /** Server-resolved funding account. */
  sourceAccountId: string;
  /** Execution identity of this purchase, when the caller supplied one. */
  executionKey?: string;
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
   * Optional PRINCIPAL amount to redeem (CNY decimal string), interpreted as a portion of the
   * holding's booked principal. Absent, or equal to the held principal, redeems the whole holding
   * (status `HOLDING` → `REDEEMED`, one final credit). A smaller positive amount redeems that
   * portion: the settled value of the portion is credited, the principal decreases and the holding
   * stays `HOLDING`. A larger, non-positive or malformed amount throws `VALIDATION`.
   */
  redeemAmount?: MoneyInput;
  /** Server-snapshotted redemption amount shown before MFA; changes require a new decision. */
  expectedRedemptionAmount?: MoneyInput;
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
  amount: MoneyAmount;
  /** Funding-account balance after the operation (CNY). */
  newBalance: MoneyAmount;
  /** Server-resolved funding account. */
  sourceAccountId: string;
  /** Epoch ms. */
  occurredAt: number;
  /** Exact CNY valuation used for redemption before rounding to booked minor units. */
  redemptionValuation?: DecimalAmount;
  /** Rounding rule applied once when a redemption is settled. */
  settlementRounding?: 'HALF_UP';
  /** Present on a PARTIAL redemption: the holding stays `HOLDING` with a smaller principal. */
  partial?: boolean;
  /** Principal settled by this redemption (CNY); the redeemed portion, or the whole principal. */
  redeemedPrincipal?: MoneyAmount;
  /** Principal left in the holding after a PARTIAL redemption (CNY). */
  remainingPrincipal?: MoneyAmount;
  /** Unrounded estimated market value left after a PARTIAL redemption (CNY). */
  remainingMarketValue?: DecimalAmount;
  /** `remainingMarketValue - remainingPrincipal` after a PARTIAL redemption. */
  remainingProfit?: DecimalAmount;
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

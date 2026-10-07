/**
 * Banking SDK — public DTOs (the SDK's frozen public API surface).
 *
 * Rules:
 *  - These types cross the SDK boundary; downstream layers (`agent`, `planner`, `app`,
 *    `components`) import them from the SDK barrel (`banking-sdk/index.ts`).
 *  - They are VIEW MODELS: the SDK implementation maps Prisma rows onto these. Prisma model
 *    types MUST NOT leak out of the SDK.
 *  - Money is CNY `number`, 2-decimal (format via `lib/money`). Timestamps are epoch
 *    milliseconds (`number`), matching `lib/contracts`.
 */

/* ------------------------------------------------------------------ account */

export type AccountType = 'CHECKING' | 'SAVINGS';

export interface AccountView {
  id: string;
  type: AccountType;
  name: string;
  /** Masked account number, e.g. `****8821`. */
  numberMasked: string;
  /** Current balance in CNY. */
  balance: number;
  currency: string;
}

export interface BalanceView {
  /** Sum of all account balances (CNY). */
  totalAvailable: number;
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
  amount: number;
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
  /** Inclusive upper bound (epoch ms). */
  to?: number;
  category?: string;
  /** Max rows returned, most recent first. */
  limit?: number;
}

export interface SpendingQuery {
  /** `YYYY-MM` window; defaults to the current month. */
  month?: string;
}

export interface CategorySpend {
  category: string;
  amount: number;
  /** Share of total spend, percent 0–100. */
  share: number;
}

export interface MerchantSpend {
  merchant: string;
  amount: number;
  count: number;
}

export interface MonthlyTrendPoint {
  /** `YYYY-MM`. */
  month: string;
  amount: number;
}

export interface SpendingAnalysis {
  /** `YYYY-MM` window analysed. */
  month: string;
  /** Total spend in the window (positive CNY). */
  total: number;
  /** Total spend in the previous month (positive CNY). */
  prevTotal: number;
  /** Month-over-month change, percent (0 when `prevTotal` is 0). */
  momChangePct: number;
  byCategory: CategorySpend[];
  topMerchant: MerchantSpend | null;
  /** Rolling window of the most recent months, oldest → newest. */
  monthlyTrend: MonthlyTrendPoint[];
  /** Largest single spend in the window, or null. */
  largest: TransactionView | null;
}

export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface AnomalyItem {
  transaction: TransactionView;
  reason: string;
  severity: AnomalySeverity;
}

export interface AnomalyReport {
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
  amount: number;
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
  success: boolean;
  transactionId?: string;
  /** Funding-account balance after the debit (CNY). */
  newBalance?: number;
  recipient: TransferRecipient;
  amount: number;
  remark?: string;
  /** Epoch ms. */
  occurredAt: number;
}

/* ---------------------------------------------------------------------- card */

export type CardType = 'DEBIT' | 'CREDIT' | 'VIRTUAL';
export type CardStatus = 'ACTIVE' | 'FROZEN' | 'LOST' | 'PENDING';

export interface CardLimitView {
  category: string;
  amount: number;
}

export interface CardView {
  id: string;
  type: CardType;
  network: string;
  numberMasked: string;
  status: CardStatus;
  creditLimit?: number;
  availableLimit?: number;
  monthlyLimit?: number;
  limits: CardLimitView[];
}

export interface SetCardLimitInput {
  /** Trusted caller identity, injected by the server runner. */
  userId: string;
  cardId: string;
  category: string;
  /** CNY cap for the category. */
  amount: number;
}

export interface ReportLostCardInput {
  reason?: string;
}

export interface ApplyVirtualCardInput {
  userId: string;
  label?: string;
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
  amount: number;
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
  /** Expected annual return, percent (e.g. 3.25). */
  expectedRate: number;
  termDays: number;
  /** Minimum subscription amount (CNY). */
  minAmount: number;
  description?: string;
}

export interface ProductQuery {
  riskLevel?: InvestmentRiskLevel;
}

export interface InvestmentComparison {
  products: ProductView[];
  /** Product id with the highest `expectedRate`, if any. */
  highestRateId?: string;
  /** Product id with the lowest risk level, if any. */
  lowestRiskId?: string;
}

export interface HoldingView {
  id: string;
  productId: string;
  productName: string;
  riskLevel: InvestmentRiskLevel;
  /** Principal invested (CNY). */
  amount: number;
  marketValue?: number;
  /** `marketValue - amount`, when `marketValue` is known. */
  profit?: number;
  /** Epoch ms. */
  boughtAt: number;
  status: HoldingStatus;
}

export interface SubscribeInvestmentInput {
  userId: string;
  productId: string;
  /** CNY amount; must be ≥ product `minAmount`. */
  amount: number;
  /**
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT
   * double-debit: the holding already persisted for the key is replayed (same `holdingId` /
   * `amount`, current balance) instead of creating a second one. Stored on
   * `InvestmentHolding.idempotencyKey`; the planner passes `nodeExecutionKey(taskId, nodeId)`.
   * Absent → unchanged behavior.
   */
  idempotencyKey?: string;
}

export interface RedeemInvestmentInput {
  userId: string;
  holdingId: string;
  /**
   * Optional idempotency key — the redemption's EXECUTION IDENTITY. A repeat with the SAME
   * key on an already-REDEEMED holding REPLAYS the original redemption (same `amount`, current
   * balance); a DISTINCT (or absent) key on an already-REDEEMED holding always throws
   * `CONFLICT` — never a false success. The identity and original result are persisted on the
   * holding (`redeemExecutionKey` / `redeemResult`); the planner passes `nodeExecutionKey(taskId, nodeId)`.
   */
  idempotencyKey?: string;
}

export interface InvestResult {
  success: boolean;
  holdingId: string;
  productId: string;
  amount: number;
  /** Funding-account balance after the operation (CNY). */
  newBalance?: number;
  /** Epoch ms. */
  occurredAt: number;
}

/* -------------------------------------------------------------------- budget */

export type BudgetStatus = 'RESERVED' | 'USED' | 'RELEASED';

export interface BudgetView {
  id: string;
  name: string;
  amount: number;
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
  amount: number;
  purpose?: string;
  /** Epoch ms. */
  dueDate?: number;
  /**
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT create a
   * second budget: the already-persisted reservation is replayed (same `id`) instead. The planner
   * passes `nodeExecutionKey(taskId, nodeId)`. Absent → unchanged behavior.
   */
  idempotencyKey?: string;
}

/* --------------------------------------------------------------- task (sched) */

export type ScheduledTaskKind = 'REMINDER' | 'PAYMENT' | 'TRANSFER';
export type ScheduledTaskStatus = 'SCHEDULED' | 'DONE' | 'CANCELLED';

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
}

export interface CreateScheduledTaskInput {
  userId: string;
  name: string;
  kind: ScheduledTaskKind;
  payload?: Record<string, unknown>;
  /** Epoch ms. */
  runAt: number;
  /** Defaults to `true`. */
  requiresConfirmation?: boolean;
  /**
   * Optional idempotency key. When supplied, a repeated call with the SAME key does NOT create a
   * second scheduled task: the already-persisted task is replayed (same `id`) instead. The planner
   * passes `nodeExecutionKey(taskId, nodeId)`. Absent → unchanged behavior.
   */
  idempotencyKey?: string;
}

/* ----------------------------------------------------------------- dashboard */

export interface DashboardSummary {
  /** Sum of all account balances (CNY). */
  totalAssets: number;
  /** Primary CHECKING account balance (CNY). */
  checkingBalance: number;
  /** Sum of credit-card available limits (CNY). */
  creditAvailable: number;
  /** Current-month spend (positive CNY). */
  monthSpend: number;
  /** `YYYY-MM`. */
  month: string;
  recentTransactions: TransactionView[];
  latestAnomaly: AnomalyItem | null;
  /** Epoch ms. */
  asOf: number;
}

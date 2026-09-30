/**
 * tests/helpers/fixtures.ts — the canonical demo dataset as DETERMINISTIC constants + a seeder.
 *
 * Every scenario test starts from the same seeded world so assertions are reproducible and
 * offline. Values mirror the root `CONTEXT.md` "Data Model" section and the acceptance bar
 * (the 12 demo scenarios): demo user 李明, contacts 张伟/王芳/妈妈/李华, the Apple Store
 * ¥6,999 anomaly @ 2026-09-20 18:32, plus cards, subscriptions and investment products.
 *
 * STATUS: documented STUB — signatures + data are frozen; implementations land in Phase 2
 * (once `lib/db/repositories` and the Prisma client are generated). Do NOT put bank logic here.
 *
 * Timestamps are epoch ms (`number`); money is CNY (`number`). The anomaly lives on a FIXED
 * date so `detect_anomaly` (Test 7) is stable; "this month" fixtures are built relative to an
 * injectable `now` so spending tests (Test 6) are stable regardless of the real clock.
 */

/** Seeded demo user id (李明) — matches `lib/constants.DEFAULT_DEMO_USER_ID`. */
export const DEMO_USER_ID = 'user_liming';

export interface DemoUserFixture {
  id: string;
  name: string;
  phone: string;
  avatarEmoji: string;
}

export const DEMO_USER: DemoUserFixture = {
  id: DEMO_USER_ID,
  name: '李明',
  phone: '138****0001',
  avatarEmoji: '🧑',
};

export interface ContactFixture {
  /** Stable id so transfer specs can address a recipient deterministically. */
  id: string;
  name: string;
  phone: string;
  bank: string;
  remark?: string;
}

/** The four demo contacts. `zhangwei` / `wangfang` are the transfer recipients in Tests 2 & 3. */
export const CONTACTS: readonly ContactFixture[] = [
  { id: 'contact_zhangwei', name: '张伟', phone: '139****0002', bank: '招商银行' },
  { id: 'contact_wangfang', name: '王芳', phone: '137****0003', bank: '工商银行' },
  { id: 'contact_mama', name: '妈妈', phone: '136****0004', bank: '建设银行', remark: '家人' },
  { id: 'contact_lihua', name: '李华', phone: '135****0005', bank: '农业银行' },
];

/**
 * A second contact literally named 王芳 — used ONLY by the ambiguous-recipient case
 * (`transfer.createTransfer` by `name` → `AppError('CONFLICT')` with `detail.candidates`).
 * Not part of the default seed; insert explicitly in that test.
 */
export const AMBIGUOUS_CONTACT: ContactFixture = {
  id: 'contact_wangfang_2',
  name: '王芳',
  phone: '133****9999',
  bank: '中国银行',
};

export interface AccountFixture {
  id: string;
  userId: string;
  type: 'CHECKING' | 'SAVINGS';
  name: string;
  number: string;
  balance: number;
}

/** Primary 活期 ¥23,580 + a savings account. `checking` is the default funding account. */
export const ACCOUNTS: readonly AccountFixture[] = [
  { id: 'acct_checking', userId: DEMO_USER_ID, type: 'CHECKING', name: '活期账户', number: '****8821', balance: 23580 },
  { id: 'acct_savings', userId: DEMO_USER_ID, type: 'SAVINGS', name: '储蓄账户', number: '****3309', balance: 50000 },
];

export interface TransactionFixture {
  id: string;
  accountId: string;
  userId: string;
  /** Signed CNY: negative = expense. */
  amount: number;
  category: string;
  merchant: string;
  channel?: 'APP' | 'CARD' | 'TRANSFER' | 'SUBSCRIPTION';
  remark?: string;
  /** Epoch ms. */
  occurredAt: number;
  isAnomaly?: boolean;
  anomalyReason?: string;
}

/** 2026-09-20 18:32 local — the anomaly date from the acceptance bar (Test 7). */
export const ANOMALY_OCCURRED_AT = new Date(2026, 8, 20, 18, 32).getTime();

/**
 * The Apple Store anomaly — the single record `detect_anomaly` (Test 7) must surface.
 * Amount exceeds `lib/constants.ANOMALY_AMOUNT_THRESHOLD` (¥5,000).
 */
export const ANOMALY_TRANSACTION: TransactionFixture = {
  id: 'tx_anomaly_apple',
  accountId: 'acct_checking',
  userId: DEMO_USER_ID,
  amount: -6999,
  category: '购物',
  merchant: 'Apple Store',
  channel: 'CARD',
  occurredAt: ANOMALY_OCCURRED_AT,
  isAnomaly: true,
  anomalyReason: '大额消费（>¥5,000）',
};

/**
 * Placeholder for the current-month ordinary spend set (~¥5,800/month incl. 娱乐) used by
 * Tests 6 (spending analysis) and 11 (conditional DAG: "if 本月娱乐 > 2000 …"). Built by the
 * seeder relative to an injectable `now` so the window is stable — see `buildCurrentMonthSpend`.
 */
export const MONTHLY_SPEND_TOTAL = 5800;

export interface ProductFixture {
  id: string;
  code: string;
  name: string;
  riskLevel: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  expectedRate: number;
  termDays: number;
  minAmount: number;
  description?: string;
}

/** 3–5 products. `稳健理财A` (Test 9: 买 5000 → RED MFA) is R2 with a ¥1,000 min. */
export const PRODUCTS: readonly ProductFixture[] = [
  { id: 'prod_wenjiana', code: 'WJA001', name: '稳健理财A', riskLevel: 'R2', expectedRate: 3.25, termDays: 90, minAmount: 1000, description: '低风险稳健型' },
  { id: 'prod_wenjib', code: 'WJB002', name: '稳健理财B', riskLevel: 'R2', expectedRate: 3.6, termDays: 180, minAmount: 5000, description: '低风险稳健型' },
  { id: 'prod_jinrong', code: 'JR003', name: '进取混合C', riskLevel: 'R3', expectedRate: 5.1, termDays: 365, minAmount: 10000, description: '中风险混合型' },
];

export interface SubscriptionFixture {
  id: string;
  userId: string;
  name: string;
  amount: number;
  cycle: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  /** Epoch ms. */
  nextChargeAt: number;
  status: 'ACTIVE' | 'CANCELLED';
  remind: boolean;
}

export interface Options {
  /** Injectable clock for relative (current-month) fixtures; defaults to `Date.now()`. */
  now?: Date;
  /** Seed the duplicate 王芳 contact (ambiguous-recipient tests). */
  withAmbiguousContact?: boolean;
}

/**
 * Insert the full canonical demo dataset into the test DB.
 *
 * Preconditions: the schema exists (see `tests/setup.ts`) and
 * `lib/db/repositories/*` are implemented. Idempotent is NOT guaranteed — call it on a
 * freshly reset DB (typically via `db.resetDatabase()`).
 *
 * NOT YET IMPLEMENTED (Phase 2). Signature + the data above are the frozen contract.
 */
export async function seedDemoData(_options: Options = {}): Promise<void> {
  throw new Error('not implemented');
}

/** Build the current-month ordinary transactions (incl. 娱乐 category) relative to `now`. */
export function buildCurrentMonthSpend(_now: Date = new Date()): TransactionFixture[] {
  throw new Error('not implemented');
}

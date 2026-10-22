/**
 * tests/helpers/fixtures.ts — the canonical demo dataset as DETERMINISTIC constants + a seeder.
 *
 * Every scenario test starts from the same seeded world so assertions are reproducible and
 * offline. Values mirror the root `CONTEXT.md` "Data Model" section and the acceptance bar
 * (the 12 demo scenarios): demo user 李明, contacts 张伟/王芳/妈妈/李华, the Apple Store
 * ¥6,999 anomaly @ 2026-09-20 18:32, plus cards, subscriptions and investment products.
 * They KEEP IN SYNC with `prisma/seed.ts` (the same values — that file is the reference).
 *
 * All "current/previous/next month" rows are built RELATIVE to an injectable `now` (default
 * `demoNow()` = 2026-09-25 12:00 UTC+8) using the banking business calendar,
 * so month windows and anomaly dates remain independent of the deployment host.
 *
 * Timestamps are epoch milliseconds. Monetary fixture inputs are exact decimal strings.
 */
import { demoNow } from '@/lib/clock';
import { moneyToCents } from '@/lib/money';
import { decimalText } from '@/lib/decimal';
import { businessCalendarParts, businessDate } from '@/lib/date';
import { ensureTestPragmas, getTestPrisma } from './db';

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
  /** 完整虚构测试手机号（0000 号段），仅供服务端精确匹配，任何对外投影都不得输出。 */
  phoneFull: string;
  bank: string;
  remark?: string;
}

// 虚构测试数据：0000 号段，非真实手机号/卡号
/** The four demo contacts. `zhangwei` / `wangfang` are the transfer recipients in Tests 2 & 3. */
export const CONTACTS: readonly ContactFixture[] = [
  { id: 'contact_zhangwei', name: '张伟', phone: '139****0002', phoneFull: '13900000002', bank: '招商银行' },
  { id: 'contact_wangfang', name: '王芳', phone: '137****0003', phoneFull: '13700000003', bank: '工商银行' },
  { id: 'contact_mama', name: '妈妈', phone: '136****0004', phoneFull: '13600000004', bank: '建设银行', remark: '家人' },
  { id: 'contact_lihua', name: '李华', phone: '135****0005', phoneFull: '13500000005', bank: '农业银行' },
];

/**
 * A second contact literally named 王芳 — used ONLY by the ambiguous-recipient case
 * (`transfer.createTransfer` by `name` → `AppError('CONFLICT')` with `detail.candidates`).
 * Not part of the default seed; insert explicitly via `seedDemoData({ withAmbiguousContact: true })`.
 */
export const AMBIGUOUS_CONTACT: ContactFixture = {
  id: 'contact_wangfang_2',
  name: '王芳',
  phone: '133****9999',
  phoneFull: '13300009999',
  bank: '中国银行',
};

export interface AccountFixture {
  id: string;
  userId: string;
  type: 'CHECKING' | 'SAVINGS';
  name: string;
  number: string;
  balance: string;
}

/** Primary 活期 ¥23,580 + a savings account. `checking` is the default funding account. */
export const ACCOUNTS: readonly AccountFixture[] = [
  { id: 'acct_checking', userId: DEMO_USER_ID, type: 'CHECKING', name: '活期账户', number: '****8821', balance: '23580.00' },
  { id: 'acct_savings', userId: DEMO_USER_ID, type: 'SAVINGS', name: '储蓄账户', number: '****3309', balance: '50000.00' },
];

/** The funding account every seeded transaction is attached to. */
const CHECKING_ACCOUNT_ID = 'acct_checking';

export interface CardFixture {
  id: string;
  userId: string;
  type: 'DEBIT' | 'CREDIT' | 'VIRTUAL';
  network: string;
  numberMasked: string;
  /** 完整虚构卡号（0000 号段），仅供服务端精确匹配，任何对外投影都不得输出。 */
  numberFull: string;
  status: 'ACTIVE' | 'FROZEN' | 'LOST' | 'PENDING';
  creditLimit: string | null;
  availableLimit: string | null;
  monthlyLimit: string | null;
  /** Settlement CHECKING account id recorded on this card (DEBIT/VIRTUAL); CREDIT cards are never bound. */
  linkedAccountId?: string | null;
}

// 虚构测试数据：0000 号段，非真实手机号/卡号
/** Credit card (¥18,000 limit) + a debit card. `card_credit` carries the 娱乐 card limit. */
export const CARDS: readonly CardFixture[] = [
  {
    id: 'card_credit',
    userId: DEMO_USER_ID,
    type: 'CREDIT',
    network: 'UnionPay',
    numberMasked: '****6688',
    numberFull: '6222000000006688',
    status: 'ACTIVE',
    creditLimit: '18000.00',
    availableLimit: '18000.00',
    monthlyLimit: '18000.00',
  },
  {
    id: 'card_debit',
    userId: DEMO_USER_ID,
    type: 'DEBIT',
    network: 'UnionPay',
    numberMasked: '****8821',
    numberFull: '6222000000008821',
    status: 'ACTIVE',
    creditLimit: null,
    availableLimit: null,
    monthlyLimit: null,
    linkedAccountId: 'acct_checking',
  },
];

export interface CardLimitFixture {
  id: string;
  cardId: string;
  category: string;
  amount: string;
}

/** Per-category card limits (Test 8 sets these; the seed ships one 娱乐 limit). */
export const CARD_LIMITS: readonly CardLimitFixture[] = [
  { id: 'limit_credit_ent', cardId: 'card_credit', category: '娱乐', amount: '3000.00' },
];

export interface TransactionFixture {
  id: string;
  accountId: string;
  userId: string;
  /** Signed CNY: negative = expense. */
  amount: string;
  /**
   * Ledger direction. OPTIONAL: when omitted the seeder DERIVES it from the sign
   * (`amount < 0` → `DEBIT`, otherwise `CREDIT`), so a fixture only states it to be explicit.
   */
  direction?: 'DEBIT' | 'CREDIT';
  category: string;
  merchant: string;
  channel?: 'APP' | 'CARD' | 'TRANSFER' | 'SUBSCRIPTION';
  remark?: string;
  /** Contact id the money went to (historical reference only; no FK relation). */
  counterpartyId?: string;
  /** Epoch ms. */
  occurredAt: number;
  isAnomaly?: boolean;
  anomalyReason?: string;
}

/** 2026-09-20 18:32 local — the anomaly date from the acceptance bar (Test 7). */
export const ANOMALY_OCCURRED_AT = businessDate(2026, 8, 20, 18, 32).getTime();

/**
 * The Apple Store anomaly — the single record `detect_anomaly` (Test 7) must surface.
 * Amount exceeds `lib/constants.ANOMALY_AMOUNT_THRESHOLD` (¥5,000).
 */
export const ANOMALY_TRANSACTION: TransactionFixture = {
  id: 'tx_anomaly_apple',
  accountId: CHECKING_ACCOUNT_ID,
  userId: DEMO_USER_ID,
  amount: '-6999.00',
  category: '购物',
  merchant: 'Apple Store',
  channel: 'CARD',
  occurredAt: ANOMALY_OCCURRED_AT,
  isAnomaly: true,
  anomalyReason: '大额消费（>¥5,000）',
};

/**
 * The current-month ordinary spend set (incl. 娱乐 ¥2,680) used by Tests 6 (spending analysis)
 * and 11 (conditional DAG: "if 本月娱乐 > 2000 …"). Built relative to an injectable `now` so the
 * window is stable — see `buildCurrentMonthSpend`. Sum of magnitudes = EXACTLY ¥5,800 (the ¥6,999
 * anomaly is a SEPARATE row and is NOT counted here).
 */
export const MONTHLY_SPEND_TOTAL = '5800.00';

export interface ProductFixture {
  id: string;
  code: string;
  name: string;
  riskLevel: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  annualYieldRate: string;
  termDays: number;
  minAmount: string;
  description?: string;
}

/** 4 products (matches `prisma/seed.ts`). `稳健理财A` (Test 9: 买 5000 → RED MFA) is R2 ¥1,000 min. */
export const PRODUCTS: readonly ProductFixture[] = [
  { id: 'prod_wenjiana', code: 'WJA001', name: '稳健理财A', riskLevel: 'R2', annualYieldRate: '0.0325', termDays: 90, minAmount: '1000.00', description: '低风险稳健型' },
  { id: 'prod_wenjib', code: 'WJB002', name: '稳健理财B', riskLevel: 'R2', annualYieldRate: '0.036', termDays: 180, minAmount: '5000.00', description: '低风险稳健型' },
  { id: 'prod_jinrong', code: 'JR003', name: '进取混合C', riskLevel: 'R3', annualYieldRate: '0.051', termDays: 365, minAmount: '10000.00', description: '中风险混合型' },
  { id: 'prod_huobi', code: 'MMF001', name: '货币基金', riskLevel: 'R1', annualYieldRate: '0.021', termDays: 30, minAmount: '100.00', description: '现金管理型' },
];

export interface SubscriptionFixture {
  id: string;
  userId: string;
  name: string;
  amount: string;
  cycle: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  /** Epoch ms. */
  nextChargeAt: number;
  status: 'ACTIVE' | 'CANCELLED';
  remind: boolean;
}

export interface HoldingFixture {
  id: string;
  userId: string;
  productId: string;
  amount: string;
  marketValue: string;
  /** Epoch ms. */
  boughtAt: number;
  status: 'HOLDING' | 'REDEEMED';
}

export interface BudgetFixture {
  id: string;
  userId: string;
  name: string;
  amount: string;
  purpose: string;
  status: 'RESERVED' | 'USED' | 'RELEASED';
  /** Epoch ms. */
  dueDate: number;
}

export interface ScheduledTaskFixture {
  id: string;
  userId: string;
  name: string;
  kind: 'REMINDER' | 'PAYMENT' | 'TRANSFER';
  /** JSON text. */
  payload: string;
  /** Epoch ms. */
  runAt: number;
  status: 'SCHEDULED' | 'DONE' | 'CANCELLED';
  requiresConfirmation: boolean;
}

export interface Options {
  /** Injectable clock for relative (current/previous/next-month) fixtures; defaults to `demoNow()`. */
  now?: Date;
  /** Seed the duplicate 王芳 contact (ambiguous-recipient tests). */
  withAmbiguousContact?: boolean;
}

/* ------------------------------------------------------------------ date helpers */

/** Local-component date in the month of `now` (mirrors seed.ts's `sep(...)` shorthand). */
function thisMonth(now: Date, day: number, hour = 0, minute = 0): Date {
  const calendar = businessCalendarParts(now);
  return businessDate(calendar.year, calendar.month, day, hour, minute);
}

/** Local-component date in the month BEFORE `now` (seed.ts's `aug(...)`). */
function lastMonth(now: Date, day: number, hour = 0, minute = 0): Date {
  const calendar = businessCalendarParts(now);
  return businessDate(calendar.year, calendar.month - 1, day, hour, minute);
}

/** Local-component date in the month AFTER `now` (seed.ts's `oct(...)`). */
function nextMonth(now: Date, day: number, hour = 0, minute = 0): Date {
  const calendar = businessCalendarParts(now);
  return businessDate(calendar.year, calendar.month + 1, day, hour, minute);
}

/* ------------------------------------------------------------------ dataset builders */

type SpendRow = Omit<TransactionFixture, 'accountId' | 'userId'>;

/**
 * Current-month ordinary spend (mirrors `prisma/seed.ts` SEPTEMBER_TRANSACTIONS, 24 rows).
 * Sum of magnitudes = ¥5,800, of which 娱乐 = ¥2,680. 美团外卖 + 星巴克 sit on the `now` day so a
 * "今日消费" window exists. The ¥6,999 anomaly is NOT included here.
 */
const CURRENT_MONTH_SPEND: readonly ((now: Date) => SpendRow)[] = [
  // 餐饮 450 (CARD)
  (n) => ({ id: 'tx_sep_haidilao', amount: '-305.00', category: '餐饮', merchant: '海底捞', channel: 'CARD', occurredAt: thisMonth(n, 5, 19, 20).getTime() }),
  (n) => ({ id: 'tx_sep_meituan', amount: '-45.00', category: '餐饮', merchant: '美团外卖', channel: 'CARD', occurredAt: thisMonth(n, 25, 12, 10).getTime() }),
  (n) => ({ id: 'tx_sep_starbucks', amount: '-38.00', category: '餐饮', merchant: '星巴克', channel: 'CARD', occurredAt: thisMonth(n, 25, 9, 5).getTime() }),
  (n) => ({ id: 'tx_sep_kfc', amount: '-62.00', category: '餐饮', merchant: '肯德基', channel: 'CARD', occurredAt: thisMonth(n, 12, 12, 40).getTime() }),
  // 出行 636 (APP)
  (n) => ({ id: 'tx_sep_rail', amount: '-553.00', category: '出行', merchant: '高铁票', channel: 'APP', occurredAt: thisMonth(n, 3, 8, 15).getTime() }),
  (n) => ({ id: 'tx_sep_didi1', amount: '-45.00', category: '出行', merchant: '滴滴出行', channel: 'APP', occurredAt: thisMonth(n, 8, 22, 30).getTime() }),
  (n) => ({ id: 'tx_sep_didi2', amount: '-32.00', category: '出行', merchant: '滴滴出行', channel: 'APP', occurredAt: thisMonth(n, 14, 18, 50).getTime() }),
  (n) => ({ id: 'tx_sep_metro', amount: '-6.00', category: '出行', merchant: '地铁', channel: 'APP', occurredAt: thisMonth(n, 18, 7, 40).getTime() }),
  // 购物 984 (CARD)
  (n) => ({ id: 'tx_sep_uniqlo', amount: '-399.00', category: '购物', merchant: '优衣库', channel: 'CARD', occurredAt: thisMonth(n, 6, 15, 0).getTime() }),
  (n) => ({ id: 'tx_sep_taobao', amount: '-289.00', category: '购物', merchant: '淘宝', channel: 'CARD', occurredAt: thisMonth(n, 11, 21, 30).getTime() }),
  (n) => ({ id: 'tx_sep_jd', amount: '-296.00', category: '购物', merchant: '京东', channel: 'CARD', occurredAt: thisMonth(n, 19, 20, 10).getTime() }),
  // 娱乐 2680 (CARD) — Test 11 threshold: 本月娱乐 > 2000
  (n) => ({ id: 'tx_sep_concert', amount: '-1880.00', category: '娱乐', merchant: '演唱会门票', channel: 'CARD', occurredAt: thisMonth(n, 10, 20, 0).getTime() }),
  (n) => ({ id: 'tx_sep_ktv', amount: '-480.00', category: '娱乐', merchant: 'KTV', channel: 'CARD', occurredAt: thisMonth(n, 13, 23, 0).getTime() }),
  (n) => ({ id: 'tx_sep_steam', amount: '-200.00', category: '娱乐', merchant: 'Steam', channel: 'CARD', occurredAt: thisMonth(n, 16, 22, 0).getTime() }),
  (n) => ({ id: 'tx_sep_cinema', amount: '-120.00', category: '娱乐', merchant: '影院电影票', channel: 'CARD', occurredAt: thisMonth(n, 22, 19, 30).getTime() }),
  // 居住 300 (APP)
  (n) => ({ id: 'tx_sep_utilities', amount: '-180.00', category: '居住', merchant: '水电费', channel: 'APP', occurredAt: thisMonth(n, 1, 10, 0).getTime() }),
  (n) => ({ id: 'tx_sep_property', amount: '-120.00', category: '居住', merchant: '物业费', channel: 'APP', occurredAt: thisMonth(n, 2, 10, 0).getTime() }),
  // 医疗 86 (CARD)
  (n) => ({ id: 'tx_sep_pharmacy', amount: '-86.00', category: '医疗', merchant: '药店', channel: 'CARD', occurredAt: thisMonth(n, 9, 17, 20).getTime() }),
  // 订阅 114 (SUBSCRIPTION)
  (n) => ({ id: 'tx_sep_netflix', amount: '-68.00', category: '订阅', merchant: 'Netflix', channel: 'SUBSCRIPTION', occurredAt: thisMonth(n, 15, 0, 0).getTime() }),
  (n) => ({ id: 'tx_sep_spotify', amount: '-15.00', category: '订阅', merchant: 'Spotify', channel: 'SUBSCRIPTION', occurredAt: thisMonth(n, 15, 0, 0).getTime() }),
  (n) => ({ id: 'tx_sep_icloud', amount: '-6.00', category: '订阅', merchant: 'iCloud', channel: 'SUBSCRIPTION', occurredAt: thisMonth(n, 21, 0, 0).getTime() }),
  (n) => ({ id: 'tx_sep_video', amount: '-25.00', category: '订阅', merchant: '视频会员', channel: 'SUBSCRIPTION', occurredAt: thisMonth(n, 17, 0, 0).getTime() }),
  // 转账 500 (TRANSFER) — to contact 妈妈
  (n) => ({ id: 'tx_sep_transfer_mama', amount: '-500.00', category: '转账', merchant: '转账给妈妈', channel: 'TRANSFER', counterpartyId: 'contact_mama', occurredAt: thisMonth(n, 4, 19, 0).getTime() }),
  // 其他 50 (APP)
  (n) => ({ id: 'tx_sep_phone', amount: '-50.00', category: '其他', merchant: '话费充值', channel: 'APP', occurredAt: thisMonth(n, 7, 9, 30).getTime() }),
];

/** Previous-month (last month) expenses (~¥6,230) so month-over-month trends are sensible. */
const PREVIOUS_MONTH_SPEND: readonly ((now: Date) => SpendRow)[] = [
  (n) => ({ id: 'tx_aug_rent', amount: '-2500.00', category: '居住', merchant: '房租', channel: 'TRANSFER', occurredAt: lastMonth(n, 1, 9, 0).getTime() }),
  (n) => ({ id: 'tx_aug_dining', amount: '-1350.00', category: '餐饮', merchant: '餐饮支出', channel: 'CARD', occurredAt: lastMonth(n, 14, 19, 30).getTime() }),
  (n) => ({ id: 'tx_aug_travel', amount: '-620.00', category: '出行', merchant: '出行支出', channel: 'APP', occurredAt: lastMonth(n, 20, 8, 45).getTime() }),
  (n) => ({ id: 'tx_aug_shopping', amount: '-1080.00', category: '购物', merchant: '购物支出', channel: 'CARD', occurredAt: lastMonth(n, 22, 15, 10).getTime() }),
  (n) => ({ id: 'tx_aug_ent', amount: '-680.00', category: '娱乐', merchant: '娱乐支出', channel: 'CARD', occurredAt: lastMonth(n, 25, 21, 0).getTime() }),
];

/** Attach the account + user every seeded transaction shares. */
function toTransaction(row: SpendRow): TransactionFixture {
  return { accountId: CHECKING_ACCOUNT_ID, userId: DEMO_USER_ID, ...row };
}

/** Build the current-month ordinary transactions (incl. 娱乐 category) relative to `now`. */
export function buildCurrentMonthSpend(now: Date = new Date(demoNow())): TransactionFixture[] {
  return CURRENT_MONTH_SPEND.map((build) => toTransaction(build(now)));
}

/** Build the previous-month transactions relative to `now` (for 环比/trend assertions). */
export function buildPreviousMonthSpend(now: Date = new Date(demoNow())): TransactionFixture[] {
  return PREVIOUS_MONTH_SPEND.map((build) => toTransaction(build(now)));
}

/** Stable id of the seeded salary income row (a LARGE CREDIT — never 大额消费). */
export const SALARY_TRANSACTION_ID = 'tx_sep_salary';

/**
 * Current-month salary income (+¥11,000, category 工资, channel APP) — a deliberately LARGE INCOME
 * row. It backs the anomaly regression: `detect_anomaly` may only flag EXPENSE (DEBIT) rows, so this
 * CREDIT must never surface as 大额消费, and being a CREDIT it must not move the 本月 consumption
 * anchor either (¥5,800). Built relative to `now` (never `Date.now()`), like the spend rows.
 *
 * This is the ONE intentional divergence from `prisma/seed.ts` (the seeder has no income row); it
 * exists purely so the DEBIT-only rule is exercised against the standard fixture world.
 */
export function buildSalaryTransaction(now: Date = new Date(demoNow())): TransactionFixture {
  return toTransaction({
    id: SALARY_TRANSACTION_ID,
    amount: '11000.00',
    category: '工资',
    merchant: '工资',
    channel: 'APP',
    occurredAt: thisMonth(now, 10, 9, 0).getTime(),
  });
}

/** The four active subscriptions (nextChargeAt = the month after `now`). */
export function buildSubscriptions(now: Date = new Date(demoNow())): SubscriptionFixture[] {
  return [
    { id: 'sub_netflix', userId: DEMO_USER_ID, name: 'Netflix', amount: '68.00', cycle: 'MONTHLY', nextChargeAt: nextMonth(now, 15).getTime(), status: 'ACTIVE', remind: false },
    { id: 'sub_spotify', userId: DEMO_USER_ID, name: 'Spotify', amount: '15.00', cycle: 'MONTHLY', nextChargeAt: nextMonth(now, 15).getTime(), status: 'ACTIVE', remind: false },
    { id: 'sub_icloud', userId: DEMO_USER_ID, name: 'iCloud', amount: '6.00', cycle: 'MONTHLY', nextChargeAt: nextMonth(now, 21).getTime(), status: 'ACTIVE', remind: false },
    { id: 'sub_video', userId: DEMO_USER_ID, name: '视频会员', amount: '25.00', cycle: 'MONTHLY', nextChargeAt: nextMonth(now, 17).getTime(), status: 'ACTIVE', remind: false },
  ];
}

/** The single seeded investment holding (稳健理财A, bought last month). */
export function buildHoldings(now: Date = new Date(demoNow())): HoldingFixture[] {
  return [
    { id: 'holding_wenjiana', userId: DEMO_USER_ID, productId: 'prod_wenjiana', amount: '5000.00', marketValue: '5050', boughtAt: lastMonth(now, 10, 10, 0).getTime(), status: 'HOLDING' },
  ];
}

/** The single reserved budget (生日礼物, due next month). */
export function buildBudgets(now: Date = new Date(demoNow())): BudgetFixture[] {
  return [
    { id: 'budget_birthday', userId: DEMO_USER_ID, name: '生日礼物', amount: '2000.00', purpose: '生日计划', status: 'RESERVED', dueDate: nextMonth(now, 20).getTime() },
  ];
}

/** The two scheduled tasks (a birthday reminder + a rent transfer), both next month. */
export function buildScheduledTasks(now: Date = new Date(demoNow())): ScheduledTaskFixture[] {
  return [
    {
      id: 'task_birthday_reminder',
      userId: DEMO_USER_ID,
      name: '生日提醒',
      kind: 'REMINDER',
      payload: JSON.stringify({ note: '妈妈生日，记得准备礼物' }),
      runAt: nextMonth(now, 18, 9, 0).getTime(),
      status: 'SCHEDULED',
      requiresConfirmation: true,
    },
    {
      id: 'task_rent_transfer',
      userId: DEMO_USER_ID,
      name: '房租自动转账',
      kind: 'TRANSFER',
      payload: JSON.stringify({ amount: '2500.00', name: '房东' }),
      runAt: nextMonth(now, 1, 9, 0).getTime(),
      status: 'SCHEDULED',
      requiresConfirmation: true,
    },
  ];
}

/* ------------------------------------------------------------------ seeder */

/**
 * Insert the full canonical demo dataset into the test DB (mirrors `prisma/seed.ts`).
 *
 * Preconditions: the schema exists (see `tests/setup.ts`). NOT idempotent — call it on a freshly
 * reset DB (typically via `db.resetDatabase()`, which truncates first).
 *
 * `options.now` (default `demoNow()`) anchors every relative date (current/previous/next month).
 */
export async function seedDemoData(options: Options = {}): Promise<void> {
  await ensureTestPragmas();
  const prisma = getTestPrisma();
  const now = options.now ?? new Date(demoNow());

  // Parents → children.
  await prisma.user.create({ data: DEMO_USER });

  await prisma.account.createMany({
    data: ACCOUNTS.map(({ balance, ...account }) => ({ ...account, balanceMinor: moneyToCents(balance), currency: 'CNY' })),
  });

  const contacts = options.withAmbiguousContact ? [...CONTACTS, AMBIGUOUS_CONTACT] : CONTACTS;
  await prisma.contact.createMany({
    data: contacts.map((c) => ({
      id: c.id,
      userId: DEMO_USER_ID,
      name: c.name,
      phone: c.phone,
      phoneFull: c.phoneFull,
      bank: c.bank,
      remark: c.remark ?? null,
    })),
  });

  await prisma.card.createMany({ data: CARDS.map(({ creditLimit, availableLimit, monthlyLimit, ...card }) => ({
    ...card,
    creditLimitMinor: creditLimit === null ? null : moneyToCents(creditLimit),
    availableLimitMinor: availableLimit === null ? null : moneyToCents(availableLimit),
    monthlyLimitMinor: monthlyLimit === null ? null : moneyToCents(monthlyLimit),
  })) });
  await prisma.cardLimit.createMany({ data: CARD_LIMITS.map(({ amount, ...limit }) => ({ ...limit, amountMinor: moneyToCents(amount) })) });

  const transactions = [
    ...buildCurrentMonthSpend(now),
    ANOMALY_TRANSACTION,
    buildSalaryTransaction(now),
    ...buildPreviousMonthSpend(now),
  ].map((t) => ({
    id: t.id,
    accountId: t.accountId,
    userId: t.userId,
    amountMinor: moneyToCents(t.amount),
    currency: 'CNY',
    direction: t.direction ?? (moneyToCents(t.amount) < 0n ? 'DEBIT' : 'CREDIT'),
    category: t.category,
    merchant: t.merchant,
    channel: t.channel ?? null,
    remark: t.remark ?? null,
    counterpartyId: t.counterpartyId ?? null,
    occurredAt: new Date(t.occurredAt),
    isAnomaly: t.isAnomaly ?? false,
    anomalyReason: t.anomalyReason ?? null,
  }));
  await prisma.transaction.createMany({ data: transactions });

  await prisma.subscription.createMany({
    data: buildSubscriptions(now).map(({ amount, ...subscription }) => ({ ...subscription, amountMinor: moneyToCents(amount), nextChargeAt: new Date(subscription.nextChargeAt) })),
  });
  await prisma.investmentProduct.createMany({ data: PRODUCTS.map(({ minAmount, ...product }) => ({
    ...product, minAmountMinor: moneyToCents(minAmount),
  })) });

  await prisma.investmentHolding.createMany({
    data: buildHoldings(now).map(({ amount, marketValue, ...holding }) => ({
      ...holding, principalAmountMinor: moneyToCents(amount), estimatedMarketValue: decimalText(marketValue), boughtAt: new Date(holding.boughtAt),
    })),
  });

  await prisma.budget.createMany({
    data: buildBudgets(now).map(({ amount, ...budget }) => ({ ...budget, amountMinor: moneyToCents(amount), dueDate: new Date(budget.dueDate) })),
  });

  await prisma.scheduledTask.createMany({
    data: buildScheduledTasks(now).map((s) => ({ ...s, runAt: new Date(s.runAt) })),
  });
}

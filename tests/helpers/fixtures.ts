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
 * `demoNow()` = 2026-09-25 12:00 local) using LOCAL date components only — never `Date.now()` —
 * so 本月/上月 windows and the anomaly date agree with `lib/date` formatting on any timezone.
 *
 * Timestamps are epoch ms (`number`); money is CNY (`number`).
 */
import { demoNow } from '@/lib/clock';
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
 * Not part of the default seed; insert explicitly via `seedDemoData({ withAmbiguousContact: true })`.
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

/** The funding account every seeded transaction is attached to. */
const CHECKING_ACCOUNT_ID = 'acct_checking';

export interface CardFixture {
  id: string;
  userId: string;
  type: 'DEBIT' | 'CREDIT' | 'VIRTUAL';
  network: string;
  numberMasked: string;
  status: 'ACTIVE' | 'FROZEN' | 'LOST' | 'PENDING';
  creditLimit: number | null;
  availableLimit: number | null;
  monthlyLimit: number | null;
}

/** Credit card (¥18,000 limit) + a debit card. `card_credit` carries the 娱乐 card limit. */
export const CARDS: readonly CardFixture[] = [
  {
    id: 'card_credit',
    userId: DEMO_USER_ID,
    type: 'CREDIT',
    network: 'UnionPay',
    numberMasked: '****6688',
    status: 'ACTIVE',
    creditLimit: 18000,
    availableLimit: 18000,
    monthlyLimit: 18000,
  },
  {
    id: 'card_debit',
    userId: DEMO_USER_ID,
    type: 'DEBIT',
    network: 'UnionPay',
    numberMasked: '****8821',
    status: 'ACTIVE',
    creditLimit: null,
    availableLimit: null,
    monthlyLimit: null,
  },
];

export interface CardLimitFixture {
  id: string;
  cardId: string;
  category: string;
  amount: number;
}

/** Per-category card limits (Test 8 sets these; the seed ships one 娱乐 limit). */
export const CARD_LIMITS: readonly CardLimitFixture[] = [
  { id: 'limit_credit_ent', cardId: 'card_credit', category: '娱乐', amount: 3000 },
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
  /** Contact id the money went to (historical reference only; no FK relation). */
  counterpartyId?: string;
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
  accountId: CHECKING_ACCOUNT_ID,
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
 * The current-month ordinary spend set (incl. 娱乐 ¥2,680) used by Tests 6 (spending analysis)
 * and 11 (conditional DAG: "if 本月娱乐 > 2000 …"). Built relative to an injectable `now` so the
 * window is stable — see `buildCurrentMonthSpend`. Sum of magnitudes = EXACTLY ¥5,800 (the ¥6,999
 * anomaly is a SEPARATE row and is NOT counted here).
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

/** 4 products (matches `prisma/seed.ts`). `稳健理财A` (Test 9: 买 5000 → RED MFA) is R2 ¥1,000 min. */
export const PRODUCTS: readonly ProductFixture[] = [
  { id: 'prod_wenjiana', code: 'WJA001', name: '稳健理财A', riskLevel: 'R2', expectedRate: 3.25, termDays: 90, minAmount: 1000, description: '低风险稳健型' },
  { id: 'prod_wenjib', code: 'WJB002', name: '稳健理财B', riskLevel: 'R2', expectedRate: 3.6, termDays: 180, minAmount: 5000, description: '低风险稳健型' },
  { id: 'prod_jinrong', code: 'JR003', name: '进取混合C', riskLevel: 'R3', expectedRate: 5.1, termDays: 365, minAmount: 10000, description: '中风险混合型' },
  { id: 'prod_huobi', code: 'MMF001', name: '货币基金', riskLevel: 'R1', expectedRate: 2.1, termDays: 30, minAmount: 100, description: '现金管理型' },
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

export interface HoldingFixture {
  id: string;
  userId: string;
  productId: string;
  amount: number;
  marketValue: number;
  /** Epoch ms. */
  boughtAt: number;
  status: 'HOLDING' | 'REDEEMED';
}

export interface BudgetFixture {
  id: string;
  userId: string;
  name: string;
  amount: number;
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
  return new Date(now.getFullYear(), now.getMonth(), day, hour, minute);
}

/** Local-component date in the month BEFORE `now` (seed.ts's `aug(...)`). */
function lastMonth(now: Date, day: number, hour = 0, minute = 0): Date {
  return new Date(now.getFullYear(), now.getMonth() - 1, day, hour, minute);
}

/** Local-component date in the month AFTER `now` (seed.ts's `oct(...)`). */
function nextMonth(now: Date, day: number, hour = 0, minute = 0): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, day, hour, minute);
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
  (n) => ({ id: 'tx_sep_haidilao', amount: -305, category: '餐饮', merchant: '海底捞', channel: 'CARD', occurredAt: thisMonth(n, 5, 19, 20).getTime() }),
  (n) => ({ id: 'tx_sep_meituan', amount: -45, category: '餐饮', merchant: '美团外卖', channel: 'CARD', occurredAt: thisMonth(n, 25, 12, 10).getTime() }),
  (n) => ({ id: 'tx_sep_starbucks', amount: -38, category: '餐饮', merchant: '星巴克', channel: 'CARD', occurredAt: thisMonth(n, 25, 9, 5).getTime() }),
  (n) => ({ id: 'tx_sep_kfc', amount: -62, category: '餐饮', merchant: '肯德基', channel: 'CARD', occurredAt: thisMonth(n, 12, 12, 40).getTime() }),
  // 出行 636 (APP)
  (n) => ({ id: 'tx_sep_rail', amount: -553, category: '出行', merchant: '高铁票', channel: 'APP', occurredAt: thisMonth(n, 3, 8, 15).getTime() }),
  (n) => ({ id: 'tx_sep_didi1', amount: -45, category: '出行', merchant: '滴滴出行', channel: 'APP', occurredAt: thisMonth(n, 8, 22, 30).getTime() }),
  (n) => ({ id: 'tx_sep_didi2', amount: -32, category: '出行', merchant: '滴滴出行', channel: 'APP', occurredAt: thisMonth(n, 14, 18, 50).getTime() }),
  (n) => ({ id: 'tx_sep_metro', amount: -6, category: '出行', merchant: '地铁', channel: 'APP', occurredAt: thisMonth(n, 18, 7, 40).getTime() }),
  // 购物 984 (CARD)
  (n) => ({ id: 'tx_sep_uniqlo', amount: -399, category: '购物', merchant: '优衣库', channel: 'CARD', occurredAt: thisMonth(n, 6, 15, 0).getTime() }),
  (n) => ({ id: 'tx_sep_taobao', amount: -289, category: '购物', merchant: '淘宝', channel: 'CARD', occurredAt: thisMonth(n, 11, 21, 30).getTime() }),
  (n) => ({ id: 'tx_sep_jd', amount: -296, category: '购物', merchant: '京东', channel: 'CARD', occurredAt: thisMonth(n, 19, 20, 10).getTime() }),
  // 娱乐 2680 (CARD) — Test 11 threshold: 本月娱乐 > 2000
  (n) => ({ id: 'tx_sep_concert', amount: -1880, category: '娱乐', merchant: '演唱会门票', channel: 'CARD', occurredAt: thisMonth(n, 10, 20, 0).getTime() }),
  (n) => ({ id: 'tx_sep_ktv', amount: -480, category: '娱乐', merchant: 'KTV', channel: 'CARD', occurredAt: thisMonth(n, 13, 23, 0).getTime() }),
  (n) => ({ id: 'tx_sep_steam', amount: -200, category: '娱乐', merchant: 'Steam', channel: 'CARD', occurredAt: thisMonth(n, 16, 22, 0).getTime() }),
  (n) => ({ id: 'tx_sep_cinema', amount: -120, category: '娱乐', merchant: '影院电影票', channel: 'CARD', occurredAt: thisMonth(n, 22, 19, 30).getTime() }),
  // 居住 300 (APP)
  (n) => ({ id: 'tx_sep_utilities', amount: -180, category: '居住', merchant: '水电费', channel: 'APP', occurredAt: thisMonth(n, 1, 10, 0).getTime() }),
  (n) => ({ id: 'tx_sep_property', amount: -120, category: '居住', merchant: '物业费', channel: 'APP', occurredAt: thisMonth(n, 2, 10, 0).getTime() }),
  // 医疗 86 (CARD)
  (n) => ({ id: 'tx_sep_pharmacy', amount: -86, category: '医疗', merchant: '药店', channel: 'CARD', occurredAt: thisMonth(n, 9, 17, 20).getTime() }),
  // 订阅 114 (SUBSCRIPTION)
  (n) => ({ id: 'tx_sep_netflix', amount: -68, category: '订阅', merchant: 'Netflix', channel: 'SUBSCRIPTION', occurredAt: thisMonth(n, 15, 0, 0).getTime() }),
  (n) => ({ id: 'tx_sep_spotify', amount: -15, category: '订阅', merchant: 'Spotify', channel: 'SUBSCRIPTION', occurredAt: thisMonth(n, 15, 0, 0).getTime() }),
  (n) => ({ id: 'tx_sep_icloud', amount: -6, category: '订阅', merchant: 'iCloud', channel: 'SUBSCRIPTION', occurredAt: thisMonth(n, 21, 0, 0).getTime() }),
  (n) => ({ id: 'tx_sep_video', amount: -25, category: '订阅', merchant: '视频会员', channel: 'SUBSCRIPTION', occurredAt: thisMonth(n, 17, 0, 0).getTime() }),
  // 转账 500 (TRANSFER) — to contact 妈妈
  (n) => ({ id: 'tx_sep_transfer_mama', amount: -500, category: '转账', merchant: '转账给妈妈', channel: 'TRANSFER', counterpartyId: 'contact_mama', occurredAt: thisMonth(n, 4, 19, 0).getTime() }),
  // 其他 50 (APP)
  (n) => ({ id: 'tx_sep_phone', amount: -50, category: '其他', merchant: '话费充值', channel: 'APP', occurredAt: thisMonth(n, 7, 9, 30).getTime() }),
];

/** Previous-month (last month) expenses (~¥6,230) so month-over-month trends are sensible. */
const PREVIOUS_MONTH_SPEND: readonly ((now: Date) => SpendRow)[] = [
  (n) => ({ id: 'tx_aug_rent', amount: -2500, category: '居住', merchant: '房租', channel: 'TRANSFER', occurredAt: lastMonth(n, 1, 9, 0).getTime() }),
  (n) => ({ id: 'tx_aug_dining', amount: -1350, category: '餐饮', merchant: '餐饮支出', channel: 'CARD', occurredAt: lastMonth(n, 14, 19, 30).getTime() }),
  (n) => ({ id: 'tx_aug_travel', amount: -620, category: '出行', merchant: '出行支出', channel: 'APP', occurredAt: lastMonth(n, 20, 8, 45).getTime() }),
  (n) => ({ id: 'tx_aug_shopping', amount: -1080, category: '购物', merchant: '购物支出', channel: 'CARD', occurredAt: lastMonth(n, 22, 15, 10).getTime() }),
  (n) => ({ id: 'tx_aug_ent', amount: -680, category: '娱乐', merchant: '娱乐支出', channel: 'CARD', occurredAt: lastMonth(n, 25, 21, 0).getTime() }),
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

/** The four active subscriptions (nextChargeAt = the month after `now`). */
export function buildSubscriptions(now: Date = new Date(demoNow())): SubscriptionFixture[] {
  return [
    { id: 'sub_netflix', userId: DEMO_USER_ID, name: 'Netflix', amount: 68, cycle: 'MONTHLY', nextChargeAt: nextMonth(now, 15).getTime(), status: 'ACTIVE', remind: false },
    { id: 'sub_spotify', userId: DEMO_USER_ID, name: 'Spotify', amount: 15, cycle: 'MONTHLY', nextChargeAt: nextMonth(now, 15).getTime(), status: 'ACTIVE', remind: false },
    { id: 'sub_icloud', userId: DEMO_USER_ID, name: 'iCloud', amount: 6, cycle: 'MONTHLY', nextChargeAt: nextMonth(now, 21).getTime(), status: 'ACTIVE', remind: false },
    { id: 'sub_video', userId: DEMO_USER_ID, name: '视频会员', amount: 25, cycle: 'MONTHLY', nextChargeAt: nextMonth(now, 17).getTime(), status: 'ACTIVE', remind: false },
  ];
}

/** The single seeded investment holding (稳健理财A, bought last month). */
export function buildHoldings(now: Date = new Date(demoNow())): HoldingFixture[] {
  return [
    { id: 'holding_wenjiana', userId: DEMO_USER_ID, productId: 'prod_wenjiana', amount: 5000, marketValue: 5050, boughtAt: lastMonth(now, 10, 10, 0).getTime(), status: 'HOLDING' },
  ];
}

/** The single reserved budget (生日礼物, due next month). */
export function buildBudgets(now: Date = new Date(demoNow())): BudgetFixture[] {
  return [
    { id: 'budget_birthday', userId: DEMO_USER_ID, name: '生日礼物', amount: 2000, purpose: '生日计划', status: 'RESERVED', dueDate: nextMonth(now, 20).getTime() },
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
      payload: JSON.stringify({ amount: 2500, toName: '房东' }),
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
    data: ACCOUNTS.map((a) => ({ ...a, currency: 'CNY' })),
  });

  const contacts = options.withAmbiguousContact ? [...CONTACTS, AMBIGUOUS_CONTACT] : CONTACTS;
  await prisma.contact.createMany({
    data: contacts.map((c) => ({
      id: c.id,
      userId: DEMO_USER_ID,
      name: c.name,
      phone: c.phone,
      bank: c.bank,
      remark: c.remark ?? null,
    })),
  });

  await prisma.card.createMany({ data: [...CARDS] });
  await prisma.cardLimit.createMany({ data: [...CARD_LIMITS] });

  const transactions = [
    ...buildCurrentMonthSpend(now),
    ANOMALY_TRANSACTION,
    ...buildPreviousMonthSpend(now),
  ].map((t) => ({
    id: t.id,
    accountId: t.accountId,
    userId: t.userId,
    amount: t.amount,
    currency: 'CNY',
    direction: 'DEBIT' as const,
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
    data: buildSubscriptions(now).map((s) => ({ ...s, nextChargeAt: new Date(s.nextChargeAt) })),
  });
  await prisma.investmentProduct.createMany({ data: [...PRODUCTS] });

  await prisma.investmentHolding.createMany({
    data: buildHoldings(now).map((h) => ({ ...h, boughtAt: new Date(h.boughtAt) })),
  });

  await prisma.budget.createMany({
    data: buildBudgets(now).map((b) => ({ ...b, dueDate: new Date(b.dueDate) })),
  });

  await prisma.scheduledTask.createMany({
    data: buildScheduledTasks(now).map((s) => ({ ...s, runAt: new Date(s.runAt) })),
  });
}

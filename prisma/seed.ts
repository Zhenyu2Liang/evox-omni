/**
 * prisma/seed.ts — the demo database seed for the AI Banking Agent (SQLite sandbox).
 *
 * Anchors every row to the demo clock: DEMO_NOW = 2026-09-25 12:00 UTC+8. September 2026 is the
 * "current month"; April–September provide six months of spending/income/trend data.
 * The existing ¥5,800.00 September expenses and Apple Store anomaly are retained and augmented.
 * Dates are built with the UTC+8 banking business calendar and never depend on the host time zone.
 *
 * Booked money is persisted as BigInt minor units. Rates and unrounded valuations use exact
 * decimal text. Legacy integer fixture inputs are converted before monetary arithmetic.
 *
 * BALANCE RECONCILIATION: each account has an explicit OPENING balance, and the STORED balance is
 * `opening + Σ(that account's seeded transactions)`. Checking includes expenses (DEBIT) and
 * income/refunds (CREDIT); SAVINGS has no seeded transactions (opening == stored).
 * See the "Balance reconciliation model" block below and prisma/CONTEXT.md.
 *
 * IDEMPOTENT: the demo user + investment products are `upsert`ed by their stable id, and every
 * user-scoped child row is removed with a scoped `deleteMany({ where: { userId } })` before being
 * recreated. Re-running therefore yields the exact same data — no duplicates — and the deletes are
 * confined to the DEMO USER (no other user's rows or unrelated tables are ever touched).
 *
 * DEMO RESEED: this command replaces demo rows. Before writing it makes a BEST-EFFORT rolling backup of the
 * resolved SQLite file to `<dbFile>.backup.db` (same directory, overwritten each run). The backup
 * is never fatal — a missing/in-memory DB just logs a warning. Re-seed procedure:
 *   · `npm run db:seed`  → backup the current DB, then rebuild the demo dataset (this file).
 *   · `npm run db:reset` → `tsx scripts/db-push.ts --force-reset` (drop + recreate the schema)
 *                          followed by `tsx prisma/seed.ts` (backup + reseed).
 *   · Consistency is NEVER restored by wiping/re-seeding — a reset is a rebuild, not a repair.
 *
 * Run with: `npm run db:seed`  (== `tsx prisma/seed.ts`).
 */
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import nextEnv from '@next/env';
import { DEFAULT_DEMO_USER_ID } from '../lib/constants';
import { centsToMoney, assertMinorUnits } from '../lib/money';
import { businessDate } from '../lib/date';

// Resolve the same application configuration as deployment before Prisma loads default dotenv values.
nextEnv.loadEnvConfig(process.cwd(), false, { info: () => undefined,
  error: () => { throw new Error('Environment configuration could not be loaded.'); } });
const { prisma, resolveDatabaseUrl } = await import('../lib/db/client');

// ---------------------------------------------------------------------------
// Demo clock uses zero-based months in the banking business calendar.
// ---------------------------------------------------------------------------

const sep = (day: number, hour = 0, minute = 0): Date => businessDate(2026, 8, day, hour, minute);
const aug = (day: number, hour = 0, minute = 0): Date => businessDate(2026, 7, day, hour, minute);
const oct = (day: number, hour = 0, minute = 0): Date => businessDate(2026, 9, day, hour, minute);
const at = (month: number, day: number, hour = 0, minute = 0): Date => businessDate(2026, month - 1, day, hour, minute);

// ---------------------------------------------------------------------------
// Stable ids (the ids the app + E2E suite depend on).
// ---------------------------------------------------------------------------

const USER_ID = DEFAULT_DEMO_USER_ID; // 'user_liming'

const ACCT_CHECKING = 'acct_checking';
const ACCT_SAVINGS = 'acct_savings';
const CARD_CREDIT = 'card_credit';
const CARD_DEBIT = 'card_debit';
const CARD_VIRTUAL = 'card_virtual';

// ---------------------------------------------------------------------------
// Money fixture boundaries accept only exact integer cents; all arithmetic uses BigInt.
// ---------------------------------------------------------------------------

function minorUnits(cents: number | bigint): bigint {
  if (typeof cents === 'number' && !Number.isSafeInteger(cents)) throw new Error('Seed cents must be exact integers.');
  return assertMinorUnits(BigInt(cents));
}

/** Integer cents → a fixed two-decimal string (logging/assertions only). */
const fmt = (cents: bigint): string => centsToMoney(cents);

// ---------------------------------------------------------------------------
// Transactions (signed integer CENTS, expenses and income on the checking account).
// ---------------------------------------------------------------------------

interface SeedTransactionInput {
  id: string;
  /** Signed CNY in cents (negative = expense/outflow). */
  amountCents: number | bigint;
  category: string;
  merchant: string;
  channel: string;
  occurredAt: Date;
  counterpartyId?: string;
  isAnomaly?: boolean;
  anomalyReason?: string;
}

type SeedTransaction = Omit<SeedTransactionInput, 'amountCents'> & { amountCents: bigint };

/**
 * Original September 2026 ordinary expenses, before EVERY_MONTH_EXTRAS are added.
 * This base is ¥5,800.00 (580,000 cents), including 娱乐 ¥2,680.50. The expanded month totals
 * ¥6,937.05, including 娱乐 ¥2,843.99, preserving the "若本月娱乐 > 2000" condition.
 * The ¥6,999.00 anomaly is a SEPARATE row.
 * 美团外卖 + 星巴克 sit on 2026-09-25 so a "今日消费" window exists; the 妈妈 transfer is on
 * 2026-09-04 (NOT the demo day), so the demo-day (Sep 25) daily-transfer window stays ¥0.
 */
const SEPTEMBER_TRANSACTIONS: readonly SeedTransactionInput[] = [
  // 餐饮 = ¥446.90 (CARD)
  { id: 'tx_sep_haidilao', amountCents: -30_060, category: '餐饮', merchant: '海底捞', channel: 'CARD', occurredAt: sep(5, 19, 20) },
  { id: 'tx_sep_meituan', amountCents: -4_580, category: '餐饮', merchant: '美团外卖', channel: 'CARD', occurredAt: sep(25, 11, 40) },
  { id: 'tx_sep_starbucks', amountCents: -3_800, category: '餐饮', merchant: '星巴克', channel: 'CARD', occurredAt: sep(25, 9, 5) },
  { id: 'tx_sep_kfc', amountCents: -6_250, category: '餐饮', merchant: '肯德基', channel: 'CARD', occurredAt: sep(12, 12, 40) },
  // 出行 = ¥636.70 (APP)
  { id: 'tx_sep_rail', amountCents: -55_350, category: '出行', merchant: '高铁票', channel: 'APP', occurredAt: sep(3, 8, 15) },
  { id: 'tx_sep_didi1', amountCents: -4_520, category: '出行', merchant: '滴滴出行', channel: 'APP', occurredAt: sep(8, 22, 30) },
  { id: 'tx_sep_didi2', amountCents: -3_200, category: '出行', merchant: '滴滴出行', channel: 'APP', occurredAt: sep(14, 18, 50) },
  { id: 'tx_sep_metro', amountCents: -600, category: '出行', merchant: '地铁', channel: 'APP', occurredAt: sep(18, 7, 40) },
  // 购物 = ¥985.00 (CARD)
  { id: 'tx_sep_uniqlo', amountCents: -39_900, category: '购物', merchant: '优衣库', channel: 'CARD', occurredAt: sep(6, 15, 0) },
  { id: 'tx_sep_taobao', amountCents: -28_990, category: '购物', merchant: '淘宝', channel: 'CARD', occurredAt: sep(11, 21, 30) },
  { id: 'tx_sep_jd', amountCents: -29_610, category: '购物', merchant: '京东', channel: 'CARD', occurredAt: sep(19, 20, 10) },
  // 娱乐 = ¥2,680.50 (CARD) — condition threshold: 本月娱乐 > ¥2,000
  { id: 'tx_sep_concert', amountCents: -188_000, category: '娱乐', merchant: '演唱会门票', channel: 'CARD', occurredAt: sep(10, 20, 0) },
  { id: 'tx_sep_ktv', amountCents: -48_050, category: '娱乐', merchant: 'KTV', channel: 'CARD', occurredAt: sep(13, 23, 0) },
  { id: 'tx_sep_steam', amountCents: -20_000, category: '娱乐', merchant: 'Steam', channel: 'CARD', occurredAt: sep(16, 22, 0) },
  { id: 'tx_sep_cinema', amountCents: -12_000, category: '娱乐', merchant: '影院电影票', channel: 'CARD', occurredAt: sep(22, 19, 30) },
  // 居住 = ¥300.40 (APP)
  { id: 'tx_sep_utilities', amountCents: -18_040, category: '居住', merchant: '水电费', channel: 'APP', occurredAt: sep(1, 10, 0) },
  { id: 'tx_sep_property', amountCents: -12_000, category: '居住', merchant: '物业费', channel: 'APP', occurredAt: sep(2, 10, 0) },
  // 医疗 = ¥86.50 (CARD)
  { id: 'tx_sep_pharmacy', amountCents: -8_650, category: '医疗', merchant: '药店', channel: 'CARD', occurredAt: sep(9, 17, 20) },
  // 订阅 = ¥114.00 (SUBSCRIPTION) — mirrors the Subscription fees below
  { id: 'tx_sep_netflix', amountCents: -6_800, category: '订阅', merchant: 'Netflix', channel: 'SUBSCRIPTION', occurredAt: sep(15, 0, 0) },
  { id: 'tx_sep_spotify', amountCents: -1_500, category: '订阅', merchant: 'Spotify', channel: 'SUBSCRIPTION', occurredAt: sep(15, 0, 0) },
  { id: 'tx_sep_icloud', amountCents: -600, category: '订阅', merchant: 'iCloud', channel: 'SUBSCRIPTION', occurredAt: sep(21, 0, 0) },
  { id: 'tx_sep_video', amountCents: -2_500, category: '订阅', merchant: '视频会员', channel: 'SUBSCRIPTION', occurredAt: sep(17, 0, 0) },
  // 转账 = ¥500.00 (TRANSFER) — to contact 妈妈, dated 2026-09-04 (NOT the demo day)
  { id: 'tx_sep_transfer_mama', amountCents: -50_000, category: '转账', merchant: '转账给妈妈', channel: 'TRANSFER', counterpartyId: 'contact_mama', occurredAt: sep(4, 19, 0) },
  // 其他 = ¥50.00 (APP)
  { id: 'tx_sep_phone', amountCents: -5_000, category: '其他', merchant: '话费充值', channel: 'APP', occurredAt: sep(7, 9, 30) },
];

/** The Apple Store anomaly — MUST stay > ¥5,000 (id/date preserved): ¥6,999.00 @ 2026-09-20 18:32. */
const ANOMALY_TRANSACTION: SeedTransactionInput = {
  id: 'tx_anomaly_apple',
  amountCents: -699_900,
  category: '购物',
  merchant: 'Apple Store',
  channel: 'CARD',
  occurredAt: sep(20, 18, 32),
  isAnomaly: true,
  anomalyReason: '大额消费（>¥5,000）',
};

/** August 2026 (last month) — varied expenses = ¥6,243.30 so month-over-month trends are sensible. */
const AUGUST_TRANSACTIONS: readonly SeedTransactionInput[] = [
  { id: 'tx_aug_rent', amountCents: -250_000, category: '居住', merchant: '房租', channel: 'TRANSFER', occurredAt: aug(1, 9, 0) },
  { id: 'tx_aug_dining', amountCents: -135_260, category: '餐饮', merchant: '餐饮支出', channel: 'CARD', occurredAt: aug(14, 19, 30) },
  { id: 'tx_aug_travel', amountCents: -62_000, category: '出行', merchant: '出行支出', channel: 'APP', occurredAt: aug(20, 8, 45) },
  { id: 'tx_aug_shopping', amountCents: -108_750, category: '购物', merchant: '购物支出', channel: 'CARD', occurredAt: aug(22, 15, 10) },
  { id: 'tx_aug_ent', amountCents: -68_320, category: '娱乐', merchant: '娱乐支出', channel: 'CARD', occurredAt: aug(25, 21, 0) },
];

interface ExpenseTemplate {
  key: string;
  cents: number;
  category: string;
  merchant: string;
  channel: string;
  day: number;
  fixed?: boolean;
  counterpartyId?: string;
}

/** Daily purchases supplement every month; recurring fees stay consistent with subscriptions. */
const EVERY_MONTH_EXTRAS: readonly ExpenseTemplate[] = [
  { key: 'breakfast', cents: 1_280, category: '餐饮', merchant: '早餐铺', channel: 'CARD', day: 2 },
  { key: 'shaxian', cents: 2_860, category: '餐饮', merchant: '沙县小吃', channel: 'CARD', day: 6 },
  { key: 'luckin', cents: 1_990, category: '餐饮', merchant: '瑞幸咖啡', channel: 'APP', day: 12 },
  { key: 'fruit', cents: 4_235, category: '餐饮', merchant: '百果园', channel: 'CARD', day: 19 },
  { key: 'parking', cents: 1_850, category: '出行', merchant: '商场停车场', channel: 'APP', day: 3 },
  { key: 'bicycle', cents: 375, category: '出行', merchant: '共享单车', channel: 'APP', day: 8 },
  { key: 'fuel', cents: 27_736, category: '出行', merchant: '中国石化', channel: 'CARD', day: 17 },
  { key: 'bookstore', cents: 7_642, category: '购物', merchant: '新华书店', channel: 'CARD', day: 7 },
  { key: 'hema', cents: 12_867, category: '购物', merchant: '盒马鲜生', channel: 'APP', day: 21 },
  { key: 'weekend_movie', cents: 6_780, category: '娱乐', merchant: '万达影城', channel: 'APP', day: 15 },
  { key: 'gym_visit', cents: 8_990, category: '娱乐', merchant: '健身房单次体验', channel: 'CARD', day: 23 },
  { key: 'broadband', cents: 8_900, category: '居住', merchant: '宽带月费', channel: 'APP', day: 9, fixed: true },
  { key: 'clinic', cents: 3_550, category: '医疗', merchant: '社区卫生服务中心', channel: 'CARD', day: 14 },
  { key: 'courier', cents: 1_235, category: '其他', merchant: '顺丰快递', channel: 'APP', day: 24 },
  { key: 'fitness_member', cents: 18_850, category: '订阅', merchant: '健身会员', channel: 'SUBSCRIPTION', day: 18, fixed: true },
  { key: 'cloud_member', cents: 1_280, category: '订阅', merchant: '云盘会员', channel: 'SUBSCRIPTION', day: 23, fixed: true },
];

/** April–July history gives the six-month chart actual data rather than four empty months. */
const HISTORICAL_EXPENSES: readonly ExpenseTemplate[] = [
  { key: 'rent', cents: 280_000, category: '居住', merchant: '房租', channel: 'TRANSFER', day: 1, fixed: true, counterpartyId: 'contact_landlord' },
  { key: 'haidilao', cents: 28_860, category: '餐饮', merchant: '海底捞', channel: 'CARD', day: 5 },
  { key: 'meituan', cents: 3_590, category: '餐饮', merchant: '美团外卖', channel: 'APP', day: 11 },
  { key: 'starbucks', cents: 3_200, category: '餐饮', merchant: '星巴克', channel: 'CARD', day: 16 },
  { key: 'restaurant', cents: 12_875, category: '餐饮', merchant: '家常菜馆', channel: 'CARD', day: 22 },
  { key: 'rail', cents: 46_550, category: '出行', merchant: '高铁票', channel: 'APP', day: 4 },
  { key: 'didi', cents: 4_628, category: '出行', merchant: '滴滴出行', channel: 'APP', day: 13 },
  { key: 'metro', cents: 600, category: '出行', merchant: '地铁', channel: 'APP', day: 20, fixed: true },
  { key: 'uniqlo', cents: 39_990, category: '购物', merchant: '优衣库', channel: 'CARD', day: 6 },
  { key: 'jd', cents: 54_900, category: '购物', merchant: '京东', channel: 'APP', day: 10 },
  { key: 'taobao', cents: 23_865, category: '购物', merchant: '淘宝', channel: 'APP', day: 18 },
  { key: 'concert', cents: 128_000, category: '娱乐', merchant: '演唱会门票', channel: 'CARD', day: 8 },
  { key: 'steam', cents: 16_800, category: '娱乐', merchant: 'Steam', channel: 'CARD', day: 15 },
  { key: 'ktv', cents: 36_650, category: '娱乐', merchant: 'KTV', channel: 'CARD', day: 21 },
  { key: 'utilities', cents: 18_374, category: '居住', merchant: '水电费', channel: 'APP', day: 3 },
  { key: 'pharmacy', cents: 8_650, category: '医疗', merchant: '药店', channel: 'CARD', day: 12 },
  { key: 'netflix', cents: 6_800, category: '订阅', merchant: 'Netflix', channel: 'SUBSCRIPTION', day: 15, fixed: true },
  { key: 'spotify', cents: 1_500, category: '订阅', merchant: 'Spotify', channel: 'SUBSCRIPTION', day: 15, fixed: true },
  { key: 'icloud', cents: 600, category: '订阅', merchant: 'iCloud', channel: 'SUBSCRIPTION', day: 21, fixed: true },
  { key: 'video', cents: 2_500, category: '订阅', merchant: '视频会员', channel: 'SUBSCRIPTION', day: 17, fixed: true },
  { key: 'family', cents: 50_000, category: '转账', merchant: '转账给妈妈', channel: 'TRANSFER', day: 4, counterpartyId: 'contact_mama' },
  { key: 'phone', cents: 10_000, category: '其他', merchant: '话费充值', channel: 'APP', day: 7, fixed: true },
];

/** Deterministic cents variations model different baskets/fare totals; fixed bills are unchanged. */
function monthlyExpenses(month: number, templates: readonly ExpenseTemplate[]): SeedTransaction[] {
  return templates.map((t, index) => ({
    id: `tx_${month}_${t.key}`,
    amountCents: -(minorUnits(t.cents) + (t.fixed ? 0n : BigInt(month - 4) * 37n + BigInt(index) * 11n)),
    category: t.category,
    merchant: t.merchant,
    channel: t.channel,
    occurredAt: at(month, t.day, 10 + index % 10, index * 7 % 60),
    counterpartyId: t.counterpartyId,
  }));
}

const DEMO_MONTHS = [4, 5, 6, 7, 8, 9] as const;
const ADDITIONAL_TRANSACTIONS: readonly SeedTransaction[] = DEMO_MONTHS.flatMap((month) => [
  ...(month <= 7 ? monthlyExpenses(month, HISTORICAL_EXPENSES) : []),
  ...monthlyExpenses(month, EVERY_MONTH_EXTRAS),
  { id: `tx_${month}_salary`, amountCents: 1_087_636n + BigInt(month) * 2_345n, category: '工资', merchant: '公司工资入账', channel: 'TRANSFER', occurredAt: at(month, 10, 9, 0) },
  { id: `tx_${month}_bonus`, amountCents: 38_650n + BigInt(month) * 557n, category: '其他收入', merchant: '项目奖金', channel: 'TRANSFER', occurredAt: at(month, 20, 15, 30) },
  { id: `tx_${month}_refund`, amountCents: 10_850n + BigInt(month) * 137n, category: '退款', merchant: '淘宝退款', channel: 'APP', occurredAt: at(month, 22, 16, 15) },
]);

// ---------------------------------------------------------------------------
// Balance reconciliation model.
//
//   STORED balance = OPENING balance + Σ(that account's seeded transactions)
//
// Income and expense rows are on CHECKING; SAVINGS has none. Choose an opening balance for
// the expanded six-month ledger while retaining the demo's ¥23,580.00 checking balance.
// ---------------------------------------------------------------------------

const OPENING_SAVINGS_CENTS = 5_000_000n;

/** Every seeded ledger row, in insertion order (checking account only). */
const CHECKING_TRANSACTIONS: readonly SeedTransaction[] = [
  ...SEPTEMBER_TRANSACTIONS,
  ANOMALY_TRANSACTION,
  ...AUGUST_TRANSACTIONS,
  ...ADDITIONAL_TRANSACTIONS,
].map(row => ({ ...row, amountCents: minorUnits(row.amountCents) }));

/** Net ledger effect includes signed expenses, salaries, bonuses and refunds. */
const CHECKING_LEDGER_CENTS = CHECKING_TRANSACTIONS.reduce((sum, t) => sum + t.amountCents, 0n);
const OPENING_CHECKING_CENTS = 2_358_000n - CHECKING_LEDGER_CENTS;
const CHECKING_BALANCE_CENTS = OPENING_CHECKING_CENTS + CHECKING_LEDGER_CENTS; // 2,358,000 = ¥23,580.00
const SAVINGS_BALANCE_CENTS = OPENING_SAVINGS_CENTS; // no savings transactions → opening == stored

// Fail loud if a future edit drifts the reconciled balance out of the ¥23,5xx demo band.
if (CHECKING_BALANCE_CENTS !== 2_358_000n) {
  throw new Error(
    `[seed] reconciled checking balance ¥${fmt(CHECKING_BALANCE_CENTS)} left the ¥23,5xx demo band ` +
      `(opening ¥${fmt(OPENING_CHECKING_CENTS)} + ledger ¥${fmt(CHECKING_LEDGER_CENTS)})`,
  );
}

const demoCutoff = sep(25, 12).getTime();
if (OPENING_CHECKING_CENTS < 0n || new Set(CHECKING_TRANSACTIONS.map((t) => t.id)).size !== CHECKING_TRANSACTIONS.length ||
    CHECKING_TRANSACTIONS.some((t) => t.amountCents === 0n || t.occurredAt.getTime() > demoCutoff)) {
  throw new Error('[seed] invalid opening balance, duplicate transaction id, non-cent amount or future transaction');
}

// ---------------------------------------------------------------------------
// Seed data.
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  { id: ACCT_CHECKING, userId: USER_ID, type: 'CHECKING', name: '活期账户', number: '****8821', balanceMinor: CHECKING_BALANCE_CENTS, currency: 'CNY' },
  { id: ACCT_SAVINGS, userId: USER_ID, type: 'SAVINGS', name: '储蓄账户', number: '****3309', balanceMinor: SAVINGS_BALANCE_CENTS, currency: 'CNY' },
];

const CARDS = [
  {
    id: CARD_CREDIT,
    userId: USER_ID,
    type: 'CREDIT',
    network: 'UnionPay',
    numberMasked: '****6688',
    status: 'ACTIVE',
    creditLimitMinor: 1_800_000n,
    availableLimitMinor: 1_800_000n,
    monthlyLimitMinor: 1_800_000n,
  },
  {
    id: CARD_DEBIT,
    userId: USER_ID,
    type: 'DEBIT',
    network: 'UnionPay',
    numberMasked: '****8821',
    status: 'ACTIVE',
    creditLimitMinor: null,
    availableLimitMinor: null,
    monthlyLimitMinor: null,
  },
  {
    id: CARD_VIRTUAL,
    userId: USER_ID,
    type: 'VIRTUAL',
    network: 'UnionPay',
    numberMasked: '****7788',
    status: 'ACTIVE',
    creditLimitMinor: null,
    availableLimitMinor: null,
    monthlyLimitMinor: 500_000n,
    linkedAccountId: ACCT_CHECKING,
  },
];

const CARD_LIMITS = [
  { id: 'limit_credit_ent', cardId: CARD_CREDIT, category: '娱乐', amountMinor: 300_000n },
  { id: 'limit_credit_dining', cardId: CARD_CREDIT, category: '餐饮', amountMinor: 200_050n },
  { id: 'limit_credit_travel', cardId: CARD_CREDIT, category: '出行', amountMinor: 120_075n },
  { id: 'limit_credit_shopping', cardId: CARD_CREDIT, category: '购物', amountMinor: 450_080n },
];

const CONTACTS = [
  { id: 'contact_zhangwei', userId: USER_ID, name: '张伟', phone: '139****0002', bank: '招商银行', remark: null },
  { id: 'contact_wangfang', userId: USER_ID, name: '王芳', phone: '137****0003', bank: '工商银行', remark: null },
  { id: 'contact_mama', userId: USER_ID, name: '妈妈', phone: '136****0004', bank: '建设银行', remark: '家人' },
  { id: 'contact_lihua', userId: USER_ID, name: '李华', phone: '135****0005', bank: '农业银行', remark: null },
  { id: 'contact_landlord', userId: USER_ID, name: '房东', phone: '134****0006', bank: '建设银行', remark: '每月房租' },
  { id: 'contact_chenchen', userId: USER_ID, name: '陈晨', phone: '133****0007', bank: '招商银行', remark: '同事，聚餐AA' },
  { id: 'contact_wangqiang', userId: USER_ID, name: '王强', phone: '132****0008', bank: '工商银行', remark: '朋友' },
  { id: 'contact_partner', userId: USER_ID, name: '爱人', phone: '131****0009', bank: '中国银行', remark: '生日10月20日' },
];

/** Monthly subscription fees (cents) — mirror the seeded 订阅 ledger rows; charged again in October. */
const SUBSCRIPTIONS = [
  { id: 'sub_netflix', userId: USER_ID, name: 'Netflix', amountMinor: 6_800n, cycle: 'MONTHLY', nextChargeAt: oct(15), status: 'ACTIVE', remind: false },
  { id: 'sub_spotify', userId: USER_ID, name: 'Spotify', amountMinor: 1_500n, cycle: 'MONTHLY', nextChargeAt: oct(15), status: 'ACTIVE', remind: false },
  { id: 'sub_icloud', userId: USER_ID, name: 'iCloud', amountMinor: 600n, cycle: 'MONTHLY', nextChargeAt: oct(21), status: 'ACTIVE', remind: false },
  { id: 'sub_video', userId: USER_ID, name: '视频会员', amountMinor: 2_500n, cycle: 'MONTHLY', nextChargeAt: oct(17), status: 'ACTIVE', remind: false },
  { id: 'sub_fitness', userId: USER_ID, name: '健身会员', amountMinor: 18_850n, cycle: 'MONTHLY', nextChargeAt: oct(18), status: 'ACTIVE', remind: true },
  { id: 'sub_cloud', userId: USER_ID, name: '云盘会员', amountMinor: 1_280n, cycle: 'MONTHLY', nextChargeAt: oct(23), status: 'ACTIVE', remind: true },
];

const PRODUCTS = [
  { id: 'prod_wenjiana', code: 'WJA001', name: '稳健理财A', riskLevel: 'R2', annualYieldRate: '0.0325', termDays: 90, minAmountMinor: 100_000n, description: '低风险稳健型' },
  { id: 'prod_wenjib', code: 'WJB002', name: '稳健理财B', riskLevel: 'R2', annualYieldRate: '0.036', termDays: 180, minAmountMinor: 500_000n, description: '低风险稳健型' },
  { id: 'prod_jinrong', code: 'JR003', name: '进取混合C', riskLevel: 'R3', annualYieldRate: '0.051', termDays: 365, minAmountMinor: 1_000_000n, description: '中风险混合型' },
  { id: 'prod_huobi', code: 'MMF001', name: '货币基金', riskLevel: 'R1', annualYieldRate: '0.021', termDays: 30, minAmountMinor: 10_000n, description: '现金管理型' },
];

/** Holding: ¥5,000.00 principal at ¥5,178.36 market value → ¥178.36 unrealised profit (> 0). */
const HOLDINGS = [
  { id: 'holding_wenjiana', userId: USER_ID, productId: 'prod_wenjiana', principalAmountMinor: 500_000n, estimatedMarketValue: '5178.36', boughtAt: aug(10, 10, 0), status: 'HOLDING' },
  { id: 'holding_huobi', userId: USER_ID, productId: 'prod_huobi', principalAmountMinor: 800_050n, estimatedMarketValue: '8032.76', boughtAt: aug(18, 10, 30), status: 'HOLDING' },
  { id: 'holding_wenjib', userId: USER_ID, productId: 'prod_wenjib', principalAmountMinor: 1_000_000n, estimatedMarketValue: '10128.95', boughtAt: aug(2, 14, 0), status: 'HOLDING' },
];

const BUDGETS = [
  { id: 'budget_birthday', userId: USER_ID, name: '生日礼物', amountMinor: 200_000n, purpose: '生日计划', status: 'RESERVED', dueDate: oct(20) },
  { id: 'budget_travel', userId: USER_ID, name: '周末旅行', amountMinor: 150_075n, purpose: '旅行计划', status: 'RESERVED', dueDate: oct(10) },
  { id: 'budget_study', userId: USER_ID, name: '学习课程', amountMinor: 88_888n, purpose: '学习计划', status: 'RESERVED', dueDate: oct(15) },
];

const SCHEDULED_TASKS = [
  {
    id: 'task_birthday_reminder',
    userId: USER_ID,
    name: '生日提醒',
    kind: 'REMINDER',
    payload: JSON.stringify({ note: '妈妈生日，记得准备礼物' }),
    runAt: oct(18, 9, 0),
    status: 'SCHEDULED',
    requiresConfirmation: true,
  },
  {
    id: 'task_rent_transfer',
    userId: USER_ID,
    name: '房租自动转账',
    kind: 'TRANSFER',
    payload: JSON.stringify({ amount: centsToMoney(250_000n), contactId: 'contact_landlord' }),
    runAt: oct(1, 9, 0),
    status: 'SCHEDULED',
    requiresConfirmation: true,
  },
];

// ---------------------------------------------------------------------------
// Pre-seed backup (BEST-EFFORT, never fatal).
// ---------------------------------------------------------------------------

/**
 * Copy the resolved SQLite file to `<dbFile>.backup.db` (same directory, overwritten each run) so
 * a re-seed is non-destructive. Skips (silently) when the DB is in-memory / the path is empty /
 * the file does not exist yet; any failure only logs a warning — it must never abort the seed.
 *
 * Relative SQLite paths (e.g. an explicit `file:./dev.db`) are resolved against the `prisma/`
 * directory, mirroring Prisma's own schema-relative resolution.
 */
function backupDatabase(): void {
  try {
    const raw = resolveDatabaseUrl();
    let filePart = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
    const queryIndex = filePart.indexOf('?');
    if (queryIndex !== -1) filePart = filePart.slice(0, queryIndex);
    if (filePart === '' || filePart === ':memory:' || filePart.startsWith(':memory:')) return;

    const dbFile = path.isAbsolute(filePart)
      ? filePart
      : path.resolve(process.cwd(), 'prisma', filePart);
    if (!existsSync(dbFile)) return;

    const backupFile = `${dbFile}.backup.db`;
    copyFileSync(dbFile, backupFile);
    console.log(`Pre-seed backup written: ${backupFile}`);
  } catch (error) {
    console.warn('[seed] pre-seed database backup skipped (non-fatal):', error);
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Rebuild a table's rows for the demo user: scoped delete, then recreate. */
async function resetSeededTables(): Promise<void> {
  const cardIds = (await prisma.card.findMany({ where: { userId: USER_ID }, select: { id: true } })).map((c) => c.id);

  // Respect FK order: children before parents. Every delete is scoped to the DEMO USER (or to the
  // stable product ids we own), so no other user's rows or unrelated tables are touched.
  await prisma.cardLimit.deleteMany({ where: { cardId: { in: cardIds } } });
  await prisma.transaction.deleteMany({ where: { userId: USER_ID } });
  await prisma.investmentHolding.deleteMany({ where: { userId: USER_ID } });
  await prisma.subscription.deleteMany({ where: { userId: USER_ID } });
  await prisma.budget.deleteMany({ where: { userId: USER_ID } });
  await prisma.scheduledTask.deleteMany({ where: { userId: USER_ID } });
  await prisma.card.deleteMany({ where: { userId: USER_ID } });
  await prisma.account.deleteMany({ where: { userId: USER_ID } });
  await prisma.contact.deleteMany({ where: { userId: USER_ID } });
  // Products are global (no userId) but have stable ids — clear only the ones we own.
  await prisma.investmentProduct.deleteMany({ where: { id: { in: PRODUCTS.map((p) => p.id) } } });
}

async function seed(): Promise<void> {
  // 0. Best-effort rolling backup of the current SQLite file (never fatal).
  backupDatabase();

  // 1. Demo user — upsert by stable id so re-runs never duplicate.
  await prisma.user.upsert({
    where: { id: USER_ID },
    update: { name: '李明', phone: '138****0001', avatarEmoji: '🧑' },
    create: { id: USER_ID, name: '李明', phone: '138****0001', avatarEmoji: '🧑' },
  });

  // 2. Clear the demo user's seeded rows (idempotency), then recreate with explicit ids.
  await resetSeededTables();

  // 3. Recreate in FK-safe order: parents before children.
  await prisma.account.createMany({ data: ACCOUNTS });
  await prisma.contact.createMany({ data: CONTACTS });
  await prisma.card.createMany({ data: CARDS });
  await prisma.cardLimit.createMany({ data: CARD_LIMITS });

  const transactions = CHECKING_TRANSACTIONS.map((t) => ({
    id: t.id,
    accountId: ACCT_CHECKING,
    userId: USER_ID,
    amountMinor: t.amountCents,
    currency: 'CNY',
    direction: t.amountCents < 0n ? 'DEBIT' : 'CREDIT',
    category: t.category,
    merchant: t.merchant,
    channel: t.channel,
    counterpartyId: t.counterpartyId ?? null,
    occurredAt: t.occurredAt,
    isAnomaly: t.isAnomaly ?? false,
    anomalyReason: t.anomalyReason ?? null,
  }));
  await prisma.transaction.createMany({ data: transactions });

  await prisma.subscription.createMany({ data: SUBSCRIPTIONS });
  await prisma.investmentProduct.createMany({ data: PRODUCTS });
  await prisma.investmentHolding.createMany({ data: HOLDINGS });
  await prisma.budget.createMany({ data: BUDGETS });
  await prisma.scheduledTask.createMany({ data: SCHEDULED_TASKS });
}

/** Print a concise per-table row-count summary. */
async function printSummary(): Promise<void> {
  console.log('');
  console.log('Balance reconciliation (stored = opening + Σ transactions):');
  console.log(`  checking  opening ¥${fmt(OPENING_CHECKING_CENTS)}  + ledger ${fmt(CHECKING_LEDGER_CENTS)}  = ¥${fmt(CHECKING_BALANCE_CENTS)}`);
  console.log(`  savings   opening ¥${fmt(OPENING_SAVINGS_CENTS)}  + ledger ${fmt(0n)}  = ¥${fmt(SAVINGS_BALANCE_CENTS)}`);

  const counts = {
    User: await prisma.user.count(),
    Account: await prisma.account.count(),
    Transaction: await prisma.transaction.count(),
    Contact: await prisma.contact.count(),
    Card: await prisma.card.count(),
    CardLimit: await prisma.cardLimit.count(),
    Subscription: await prisma.subscription.count(),
    InvestmentProduct: await prisma.investmentProduct.count(),
    InvestmentHolding: await prisma.investmentHolding.count(),
    Budget: await prisma.budget.count(),
    ScheduledTask: await prisma.scheduledTask.count(),
    AuditLog: await prisma.auditLog.count(),
    SecurityEvent: await prisma.securityEvent.count(),
    AgentSession: await prisma.agentSession.count(),
    AgentTask: await prisma.agentTask.count(),
    AgentTaskNode: await prisma.agentTaskNode.count(),
    PendingAction: await prisma.pendingAction.count(),
    MfaChallenge: await prisma.mfaChallenge.count(),
  };
  console.log('');
  console.log('Seed complete. Row counts per table:');
  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(20)} ${count}`);
  }
}

async function main(): Promise<void> {
  await seed();
  await printSummary();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error('Seed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });

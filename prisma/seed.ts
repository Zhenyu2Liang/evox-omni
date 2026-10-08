/**
 * prisma/seed.ts — the demo database seed for the AI Banking Agent (SQLite sandbox).
 *
 * Anchors every row to the demo clock: DEMO_NOW = 2026-09-25 12:00 local. September 2026 is the
 * "current month" (¥5,800.00 ordinary spend incl. ¥2,680.50 娱乐 + the Apple Store ¥6,999.00
 * anomaly), August 2026 is "last month" (for 环比/trend). Dates are built from LOCAL components
 * only — we deliberately do NOT import `../lib/date` and never call `Date.now()`.
 *
 * MONEY IS CENT-EXACT: every amount is written as an integer number of CENTS (分) through the
 * local `yuan()` helper, so each stored value is a realistic two-decimal CNY `number` (Float
 * column) with no float artifacts, and every total (the balance reconciliation below) is exact.
 *
 * BALANCE RECONCILIATION: each account has an explicit OPENING balance, and the STORED balance is
 * `opening + Σ(that account's seeded transactions)`. All seeded transactions are DEBIT (negative)
 * and attached to the CHECKING account; SAVINGS has no seeded transactions (opening == stored).
 * See the "Balance reconciliation model" block below and prisma/CONTEXT.md.
 *
 * IDEMPOTENT: the demo user + investment products are `upsert`ed by their stable id, and every
 * user-scoped child row is removed with a scoped `deleteMany({ where: { userId } })` before being
 * recreated. Re-running therefore yields the exact same data — no duplicates — and the deletes are
 * confined to the DEMO USER (no other user's rows or unrelated tables are ever touched).
 *
 * NON-DESTRUCTIVE: before writing anything the seed makes a BEST-EFFORT rolling backup of the
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
import { DEFAULT_DEMO_USER_ID } from '../lib/constants';
import { prisma, resolveDatabaseUrl } from '../lib/db/client';

// ---------------------------------------------------------------------------
// Demo clock — LOCAL-component date helpers (see root CONTEXT.md "Demo Clock").
// `month` is 0-based in `new Date(...)`, so 8 = September, 7 = August, 9 = October 2026.
// ---------------------------------------------------------------------------

const sep = (day: number, hour = 0, minute = 0): Date => new Date(2026, 8, day, hour, minute);
const aug = (day: number, hour = 0, minute = 0): Date => new Date(2026, 7, day, hour, minute);
const oct = (day: number, hour = 0, minute = 0): Date => new Date(2026, 9, day, hour, minute);

// ---------------------------------------------------------------------------
// Stable ids (the ids the app + E2E suite depend on).
// ---------------------------------------------------------------------------

const USER_ID = DEFAULT_DEMO_USER_ID; // 'user_liming'

const ACCT_CHECKING = 'acct_checking';
const ACCT_SAVINGS = 'acct_savings';
const CARD_CREDIT = 'card_credit';
const CARD_DEBIT = 'card_debit';

// ---------------------------------------------------------------------------
// Money — every amount is an integer number of CENTS (分). `yuan()` turns cents into a
// two-decimal CNY `number`; all reconciliation arithmetic is done in cents so it is exact.
// ---------------------------------------------------------------------------

/** Integer cents → CNY `number` (two decimals). */
const yuan = (cents: number): number => cents / 100;

/** Integer cents → a fixed two-decimal string (logging/assertions only). */
const fmt = (cents: number): string => (cents / 100).toFixed(2);

// ---------------------------------------------------------------------------
// Transactions (amounts are integer CENTS; all are DEBIT/negative on the checking account).
// ---------------------------------------------------------------------------

interface SeedTransaction {
  id: string;
  /** Signed CNY in cents (negative = expense/outflow). */
  amountCents: number;
  category: string;
  merchant: string;
  channel: string;
  occurredAt: Date;
  counterpartyId?: string;
  isAnomaly?: boolean;
  anomalyReason?: string;
}

/**
 * September 2026 ordinary expenses on the checking account.
 * Sum of magnitudes = EXACTLY ¥5,800.00 (580,000 cents) with 娱乐 = ¥2,680.50 — this drives the
 * spending analysis and the "若本月娱乐 > 2000" condition. The ¥6,999.00 anomaly is a SEPARATE row.
 * 美团外卖 + 星巴克 sit on 2026-09-25 so a "今日消费" window exists; the 妈妈 transfer is on
 * 2026-09-04 (NOT the demo day), so the demo-day (Sep 25) daily-transfer window stays ¥0.
 */
const SEPTEMBER_TRANSACTIONS: readonly SeedTransaction[] = [
  // 餐饮 = ¥446.90 (CARD)
  { id: 'tx_sep_haidilao', amountCents: -30_060, category: '餐饮', merchant: '海底捞', channel: 'CARD', occurredAt: sep(5, 19, 20) },
  { id: 'tx_sep_meituan', amountCents: -4_580, category: '餐饮', merchant: '美团外卖', channel: 'CARD', occurredAt: sep(25, 12, 10) },
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
const ANOMALY_TRANSACTION: SeedTransaction = {
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
const AUGUST_TRANSACTIONS: readonly SeedTransaction[] = [
  { id: 'tx_aug_rent', amountCents: -250_000, category: '居住', merchant: '房租', channel: 'TRANSFER', occurredAt: aug(1, 9, 0) },
  { id: 'tx_aug_dining', amountCents: -135_260, category: '餐饮', merchant: '餐饮支出', channel: 'CARD', occurredAt: aug(14, 19, 30) },
  { id: 'tx_aug_travel', amountCents: -62_000, category: '出行', merchant: '出行支出', channel: 'APP', occurredAt: aug(20, 8, 45) },
  { id: 'tx_aug_shopping', amountCents: -108_750, category: '购物', merchant: '购物支出', channel: 'CARD', occurredAt: aug(22, 15, 10) },
  { id: 'tx_aug_ent', amountCents: -68_320, category: '娱乐', merchant: '娱乐支出', channel: 'CARD', occurredAt: aug(25, 21, 0) },
];

// ---------------------------------------------------------------------------
// Balance reconciliation model.
//
//   STORED balance = OPENING balance + Σ(that account's seeded transactions)
//
// All seeded transactions are DEBIT (negative) on CHECKING; SAVINGS has none, so its opening
// equals its stored balance. The checking OPENING is picked so the reconciled STORED balance
// lands exactly on ¥23,580.00 (the demo narrative figure, root CONTEXT "活期 ¥23,580").
// ---------------------------------------------------------------------------

const OPENING_CHECKING_CENTS = 4_262_230; // ¥42,622.30 — pre-ledger opening balance
const OPENING_SAVINGS_CENTS = 5_000_000; // ¥50,000.00 — savings has no seeded transactions

/** Every seeded ledger row, in insertion order (checking account only). */
const CHECKING_TRANSACTIONS: readonly SeedTransaction[] = [
  ...SEPTEMBER_TRANSACTIONS,
  ANOMALY_TRANSACTION,
  ...AUGUST_TRANSACTIONS,
];

/** Net ledger effect on checking (negative: all rows are DEBIT expenses). */
const CHECKING_SPEND_CENTS = CHECKING_TRANSACTIONS.reduce((sum, t) => sum + t.amountCents, 0);
const CHECKING_BALANCE_CENTS = OPENING_CHECKING_CENTS + CHECKING_SPEND_CENTS; // 2,358,000 = ¥23,580.00
const SAVINGS_BALANCE_CENTS = OPENING_SAVINGS_CENTS; // no savings transactions → opening == stored

// Fail loud if a future edit drifts the reconciled balance out of the ¥23,5xx demo band.
if (Math.floor(CHECKING_BALANCE_CENTS / 100) !== 23_580) {
  throw new Error(
    `[seed] reconciled checking balance ¥${fmt(CHECKING_BALANCE_CENTS)} left the ¥23,5xx demo band ` +
      `(opening ¥${fmt(OPENING_CHECKING_CENTS)} + ledger ¥${fmt(CHECKING_SPEND_CENTS)})`,
  );
}

// ---------------------------------------------------------------------------
// Seed data.
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  { id: ACCT_CHECKING, userId: USER_ID, type: 'CHECKING', name: '活期账户', number: '****8821', balance: yuan(CHECKING_BALANCE_CENTS), currency: 'CNY' },
  { id: ACCT_SAVINGS, userId: USER_ID, type: 'SAVINGS', name: '储蓄账户', number: '****3309', balance: yuan(SAVINGS_BALANCE_CENTS), currency: 'CNY' },
];

const CARDS = [
  {
    id: CARD_CREDIT,
    userId: USER_ID,
    type: 'CREDIT',
    network: 'UnionPay',
    numberMasked: '****6688',
    status: 'ACTIVE',
    creditLimit: yuan(1_800_000), // ¥18,000.00
    availableLimit: yuan(1_800_000),
    monthlyLimit: yuan(1_800_000),
  },
  {
    id: CARD_DEBIT,
    userId: USER_ID,
    type: 'DEBIT',
    network: 'UnionPay',
    numberMasked: '****8821',
    status: 'ACTIVE',
    creditLimit: null,
    availableLimit: null,
    monthlyLimit: null,
  },
];

const CARD_LIMITS = [
  { id: 'limit_credit_ent', cardId: CARD_CREDIT, category: '娱乐', amount: yuan(300_000) }, // ¥3,000.00
];

const CONTACTS = [
  { id: 'contact_zhangwei', userId: USER_ID, name: '张伟', phone: '139****0002', bank: '招商银行', remark: null },
  { id: 'contact_wangfang', userId: USER_ID, name: '王芳', phone: '137****0003', bank: '工商银行', remark: null },
  { id: 'contact_mama', userId: USER_ID, name: '妈妈', phone: '136****0004', bank: '建设银行', remark: '家人' },
  { id: 'contact_lihua', userId: USER_ID, name: '李华', phone: '135****0005', bank: '农业银行', remark: null },
];

/** Monthly subscription fees (cents) — mirror the seeded 订阅 ledger rows; charged again in October. */
const SUBSCRIPTIONS = [
  { id: 'sub_netflix', userId: USER_ID, name: 'Netflix', amount: yuan(6_800), cycle: 'MONTHLY', nextChargeAt: oct(15), status: 'ACTIVE', remind: false },
  { id: 'sub_spotify', userId: USER_ID, name: 'Spotify', amount: yuan(1_500), cycle: 'MONTHLY', nextChargeAt: oct(15), status: 'ACTIVE', remind: false },
  { id: 'sub_icloud', userId: USER_ID, name: 'iCloud', amount: yuan(600), cycle: 'MONTHLY', nextChargeAt: oct(21), status: 'ACTIVE', remind: false },
  { id: 'sub_video', userId: USER_ID, name: '视频会员', amount: yuan(2_500), cycle: 'MONTHLY', nextChargeAt: oct(17), status: 'ACTIVE', remind: false },
];

const PRODUCTS = [
  { id: 'prod_wenjiana', code: 'WJA001', name: '稳健理财A', riskLevel: 'R2', expectedRate: 3.25, termDays: 90, minAmount: yuan(100_000), description: '低风险稳健型' },
  { id: 'prod_wenjib', code: 'WJB002', name: '稳健理财B', riskLevel: 'R2', expectedRate: 3.6, termDays: 180, minAmount: yuan(500_000), description: '低风险稳健型' },
  { id: 'prod_jinrong', code: 'JR003', name: '进取混合C', riskLevel: 'R3', expectedRate: 5.1, termDays: 365, minAmount: yuan(1_000_000), description: '中风险混合型' },
  { id: 'prod_huobi', code: 'MMF001', name: '货币基金', riskLevel: 'R1', expectedRate: 2.1, termDays: 30, minAmount: yuan(10_000), description: '现金管理型' },
];

/** Holding: ¥5,000.00 principal at ¥5,178.36 market value → ¥178.36 unrealised profit (> 0). */
const HOLDINGS = [
  { id: 'holding_wenjiana', userId: USER_ID, productId: 'prod_wenjiana', amount: yuan(500_000), marketValue: yuan(517_836), boughtAt: aug(10, 10, 0), status: 'HOLDING' },
];

const BUDGETS = [
  { id: 'budget_birthday', userId: USER_ID, name: '生日礼物', amount: yuan(200_000), purpose: '生日计划', status: 'RESERVED', dueDate: oct(20) },
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
    payload: JSON.stringify({ amount: yuan(250_000), toName: '房东' }),
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
    amount: yuan(t.amountCents),
    currency: 'CNY',
    direction: 'DEBIT' as const,
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
  console.log(`  checking  opening ¥${fmt(OPENING_CHECKING_CENTS)}  + ledger ${fmt(CHECKING_SPEND_CENTS)}  = ¥${fmt(CHECKING_BALANCE_CENTS)}`);
  console.log(`  savings   opening ¥${fmt(OPENING_SAVINGS_CENTS)}  + ledger ${fmt(0)}  = ¥${fmt(SAVINGS_BALANCE_CENTS)}`);

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

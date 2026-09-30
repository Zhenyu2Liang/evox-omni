/**
 * prisma/seed.ts — the demo database seed for the AI Banking Agent (SQLite sandbox).
 *
 * Anchors every row to the demo clock: DEMO_NOW = 2026-09-25 12:00 local. September 2026 is the
 * "current month" (~¥5,800 ordinary spend incl. ¥2,680 娱乐 + the Apple Store ¥6,999 anomaly),
 * August 2026 is "last month" (for 环比/trend). Dates are built from LOCAL components only — we
 * deliberately do NOT import `../lib/date` (unimplemented) and never call `Date.now()`.
 *
 * IDEMPOTENT: the demo user + investment products are `upsert`ed by their stable id, and every
 * user-scoped child row is removed with a scoped `deleteMany({ where: { userId } })` before being
 * recreated. Re-running `npm run db:seed` therefore yields the exact same data — no duplicates.
 *
 * Run with: `npm run db:seed`  (== `tsx prisma/seed.ts`).
 */
import { DEFAULT_DEMO_USER_ID } from '../lib/constants';
import { prisma } from '../lib/db/client';

// ---------------------------------------------------------------------------
// Demo clock — LOCAL-component date helpers (see root CONTEXT.md "Demo Clock").
// `month` is 0-based in `new Date(...)`, so 8 = September, 7 = August, 9 = October 2026.
// ---------------------------------------------------------------------------

const sep = (day: number, hour = 0, minute = 0): Date => new Date(2026, 8, day, hour, minute);
const aug = (day: number, hour = 0, minute = 0): Date => new Date(2026, 7, day, hour, minute);
const oct = (day: number, hour = 0, minute = 0): Date => new Date(2026, 9, day, hour, minute);

// ---------------------------------------------------------------------------
// Stable ids (must match `tests/helpers/fixtures.ts` and the acceptance bar).
// ---------------------------------------------------------------------------

const USER_ID = DEFAULT_DEMO_USER_ID; // 'user_liming'

const ACCT_CHECKING = 'acct_checking';
const ACCT_SAVINGS = 'acct_savings';
const CARD_CREDIT = 'card_credit';
const CARD_DEBIT = 'card_debit';

// ---------------------------------------------------------------------------
// Seed data (frozen demo values).
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  { id: ACCT_CHECKING, userId: USER_ID, type: 'CHECKING', name: '活期账户', number: '****8821', balance: 23580, currency: 'CNY' },
  { id: ACCT_SAVINGS, userId: USER_ID, type: 'SAVINGS', name: '储蓄账户', number: '****3309', balance: 50000, currency: 'CNY' },
];

const CARDS = [
  {
    id: CARD_CREDIT,
    userId: USER_ID,
    type: 'CREDIT',
    network: 'UnionPay',
    numberMasked: '****6688',
    status: 'ACTIVE',
    creditLimit: 18000,
    availableLimit: 18000,
    monthlyLimit: 18000,
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
  { id: 'limit_credit_ent', cardId: CARD_CREDIT, category: '娱乐', amount: 3000 },
];

const CONTACTS = [
  { id: 'contact_zhangwei', userId: USER_ID, name: '张伟', phone: '139****0002', bank: '招商银行', remark: null },
  { id: 'contact_wangfang', userId: USER_ID, name: '王芳', phone: '137****0003', bank: '工商银行', remark: null },
  { id: 'contact_mama', userId: USER_ID, name: '妈妈', phone: '136****0004', bank: '建设银行', remark: '家人' },
  { id: 'contact_lihua', userId: USER_ID, name: '李华', phone: '135****0005', bank: '农业银行', remark: null },
];

/**
 * September 2026 ordinary expenses on the checking account.
 * Sum of magnitudes = EXACTLY ¥5,800 with 娱乐 = ¥2,680 — this drives Test 6 (spending analysis)
 * and Test 11 ("if 本月娱乐 > 2000"). The ¥6,999 anomaly is a SEPARATE row below.
 * 美团外卖 + 星巴克 sit on 2026-09-25 so a "今日消费" window exists.
 */
const SEPTEMBER_TRANSACTIONS = [
  // 餐饮 450 (CARD)
  { id: 'tx_sep_haidilao', amount: -305, category: '餐饮', merchant: '海底捞', channel: 'CARD', occurredAt: sep(5, 19, 20) },
  { id: 'tx_sep_meituan', amount: -45, category: '餐饮', merchant: '美团外卖', channel: 'CARD', occurredAt: sep(25, 12, 10) },
  { id: 'tx_sep_starbucks', amount: -38, category: '餐饮', merchant: '星巴克', channel: 'CARD', occurredAt: sep(25, 9, 5) },
  { id: 'tx_sep_kfc', amount: -62, category: '餐饮', merchant: '肯德基', channel: 'CARD', occurredAt: sep(12, 12, 40) },
  // 出行 636 (APP)
  { id: 'tx_sep_rail', amount: -553, category: '出行', merchant: '高铁票', channel: 'APP', occurredAt: sep(3, 8, 15) },
  { id: 'tx_sep_didi1', amount: -45, category: '出行', merchant: '滴滴出行', channel: 'APP', occurredAt: sep(8, 22, 30) },
  { id: 'tx_sep_didi2', amount: -32, category: '出行', merchant: '滴滴出行', channel: 'APP', occurredAt: sep(14, 18, 50) },
  { id: 'tx_sep_metro', amount: -6, category: '出行', merchant: '地铁', channel: 'APP', occurredAt: sep(18, 7, 40) },
  // 购物 984 (CARD)
  { id: 'tx_sep_uniqlo', amount: -399, category: '购物', merchant: '优衣库', channel: 'CARD', occurredAt: sep(6, 15, 0) },
  { id: 'tx_sep_taobao', amount: -289, category: '购物', merchant: '淘宝', channel: 'CARD', occurredAt: sep(11, 21, 30) },
  { id: 'tx_sep_jd', amount: -296, category: '购物', merchant: '京东', channel: 'CARD', occurredAt: sep(19, 20, 10) },
  // 娱乐 2680 (CARD) — Test 11 threshold: 本月娱乐 > 2000
  { id: 'tx_sep_concert', amount: -1880, category: '娱乐', merchant: '演唱会门票', channel: 'CARD', occurredAt: sep(10, 20, 0) },
  { id: 'tx_sep_ktv', amount: -480, category: '娱乐', merchant: 'KTV', channel: 'CARD', occurredAt: sep(13, 23, 0) },
  { id: 'tx_sep_steam', amount: -200, category: '娱乐', merchant: 'Steam', channel: 'CARD', occurredAt: sep(16, 22, 0) },
  { id: 'tx_sep_cinema', amount: -120, category: '娱乐', merchant: '影院电影票', channel: 'CARD', occurredAt: sep(22, 19, 30) },
  // 居住 300 (APP)
  { id: 'tx_sep_utilities', amount: -180, category: '居住', merchant: '水电费', channel: 'APP', occurredAt: sep(1, 10, 0) },
  { id: 'tx_sep_property', amount: -120, category: '居住', merchant: '物业费', channel: 'APP', occurredAt: sep(2, 10, 0) },
  // 医疗 86 (CARD)
  { id: 'tx_sep_pharmacy', amount: -86, category: '医疗', merchant: '药店', channel: 'CARD', occurredAt: sep(9, 17, 20) },
  // 订阅 114 (SUBSCRIPTION)
  { id: 'tx_sep_netflix', amount: -68, category: '订阅', merchant: 'Netflix', channel: 'SUBSCRIPTION', occurredAt: sep(15, 0, 0) },
  { id: 'tx_sep_spotify', amount: -15, category: '订阅', merchant: 'Spotify', channel: 'SUBSCRIPTION', occurredAt: sep(15, 0, 0) },
  { id: 'tx_sep_icloud', amount: -6, category: '订阅', merchant: 'iCloud', channel: 'SUBSCRIPTION', occurredAt: sep(21, 0, 0) },
  { id: 'tx_sep_video', amount: -25, category: '订阅', merchant: '视频会员', channel: 'SUBSCRIPTION', occurredAt: sep(17, 0, 0) },
  // 转账 500 (TRANSFER) — to contact 妈妈
  { id: 'tx_sep_transfer_mama', amount: -500, category: '转账', merchant: '转账给妈妈', channel: 'TRANSFER', counterpartyId: 'contact_mama', occurredAt: sep(4, 19, 0) },
  // 其他 50 (APP)
  { id: 'tx_sep_phone', amount: -50, category: '其他', merchant: '话费充值', channel: 'APP', occurredAt: sep(7, 9, 30) },
];

/** August 2026 (last month) — varied expenses (~¥6,230) so month-over-month trends are sensible. */
const AUGUST_TRANSACTIONS = [
  { id: 'tx_aug_rent', amount: -2500, category: '居住', merchant: '房租', channel: 'TRANSFER', occurredAt: aug(1, 9, 0) },
  { id: 'tx_aug_dining', amount: -1350, category: '餐饮', merchant: '餐饮支出', channel: 'CARD', occurredAt: aug(14, 19, 30) },
  { id: 'tx_aug_travel', amount: -620, category: '出行', merchant: '出行支出', channel: 'APP', occurredAt: aug(20, 8, 45) },
  { id: 'tx_aug_shopping', amount: -1080, category: '购物', merchant: '购物支出', channel: 'CARD', occurredAt: aug(22, 15, 10) },
  { id: 'tx_aug_ent', amount: -680, category: '娱乐', merchant: '娱乐支出', channel: 'CARD', occurredAt: aug(25, 21, 0) },
];

/** The Apple Store anomaly — MUST be exact (Test 7): ¥6,999 @ 2026-09-20 18:32, flagged. */
const ANOMALY_TRANSACTION = {
  id: 'tx_anomaly_apple',
  amount: -6999,
  category: '购物',
  merchant: 'Apple Store',
  channel: 'CARD',
  occurredAt: sep(20, 18, 32),
  isAnomaly: true,
  anomalyReason: '大额消费（>¥5,000）',
};

const SUBSCRIPTIONS = [
  { id: 'sub_netflix', userId: USER_ID, name: 'Netflix', amount: 68, cycle: 'MONTHLY', nextChargeAt: oct(15), status: 'ACTIVE', remind: false },
  { id: 'sub_spotify', userId: USER_ID, name: 'Spotify', amount: 15, cycle: 'MONTHLY', nextChargeAt: oct(15), status: 'ACTIVE', remind: false },
  { id: 'sub_icloud', userId: USER_ID, name: 'iCloud', amount: 6, cycle: 'MONTHLY', nextChargeAt: oct(21), status: 'ACTIVE', remind: false },
  { id: 'sub_video', userId: USER_ID, name: '视频会员', amount: 25, cycle: 'MONTHLY', nextChargeAt: oct(17), status: 'ACTIVE', remind: false },
];

const PRODUCTS = [
  { id: 'prod_wenjiana', code: 'WJA001', name: '稳健理财A', riskLevel: 'R2', expectedRate: 3.25, termDays: 90, minAmount: 1000, description: '低风险稳健型' },
  { id: 'prod_wenjib', code: 'WJB002', name: '稳健理财B', riskLevel: 'R2', expectedRate: 3.6, termDays: 180, minAmount: 5000, description: '低风险稳健型' },
  { id: 'prod_jinrong', code: 'JR003', name: '进取混合C', riskLevel: 'R3', expectedRate: 5.1, termDays: 365, minAmount: 10000, description: '中风险混合型' },
  { id: 'prod_huobi', code: 'MMF001', name: '货币基金', riskLevel: 'R1', expectedRate: 2.1, termDays: 30, minAmount: 100, description: '现金管理型' },
];

const HOLDINGS = [
  { id: 'holding_wenjiana', userId: USER_ID, productId: 'prod_wenjiana', amount: 5000, marketValue: 5050, boughtAt: aug(10, 10, 0), status: 'HOLDING' },
];

const BUDGETS = [
  { id: 'budget_birthday', userId: USER_ID, name: '生日礼物', amount: 2000, purpose: '生日计划', status: 'RESERVED', dueDate: oct(20) },
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
    payload: JSON.stringify({ amount: 2500, toName: '房东' }),
    runAt: oct(1, 9, 0),
    status: 'SCHEDULED',
    requiresConfirmation: true,
  },
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Rebuild a table's rows for the demo user: scoped delete, then recreate. */
async function resetSeededTables(): Promise<void> {
  const cardIds = (await prisma.card.findMany({ where: { userId: USER_ID }, select: { id: true } })).map((c) => c.id);

  // Respect FK order: children before parents.
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

  const transactions = [...SEPTEMBER_TRANSACTIONS, ANOMALY_TRANSACTION, ...AUGUST_TRANSACTIONS].map((t) => ({
    accountId: ACCT_CHECKING,
    userId: USER_ID,
    currency: 'CNY',
    direction: 'DEBIT' as const,
    counterpartyId: null as string | null,
    ...t,
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

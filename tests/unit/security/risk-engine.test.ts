/**
 * Unit: security/risk-engine — dynamic transfer tier + day-total computation.
 *
 * Targets `@/security/risk-engine`: evaluateTransferRisk({amount, dailyTransferTotal}),
 * computeDailyTransferTotal(userId, now?) (+ types TransferRiskInput, TransferRiskResult).
 *
 * `evaluateTransferRisk` is PURE & deterministic (no DB, no network).
 * `computeDailyTransferTotal` reads the transaction repository → needs the test SQLite (`../../helpers/db`).
 *
 * NOTE on the day window: `computeDailyTransferTotal` resolves `startOfDay(demoNow(now))` and calls
 * `sumOutgoingTransfersSince`, i.e. the window is `[start-of-day, +∞)` — a LOWER bound only. The
 * injected `now` therefore selects the day a transfer must fall INTO; cases below use a PRIOR day
 * (cleanly excluded) rather than asserting that a future-dated transfer is excluded.
 */
import { describe, it, expect, vi } from 'vitest';

import { computeDailyTransferTotal, evaluateTransferRisk } from '@/security/risk-engine';
import { DAILY_TRANSFER_LIMIT } from '@/lib/constants';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '../../helpers/fixtures';

// The per-test DB reset + seed (`useFreshDatabase` → truncateAll + seedDemoData) is I/O heavy
// (~5–7 s with Prisma/SQLite) and occasionally exceeds Vitest's 10 s DEFAULT hook timeout, which
// would fail the whole file for reasons unrelated to the assertions. Give the hook more room.
// (Assertions and determinism are untouched; nothing is faked or skipped.)
vi.setConfig({ hookTimeout: 60_000 });

// DB-backed spec: reset + seed the demo world before every test.
useFreshDatabase();

/** The seeded 活期 checking account the demo transactions hang off (`acct_checking`). */
const CHECKING_ACCOUNT_ID = ACCOUNTS[0].id;

/** A second user, used only by the userId-scoping case. */
const OTHER_USER_ID = 'user_other';
const OTHER_ACCOUNT_ID = 'acct_other';

interface NewTransaction {
  amount: number;
  direction: 'DEBIT' | 'CREDIT';
  channel: 'APP' | 'CARD' | 'TRANSFER' | 'SUBSCRIPTION';
  occurredAt: Date;
  category?: string;
  merchant?: string;
  userId?: string;
  accountId?: string;
}

/** Insert a raw transaction into the test DB (demo user's checking account by default). */
function insertTransaction(tx: NewTransaction) {
  return getTestPrisma().transaction.create({
    data: {
      accountId: tx.accountId ?? CHECKING_ACCOUNT_ID,
      userId: tx.userId ?? DEMO_USER_ID,
      amount: tx.amount,
      currency: 'CNY',
      direction: tx.direction,
      category: tx.category ?? '转账',
      merchant: tx.merchant ?? '转账给张伟',
      channel: tx.channel,
      occurredAt: tx.occurredAt,
    },
  });
}

describe('risk-engine · evaluateTransferRisk · boundary (limit ¥1000)', () => {
  it('¥200, no prior transfers → tier YELLOW, requiresConfirmation true, requiresMfa false', () => {
    expect(DAILY_TRANSFER_LIMIT).toBe(1000);

    const result = evaluateTransferRisk({ amount: 200, dailyTransferTotal: 0 });

    expect(result.tier).toBe('YELLOW');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.requiresMfa).toBe(false);
  });

  it('amount exactly ¥1000, dailyTotal 0 → YELLOW (not strictly greater than the limit)', () => {
    const result = evaluateTransferRisk({ amount: DAILY_TRANSFER_LIMIT, dailyTransferTotal: 0 });

    expect(result.tier).toBe('YELLOW');
    expect(result.requiresMfa).toBe(false);
  });

  it('amount ¥1000.01, dailyTotal 0 → RED, requiresMfa true', () => {
    const result = evaluateTransferRisk({ amount: 1000.01, dailyTransferTotal: 0 });

    expect(result.tier).toBe('RED');
    expect(result.requiresMfa).toBe(true);
  });

  it('amount ¥500 with dailyTotal 600 (projected ¥1100) → RED (day rule; amount alone is small)', () => {
    const result = evaluateTransferRisk({ amount: 500, dailyTransferTotal: 600 });

    expect(result.tier).toBe('RED');
    expect(result.requiresMfa).toBe(true);
    expect(result.projectedDailyTotal).toBe(1100);
    // The deciding rule is the DAY total, not the single-transaction amount.
    expect(result.reasons.join(' ')).toContain('累计');
  });

  it('amount ¥500 with dailyTotal 500 (projected exactly ¥1000) → YELLOW (not strictly greater)', () => {
    const result = evaluateTransferRisk({ amount: 500, dailyTransferTotal: 500 });

    expect(result.projectedDailyTotal).toBe(DAILY_TRANSFER_LIMIT);
    expect(result.tier).toBe('YELLOW');
    expect(result.requiresMfa).toBe(false);
  });
});

describe('risk-engine · evaluateTransferRisk · result shape', () => {
  it('requiresConfirmation is ALWAYS true for transfers (both YELLOW and RED)', () => {
    const inputs = [
      { amount: 0, dailyTransferTotal: 0 },
      { amount: 200, dailyTransferTotal: 0 },
      { amount: 500, dailyTransferTotal: 900 },
      { amount: 5000, dailyTransferTotal: 0 },
      { amount: 500, dailyTransferTotal: 600 },
    ];

    for (const input of inputs) {
      expect(evaluateTransferRisk(input).requiresConfirmation).toBe(true);
    }
  });

  it("requiresMfa === (tier === 'RED')", () => {
    const inputs = [
      { amount: 200, dailyTransferTotal: 0 },
      { amount: DAILY_TRANSFER_LIMIT, dailyTransferTotal: 0 },
      { amount: 500, dailyTransferTotal: 500 },
      { amount: 1000.01, dailyTransferTotal: 0 },
      { amount: 500, dailyTransferTotal: 600 },
    ];

    for (const input of inputs) {
      const result = evaluateTransferRisk(input);
      expect(['YELLOW', 'RED']).toContain(result.tier);
      expect(result.requiresMfa).toBe(result.tier === 'RED');
    }
  });

  it('reports amount, dailyTotal (echoed) and projectedDailyTotal === dailyTotal + amount', () => {
    const result = evaluateTransferRisk({ amount: 300, dailyTransferTotal: 400 });

    expect(result.amount).toBe(300);
    expect(result.dailyTotal).toBe(400);
    expect(result.projectedDailyTotal).toBe(400 + 300);
  });

  it('reasons[] is non-empty and explains the deciding rule (amount vs day total)', () => {
    const overAmount = evaluateTransferRisk({ amount: DAILY_TRANSFER_LIMIT + 1, dailyTransferTotal: 0 });
    expect(overAmount.reasons.length).toBeGreaterThan(0);
    expect(overAmount.reasons.join(' ')).toContain('单笔');

    const overDay = evaluateTransferRisk({ amount: 500, dailyTransferTotal: 600 });
    expect(overDay.reasons.length).toBeGreaterThan(0);
    expect(overDay.reasons.join(' ')).toContain('累计');

    const yellow = evaluateTransferRisk({ amount: 200, dailyTransferTotal: 0 });
    expect(yellow.reasons.length).toBeGreaterThan(0);
    expect(yellow.reasons.join(' ')).toContain('限额');
  });

  it('is deterministic: identical input yields a deep-equal result', () => {
    const input = { amount: 750, dailyTransferTotal: 300 };

    const first = evaluateTransferRisk(input);
    const second = evaluateTransferRisk({ ...input });

    expect(second).toEqual(first);
    expect(evaluateTransferRisk(input)).toEqual(first);
  });
});

describe('risk-engine · computeDailyTransferTotal (needs test SQLite)', () => {
  it('returns 0 when the user has no transfers today', async () => {
    // Fresh seed: the only TRANSFER-channel debits are `tx_sep_transfer_mama` (Sep 4) and
    // `tx_aug_rent` (last month) — both before the demo day (Sep 25) start.
    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe(0);
  });

  it("sums only TODAY's outgoing DEBIT transfers for the given userId", async () => {
    await insertTransaction({
      amount: -300,
      direction: 'DEBIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 25, 8, 0),
    });
    await insertTransaction({
      amount: -150,
      direction: 'DEBIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 25, 9, 30),
    });

    // DEBIT amounts are stored negative; the repository returns the ABSOLUTE total.
    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe(450);
  });

  it('excludes transfers from other days (a prior day relative to now)', async () => {
    await insertTransaction({
      amount: -5000,
      direction: 'DEBIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 24, 23, 59), // yesterday, just before the day boundary
    });
    await insertTransaction({
      amount: -200,
      direction: 'DEBIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 25, 8, 0),
    });

    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe(200);
  });

  it('is deterministic via the injected now: a fixed now selects exactly one calendar day', async () => {
    await insertTransaction({
      amount: -100,
      direction: 'DEBIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 25, 8, 0),
    });

    const sept25Noon = new Date(2026, 8, 25, 12, 0).getTime();
    const sept26Noon = new Date(2026, 8, 26, 12, 0).getTime();

    // Default `now` is the demo clock (2026-09-25 12:00 local) → the 25th transfer counts.
    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe(100);
    expect(await computeDailyTransferTotal(DEMO_USER_ID, sept25Noon)).toBe(100);
    // The 26th's day starts after the 25th transfer → nothing in its window.
    expect(await computeDailyTransferTotal(DEMO_USER_ID, sept26Noon)).toBe(0);
  });

  it('excludes incoming CREDIT transactions', async () => {
    await insertTransaction({
      amount: 800,
      direction: 'CREDIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 25, 10, 0),
      category: '转账',
      merchant: '收到转账',
    });

    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe(0);
  });

  it('excludes non-transfer debits (e.g. card purchases)', async () => {
    await insertTransaction({
      amount: -120,
      direction: 'DEBIT',
      channel: 'CARD',
      occurredAt: new Date(2026, 8, 25, 11, 0),
      category: '餐饮',
      merchant: '星巴克',
    });
    await insertTransaction({
      amount: -50,
      direction: 'DEBIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 25, 12, 0),
    });

    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe(50);
  });

  it("scopes to the given userId (another user's transfers today are not counted)", async () => {
    const prisma = getTestPrisma();
    await prisma.user.create({
      data: { id: OTHER_USER_ID, name: '王小明', phone: '139****7777' },
    });
    await prisma.account.create({
      data: {
        id: OTHER_ACCOUNT_ID,
        userId: OTHER_USER_ID,
        type: 'CHECKING',
        name: '活期账户',
        number: '****0001',
        balance: 8000,
        currency: 'CNY',
      },
    });

    await insertTransaction({
      userId: OTHER_USER_ID,
      accountId: OTHER_ACCOUNT_ID,
      amount: -700,
      direction: 'DEBIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 25, 9, 0),
    });
    await insertTransaction({
      amount: -90,
      direction: 'DEBIT',
      channel: 'TRANSFER',
      occurredAt: new Date(2026, 8, 25, 9, 30),
    });

    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe(90);
    expect(await computeDailyTransferTotal(OTHER_USER_ID)).toBe(700);
  });
});

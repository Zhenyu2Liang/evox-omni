/**
 * Unit: security/risk-engine — `reEvaluateTransferRisk` (execution-time re-risk against a FRESH
 * day total).
 *
 * Targets `@/security/risk-engine`: `reEvaluateTransferRisk(userId, amount, now?)` re-computes
 * `computeDailyTransferTotal(userId, now)` at EXECUTION time and re-runs `evaluateTransferRisk`,
 * closing the stale-parked-transfer bypass (N small transfers each YELLOW at PARK time still cross
 * the ¥1000 daily limit once they execute). Also asserted: facade exposure + STRICT `>` boundary.
 *
 * DB-backed (reads the transaction repository) → needs the test SQLite (`useFreshDatabase()`).
 * The demo clock (2026-09-25) is the default `now`; `now` may be injected for determinism.
 */
import { describe, expect, it, vi } from 'vitest';

import { security } from '@/security';
import { reEvaluateTransferRisk } from '@/security/risk-engine';
import { moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';

// The per-test DB reset + seed (`useFreshDatabase`) is I/O heavy and can exceed the 10 s default
// hook timeout; give it more room (assertions/determinism untouched).
vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** The seeded 活期 checking account the demo transactions hang off (`acct_checking`). */
const CHECKING_ACCOUNT_ID = ACCOUNTS[0].id;

/** A time inside the demo day (2026-09-25) — counts as "today's" outgoing transfer. */
const DEMO_DAY_MORNING = new Date(2026, 8, 25, 8, 0);
/** The demo instant (2026-09-25 12:00 local) as epoch ms — the default `now`. */
const DEMO_DAY_NOON = new Date(2026, 8, 25, 12, 0).getTime();
/** Just before the demo day's boundary — belongs to the PRIOR calendar day (2026-09-24). */
const PRIOR_DAY_LATE = new Date(2026, 8, 24, 23, 59);

/**
 * Insert a raw outgoing TRANSFER debit (NEGATIVE amount) into the demo user's checking account.
 * Only TRANSFER/DEBIT rows are counted by `computeDailyTransferTotal`.
 */
async function insertTransaction(amount: string, occurredAt: Date): Promise<void> {
  await getTestPrisma().transaction.create({
    data: {
      accountId: CHECKING_ACCOUNT_ID,
      userId: DEMO_USER_ID,
      amountMinor: moneyToCents(amount),
      currency: 'CNY',
      direction: 'DEBIT',
      category: '转账',
      merchant: '转账给张伟',
      channel: 'TRANSFER',
      occurredAt,
    },
  });
}

describe('risk-engine · reEvaluateTransferRisk (execution-time re-risk)', () => {
  it('is exposed on the facade as security.risk.reEvaluateTransferRisk', () => {
    expect(typeof security.risk.reEvaluateTransferRisk).toBe('function');
  });

  it('no prior transfers today + ¥200 → YELLOW, no MFA', async () => {
    const result = await reEvaluateTransferRisk(DEMO_USER_ID, '200.00');

    expect(result.dailyTotal).toBe('0.00');
    expect(result.projectedDailyTotal).toBe('200.00');
    expect(result.tier).toBe('YELLOW');
    expect(result.requiresMfa).toBe(false);
  });

  it('stale-parked-transfer bypass: prior ¥600 today + ¥600 → RED (fresh total escalates)', async () => {
    await insertTransaction('-600.00', DEMO_DAY_MORNING);

    const result = await reEvaluateTransferRisk(DEMO_USER_ID, '600.00');

    expect(result.dailyTotal).toBe('600.00');
    expect(result.projectedDailyTotal).toBe('1200.00');
    expect(result.tier).toBe('RED');
    expect(result.requiresMfa).toBe(true);
  });

  it('prior ¥400 + ¥600 → projected exactly ¥1000 → YELLOW (STRICT `>`)', async () => {
    await insertTransaction('-400.00', DEMO_DAY_MORNING);

    const result = await reEvaluateTransferRisk(DEMO_USER_ID, '600.00');

    expect(result.projectedDailyTotal).toBe('1000.00');
    expect(result.tier).toBe('YELLOW');
    expect(result.requiresMfa).toBe(false);
  });

  it('prior ¥401 + ¥600 → projected ¥1001 → RED (one cent over the limit)', async () => {
    await insertTransaction('-401.00', DEMO_DAY_MORNING);

    const result = await reEvaluateTransferRisk(DEMO_USER_ID, '600.00');

    expect(result.projectedDailyTotal).toBe('1001.00');
    expect(result.tier).toBe('RED');
    expect(result.requiresMfa).toBe(true);
  });

  it('amount exactly ¥1000, no prior → YELLOW (not strictly greater than the limit)', async () => {
    const result = await reEvaluateTransferRisk(DEMO_USER_ID, '1000.00');

    expect(result.tier).toBe('YELLOW');
    expect(result.requiresMfa).toBe(false);
  });

  it('amount ¥1000.01, no prior → RED, requiresMfa true', async () => {
    const result = await reEvaluateTransferRisk(DEMO_USER_ID, '1000.01');

    expect(result.tier).toBe('RED');
    expect(result.requiresMfa).toBe(true);
  });

  it('determinism via injected now: a PRIOR-day transfer is not counted for the demo day', async () => {
    await insertTransaction('-5000.00', PRIOR_DAY_LATE);

    // The demo day (2026-09-25): the 2026-09-24 23:59 transfer is outside today's window.
    const byDefault = await reEvaluateTransferRisk(DEMO_USER_ID, '200.00');
    expect(byDefault.dailyTotal).toBe('0.00');
    expect(byDefault.projectedDailyTotal).toBe('200.00');
    expect(byDefault.tier).toBe('YELLOW');

    const byExplicitNow = await reEvaluateTransferRisk(DEMO_USER_ID, '200.00', DEMO_DAY_NOON);
    expect(byExplicitNow.dailyTotal).toBe('0.00');

    // Same rows, evaluated AS OF the 24th → the transfer now falls inside that day's window.
    const asOfPriorDay = await reEvaluateTransferRisk(
      DEMO_USER_ID,
      '200.00',
      PRIOR_DAY_LATE.getTime(),
    );
    expect(asOfPriorDay.dailyTotal).toBe('5000.00');
    expect(asOfPriorDay.projectedDailyTotal).toBe('5200.00');
    expect(asOfPriorDay.tier).toBe('RED');
    expect(asOfPriorDay.requiresMfa).toBe(true);
  });
});

/**
 * banking-sdk · card consumption time is SERVER-OWNED.
 *
 * `consumeCard` decides BOTH the booking instant (`demoNow()`, UTC+08:00 business clock) and the
 * billing month the amount is counted against (`demoMonthRange()` of that SAME instant). The public
 * parameter set (`ConsumeCardInput`) therefore carries no time field at all, and a runtime object
 * that still carries a DEFINED `occurredAt` — a stale client, a raw HTTP body, a tool-argument
 * object — is rejected with `AppError('VALIDATION')` BEFORE any read or write. Silently ignoring it
 * would let a caller believe a spend was back-dated out of the current billing month (and therefore
 * spend the same monthly limit twice).
 *
 * What these specs prove, each against the real SDK and the real SQLite database:
 *   1. the rejection matrix — past/future instants, a fractional number, `null`, a string, a `Date`
 *      and an object are ALL rejected, and the world (account balance, ledger rows, consumption
 *      rows) is byte-identical before/after, i.e. no partial write survives;
 *   2. `{ occurredAt: undefined }` is NOT a claim (the guard tests `claimed !== undefined`), so the
 *      spend succeeds and is booked at `demoNow()`;
 *   3. the public TYPE has no time field (a compile-time assertion plus a `@ts-expect-error` probe
 *      that becomes a `tsc` error if `occurredAt` is ever re-added), and the one reachable runtime
 *      difference is asserted: `options.now` is honoured, an input-level `occurredAt` is refused;
 *   4. the monthly limit is enforced at EXACT minor-unit boundaries (reaching the limit, a `0.00`
 *      limit, and an omitted/`null` limit that is cash-bound only);
 *   5. billing-month attribution follows the pinned instant: a spend booked at the last instant of
 *      the PREVIOUS business month does not consume the new month's allowance — its own result
 *      snapshot reports that EARLIER month's remainder while a fresh read still sees the untouched
 *      new month, a spend at the FIRST instant of the new month does consume it, and the default
 *      (no seam) spend lands inside `demoMonthRange()`.
 *
 * All money is asserted as exact canonical CNY decimal strings / integer minor units — never floats.
 *
 * Fixtures: demo user 李明 (`acct_checking` CHECKING ¥23,580). The seeded cards are not account-bound,
 * so these specs issue VIRTUAL cards through the SDK itself (bound to `acct_checking`).
 *
 * NOTE: `useFreshDatabase()` resets through the shared `truncateAll()`, which clears EVERY model
 * of the schema — including the relation-free `CardConsumption` ledger — so this suite needs
 * no extra cleanup hook of its own.
 */
import { describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type {
  ApplyVirtualCardInput,
  CardView,
  ConsumeCardInput,
  ConsumeCardOptions,
  ConsumeCardResult,
} from '@/banking-sdk/types';
import { demoMonthRange, demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { centsToMoney } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

const db = () => getTestPrisma();

/** The user's default CHECKING account (¥23,580) — the virtual card's settlement account. */
const CHECKING = 'acct_checking';
/** The merchant label `consumeCard` stamps when the input omits one (local simulation only). */
const DEFAULT_MERCHANT = '本地模拟消费';
/** One day in milliseconds — used to forge a "past" / "future" instant far from the demo clock. */
const ONE_DAY_MS = 86_400_000;

/** Await `fn`, returning whatever it rejected with; fail loudly if it unexpectedly resolves. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** Assert the rejection is an `AppError` carrying the expected domain code. */
function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

/** Issue a VIRTUAL card for the demo user (optionally overriding the monthly limit). */
function issueVirtual(input: Omit<Partial<ApplyVirtualCardInput>, 'userId'> = {}): Promise<CardView> {
  return banking.card.applyVirtualCard({ userId: DEMO_USER_ID, ...input });
}

/** A well-formed spend input for `cardId` (the server supplies the time, never the caller). */
function spend(cardId: string, amount: string): ConsumeCardInput {
  return { userId: DEMO_USER_ID, cardId, amount };
}

/** Book one spend from `cardId`, optionally through the internal clock seam. */
function consume(cardId: string, amount: string, options?: ConsumeCardOptions): Promise<ConsumeCardResult> {
  return options === undefined
    ? banking.card.consumeCard(spend(cardId, amount))
    : banking.card.consumeCard(spend(cardId, amount), options);
}

/**
 * A forged input: the object a stale client / raw HTTP body / tool-argument map would produce when it
 * still sends a caller-owned instant. Built through a cast on purpose — the PUBLIC type has no such
 * field, so only the runtime guard inside `consumeCard` can reject it.
 */
function forgedInput(cardId: string, occurredAt: unknown): ConsumeCardInput {
  return { userId: DEMO_USER_ID, cardId, amount: '1.00', occurredAt } as unknown as ConsumeCardInput;
}

/** The exact balance of an account as canonical CNY text. */
async function balanceOf(accountId = CHECKING): Promise<string> {
  const row = await db().account.findUniqueOrThrow({ where: { id: accountId } });
  return centsToMoney(row.balanceMinor);
}

/** The enriched `CardView` for one of the user's cards (the exact projection `getCards` returns). */
async function viewOf(cardId: string): Promise<CardView> {
  const view = (await banking.card.getCards(DEMO_USER_ID)).find((candidate) => candidate.id === cardId);
  if (!view) throw new Error(`card ${cardId} not found`);
  return view;
}

/**
 * Everything a rejected spend must leave untouched: the settlement account balance, the WHOLE ledger
 * row count, the number of `channel='CARD'` rows this SDK writes (`merchant` = the default label, so
 * the seeded 消费 rows are excluded), the consumption ledger size, and the rows for `cardId` itself.
 */
interface SpendSnapshot {
  balance: string;
  transactionCount: number;
  cardLedgerCount: number;
  consumptionCount: number;
  cardConsumptionCount: number;
}

async function snapshot(cardId: string): Promise<SpendSnapshot> {
  return {
    balance: await balanceOf(),
    transactionCount: await db().transaction.count({ where: { userId: DEMO_USER_ID } }),
    cardLedgerCount: await db().transaction.count({
      where: { userId: DEMO_USER_ID, channel: 'CARD', merchant: DEFAULT_MERCHANT },
    }),
    consumptionCount: await db().cardConsumption.count({ where: { userId: DEMO_USER_ID } }),
    cardConsumptionCount: await db().cardConsumption.count({ where: { userId: DEMO_USER_ID, cardId } }),
  };
}

/* ------------------------------------------------------------ compile-time probes */

/**
 * PROBE 1 — the public parameter set has NO consumption instant. `HasTime` collapses to `true` the
 * moment `occurredAt` is re-added to `ConsumeCardInput`, which makes the `false` assignment below a
 * `tsc` error. A runtime `Object.keys` check cannot prove this: a type-only field leaves no trace on
 * a value, which is exactly why the SDK ALSO guards at runtime (see PROBE 2).
 */
type InputKeys = keyof ConsumeCardInput;
type HasTime = 'occurredAt' extends InputKeys ? true : false;
const noCallerTime: HasTime = false;

/**
 * PROBE 2 — the same fact from the call site: passing `occurredAt` inside `ConsumeCardInput` does not
 * typecheck. If the field ever returns, this literal compiles and the (then unused)
 * `@ts-expect-error` directive itself becomes a `tsc` error. At runtime the key IS present, which is
 * the exact stale-client case the runtime guard rejects.
 */
const forgedLiteral: ConsumeCardInput = {
  userId: DEMO_USER_ID,
  cardId: 'card_credit',
  amount: '1.00',
  // @ts-expect-error `ConsumeCardInput` carries NO caller-owned consumption instant — the server owns it.
  occurredAt: demoNow(),
};

describe('banking-sdk · consumption time is server-owned', () => {
  /** The business month of the demo clock: 2026-09-01T00:00+08:00 .. 2026-10-01T00:00+08:00. */
  const MONTH = demoMonthRange();
  /** The last instant of the PREVIOUS business month (2026-08-31T23:59:59.999+08:00). */
  const PREVIOUS_MONTH_END = MONTH.start.getTime() - 1;

  /**
   * Every forged form is rejected. `null`, a fractional number, a string, a `Date` and an object are
   * all DEFINED values — the guard is `claimed !== undefined`, not a type test — so none of them is
   * silently coerced into a booking instant (or dropped, which would let the caller believe the
   * spend was back-dated).
   */
  const FORGED_FORMS: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'a past instant (last day of the previous month)', value: MONTH.start.getTime() - ONE_DAY_MS },
    { label: 'a future instant (one day after demoNow)', value: demoNow() + ONE_DAY_MS },
    { label: 'a fractional number (1.5)', value: 1.5 },
    { label: 'null', value: null },
    { label: 'a date string', value: '2026-09-01T00:00:00+08:00' },
    { label: 'a Date instance', value: new Date(demoNow()) },
    { label: 'an object', value: { ms: demoNow() } },
  ];

  for (const form of FORGED_FORMS) {
    it(`rejects a caller-supplied occurredAt: ${form.label} — VALIDATION, nothing written`, async () => {
      const card = await issueVirtual({ monthlyLimit: '5000.00' });
      const before = await snapshot(card.id);

      expectCode(await capture(() => banking.card.consumeCard(forgedInput(card.id, form.value))), 'VALIDATION');

      // Byte-identical world: no debit, no ledger row, no consumption row for this card.
      expect(await snapshot(card.id)).toEqual(before);
      expect(await balanceOf()).toBe('23580.00');
      expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(0);
      expect(
        await db().transaction.count({ where: { userId: DEMO_USER_ID, channel: 'CARD', merchant: DEFAULT_MERCHANT } }),
      ).toBe(0);
      // The card's derived allowance is untouched as well.
      expect((await viewOf(card.id)).payableAmount).toBe('5000.00');
    });
  }

  it('treats an explicitly-undefined occurredAt as NOT provided and books at demoNow()', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    const before = await snapshot(card.id);

    // WHY this is not a claim: the guard asks whether a DEFINED instant was supplied
    // (`claimed !== undefined`). A property that is present but `undefined` carries no value a
    // consumer could read, so it is indistinguishable from an absent property — there is nothing to
    // honour and nothing to reject. A `null`/`0`/`Date` DOES carry a claim and is refused above.
    const forgedUndefined = {
      userId: DEMO_USER_ID,
      cardId: card.id,
      amount: '12.34',
      occurredAt: undefined,
    } as unknown as ConsumeCardInput;
    expect(Object.keys(forgedUndefined)).toContain('occurredAt');

    const result = await banking.card.consumeCard(forgedUndefined);

    // Booked at the server instant, charged exactly once.
    expect(result.consumption.occurredAt).toBe(demoNow());
    expect(result.consumption.amount).toBe('12.34');
    expect(result.accountAvailableBalance).toBe('23567.66'); // 23580.00 − 12.34
    expect(await balanceOf()).toBe('23567.66');

    const after = await snapshot(card.id);
    expect(after.transactionCount).toBe(before.transactionCount + 1);
    expect(after.cardLedgerCount).toBe(before.cardLedgerCount + 1);
    expect(after.consumptionCount).toBe(before.consumptionCount + 1);
    expect(after.cardConsumptionCount).toBe(before.cardConsumptionCount + 1);

    const rows = await db().cardConsumption.findMany({ where: { cardId: card.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountMinor).toBe(1234n);
    expect(rows[0].occurredAt.getTime()).toBe(demoNow());
    expect(rows[0].accountId).toBe(CHECKING);
  });

  it('exposes no caller-owned time field in the type; only the options seam is honoured at runtime', async () => {
    // PROBE 1: the public parameter set has no `occurredAt` (see the module-level assertions).
    expect(noCallerTime).toBe(false);

    // A type-only field leaves no runtime trace, so a value can still CARRY the key — which is why a
    // pure `Object.keys` check proves nothing and the SDK guards at runtime instead.
    expect(Object.keys(forgedLiteral)).toContain('occurredAt');
    expectCode(await capture(() => banking.card.consumeCard(forgedLiteral)), 'VALIDATION');

    // The ONE reachable runtime difference: the SECOND argument (`options.now`, internal/test-only)
    // is honoured, while an input-level `occurredAt` is refused. Both are asserted on the same card.
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    const options: ConsumeCardOptions = { now: MONTH.start };
    const booked = await banking.card.consumeCard(spend(card.id, '10.00'), options);
    expect(booked.consumption.occurredAt).toBe(MONTH.start.getTime());

    const ledgerRow = await db().transaction.findFirstOrThrow({
      where: { userId: DEMO_USER_ID, channel: 'CARD', merchant: DEFAULT_MERCHANT },
    });
    expect(ledgerRow.occurredAt.getTime()).toBe(MONTH.start.getTime());

    // ... and the same instant supplied through the INPUT is still refused, after that success.
    expectCode(
      await capture(() => banking.card.consumeCard(forgedInput(card.id, MONTH.start.getTime()))),
      'VALIDATION',
    );
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(1);
  });

  it('rejects a non-integer options.now (the only clock seam is a validated millisecond value)', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    const before = await snapshot(card.id);

    expectCode(
      await capture(() => banking.card.consumeCard(spend(card.id, '1.00'), { now: MONTH.start.getTime() + 0.5 })),
      'VALIDATION',
    );

    expect(await snapshot(card.id)).toEqual(before);
  });
});

describe('banking-sdk · monthly limit boundaries are exact', () => {
  it('accepts spends that reach the limit EXACTLY and refuses the next minor unit', async () => {
    const card = await issueVirtual({ monthlyLimit: '100.00' });
    expect(card.payableAmount).toBe('100.00'); // min(balance 23580, remaining limit 100)

    // 99.99 + 0.01 === 100.00 exactly: the boundary is inclusive.
    const first = await consume(card.id, '99.99');
    expect(first.card.payableAmount).toBe('0.01');
    const second = await consume(card.id, '0.01');
    expect(second.card.payableAmount).toBe('0.00');
    expect(second.accountAvailableBalance).toBe('23480.00'); // 23580.00 − 100.00

    const before = await snapshot(card.id);
    expectCode(await capture(() => consume(card.id, '0.01')), 'LIMIT_EXCEEDED');
    expect(await snapshot(card.id)).toEqual(before);

    const rows = await db().cardConsumption.findMany({ where: { cardId: card.id }, orderBy: { occurredAt: 'asc' } });
    expect(rows.map((row) => row.amountMinor)).toEqual([9999n, 1n]);
    expect((await viewOf(card.id)).payableAmount).toBe('0.00');
  });

  it('blocks ANY spend when the monthly limit is 0.00 and charges nothing', async () => {
    const card = await issueVirtual({ monthlyLimit: '0.00' });
    expect(card.monthlyLimit).toBe('0.00');
    expect(card.payableAmount).toBe('0.00'); // min(23580, 0)

    const before = await snapshot(card.id);
    expectCode(await capture(() => consume(card.id, '0.01')), 'LIMIT_EXCEEDED');
    expect(await snapshot(card.id)).toEqual(before);
    expect(await balanceOf()).toBe('23580.00');
  });

  it('keeps an OMITTED (null) limit cash-bound only — payableAmount tracks the balance', async () => {
    const card = await issueVirtual(); // no monthlyLimit → monthlyLimitMinor === null
    expect(card.monthlyLimit).toBeUndefined();
    expect(card.payableAmount).toBe('23580.00');

    // No monthly cap is applied: a large spend succeeds purely on the cash.
    const large = await consume(card.id, '20000.00');
    expect(large.accountAvailableBalance).toBe('3580.00');
    expect(large.card.payableAmount).toBe('3580.00'); // the balance, not a limit

    // One minor unit beyond the cash is refused for FUNDS (there is no limit to blame).
    const before = await snapshot(card.id);
    expectCode(await capture(() => consume(card.id, '3580.01')), 'INSUFFICIENT_FUNDS');
    expect(await snapshot(card.id)).toEqual(before);

    // Spending the exact remaining cash empties the account — no cap blocks it.
    const emptied = await consume(card.id, '3580.00');
    expect(emptied.accountAvailableBalance).toBe('0.00');
    expect(emptied.card.payableAmount).toBe('0.00');
    expect(await balanceOf()).toBe('0.00');
    expectCode(await capture(() => consume(card.id, '0.01')), 'INSUFFICIENT_FUNDS');
    expect((await viewOf(card.id)).payableAmount).toBe('0.00');
  });
});

describe('banking-sdk · billing-month attribution follows the server instant', () => {
  it('never counts a previous-month spend against the new month and books the new month at its first instant', async () => {
    const month = demoMonthRange(); // 2026-09-01T00:00+08:00 .. 2026-10-01T00:00+08:00
    const previousMonthEnd = month.start.getTime() - 1; // 2026-08-31T23:59:59.999+08:00
    const card = await issueVirtual({ monthlyLimit: '1000.00' });

    // Operations, in this exact order (one card, so the month attribution is unambiguous):
    //   (1) ¥300.00 booked at the LAST instant of the PREVIOUS business month;
    //   (2) ¥400.00 booked at the FIRST instant of the new month;
    //   (3) ¥50.00 booked through the DEFAULT path (no seam), i.e. at demoNow().
    // (1) must be invisible to the new month's allowance; (2) and (3) must consume it.

    // (1) Previous business month: booked there, so September's allowance is untouched.
    const prior = await consume(card.id, '300.00', { now: previousMonthEnd });
    expect(prior.consumption.occurredAt).toBe(previousMonthEnd);
    expect(prior.consumption.occurredAt).toBeLessThan(month.start.getTime());
    expect(prior.accountAvailableBalance).toBe('23280.00'); // 23580.00 − 300.00
    // The result SNAPSHOT reports the allowance of the month the limit was enforced with — the
    // August month of `options.now` — so it shows that month's remainder: 1000.00 − 300.00.
    expect(prior.card.payableAmount).toBe('700.00');
    // A FRESH read (no seam) is evaluated at `demoNow()`, i.e. September, which the ¥300 never
    // touched: the FULL new-month allowance is still available.
    expect((await viewOf(card.id)).payableAmount).toBe('1000.00');

    // (2) First instant of the new month: counted in September, reducing the allowance.
    const atStart = await consume(card.id, '400.00', { now: month.start });
    expect(atStart.consumption.occurredAt).toBe(month.start.getTime());
    expect(atStart.accountAvailableBalance).toBe('22880.00'); // 23580.00 − 300.00 − 400.00
    expect(atStart.card.payableAmount).toBe('600.00'); // 1000.00 − 400.00 (NOT − 300.00)

    // (3) Default path: the booking instant is the server clock, inside this business month.
    const byDefault = await consume(card.id, '50.00');
    expect(byDefault.consumption.occurredAt).toBe(demoNow());
    expect(byDefault.consumption.occurredAt).toBeGreaterThanOrEqual(month.start.getTime());
    expect(byDefault.consumption.occurredAt).toBeLessThan(month.end.getTime());
    expect(byDefault.card.payableAmount).toBe('550.00'); // 1000.00 − 400.00 − 50.00

    // PERSISTED evidence: the consumption rows carry the instants the SDK decided.
    const consumptions = await db().cardConsumption.findMany({
      where: { cardId: card.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(consumptions.map((row) => row.occurredAt.getTime())).toEqual([
      previousMonthEnd,
      month.start.getTime(),
      demoNow(),
    ]);
    expect(consumptions.map((row) => row.amountMinor)).toEqual([30000n, 40000n, 5000n]);
    expect(consumptions[0].occurredAt.getTime()).toBeLessThan(month.start.getTime());

    // ... and the ledger rows match them exactly (same server instant, one row per spend).
    const ledger = await db().transaction.findMany({
      where: { userId: DEMO_USER_ID, channel: 'CARD', merchant: DEFAULT_MERCHANT },
      orderBy: { occurredAt: 'asc' },
    });
    expect(ledger.map((row) => row.occurredAt.getTime())).toEqual([
      previousMonthEnd,
      month.start.getTime(),
      demoNow(),
    ]);
    expect(ledger.map((row) => row.amountMinor)).toEqual([-30000n, -40000n, -5000n]);
    expect(ledger.map((row) => row.direction)).toEqual(['DEBIT', 'DEBIT', 'DEBIT']);
    expect(ledger.map((row) => row.accountId)).toEqual([CHECKING, CHECKING, CHECKING]);
  });
});

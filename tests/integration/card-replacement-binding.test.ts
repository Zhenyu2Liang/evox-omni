/**
 * tests/integration/card-replacement-binding.test.ts — VIRTUAL 补办 (`replace_card`) BINDING, LIMIT
 * CONTINUITY and BROKEN-LEGACY-DATA recovery, through the REAL SDK against the REAL (isolated SQLite)
 * database: no model, no browser, no HTTP.
 *
 * INVARIANTS UNDER TEST (root CONTEXT.md + `banking-sdk/card.ts` / `banking-sdk/card-family.ts`):
 *
 *  (1) BINDING IS INHERITED. A VIRTUAL card is a debit instrument bound to ONE owned CHECKING account.
 *      `replaceCard` mints a NEW card row, so the replacement must INHERIT the source's
 *      `Card.linkedAccountId` and re-validate it (exists, owned, `CHECKING`) inside the same
 *      transaction: a 补办 card that cannot spend from the same cash would be a dead card. The
 *      predecessor keeps its identity — `status 'LOST'`, same mask — and gains the historical
 *      `replacedByCardId` reference to the replacement.
 *
 *  (2) MONTHLY LIMIT IS FAMILY-CONTINUOUS. `Card.replacedByCardId` makes the replacement a NEW row while
 *      the already-booked `CardConsumption` rows stay exactly where they were booked. The current UTC+08:00
 *      billing month's spend therefore belongs to the whole replacement FAMILY
 *      (`cardFamilyMonthSpend` walks the pointer in BOTH directions), so `A → B → C` shares ONE
 *      allowance: no reset on 补办, no history rewrite, no re-attribution of an old spend to the new
 *      plastic. A spend booked in a PREVIOUS billing month does not consume that allowance.
 *
 *  (3) A `null` BINDING IS REPAIRED ONLY FROM ITS EXPLICIT PREDECESSOR. A replacement row minted before
 *      bindings were inherited has `linkedAccountId = null`; `consumeCard` restores it from the row
 *      whose `replacedByCardId` is that card and PERSISTS the repair.
 *
 *  (4) NO GUESSING, EVER. A `null`-bound card with NO explicit predecessor is refused with `CONFLICT`.
 *      The consume NEVER falls back to "the user's default account", so neither the binding nor the
 *      balance nor the ledger can move on a card whose settlement account is genuinely unknown.
 *
 * Fixtures: demo user 李明, `acct_checking` CHECKING ¥23,580 (default settlement account, mask
 * `****8821`), `acct_savings` SAVINGS ¥50,000, `card_credit` and `card_debit` (both unbound). No VIRTUAL
 * and no `LOST` card is seeded, so every VIRTUAL card here is issued by the SDK itself.
 *
 * All money is asserted as exact canonical CNY decimal strings / integer minor units — never floats. The
 * masked card number is RANDOMLY generated, so no literal mask is ever asserted for a new card.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { ApplyVirtualCardInput, CardView, ConsumeCardOptions, ConsumeCardResult } from '@/banking-sdk/types';
import { demoMonthRange, demoNow } from '@/lib/clock';
import { AppError, type ErrorCode } from '@/lib/errors';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

/** The user's default CHECKING account — the only seeded settlement target. */
const CHECKING = 'acct_checking';
/** Its masked number, exposed on the enriched `CardView` as `linkedAccountNumber`. */
const CHECKING_NUMBER = '****8821';
/** Seeded available cash of `acct_checking` (CNY minor units). */
const SEEDED_CHECKING_MINOR = moneyToCents('23580.00');

/**
 * The last instant of the PREVIOUS business month (`demoMonthRange().start` is the first instant of the
 * current one, and the business calendar is UTC+08:00). Derived from the pinned demo clock, so it is
 * deterministic: a spend booked here belongs to August 2026, not to the September allowance.
 */
const PREVIOUS_MONTH_INSTANT = demoMonthRange().start.getTime() - 1;

const db = () => getTestPrisma();

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/** Issue a VIRTUAL card for the demo user (default binding = `acct_checking`). */
function issueVirtual(input: Omit<Partial<ApplyVirtualCardInput>, 'userId'> = {}): Promise<CardView> {
  return banking.card.applyVirtualCard({ userId: DEMO_USER_ID, ...input });
}

/** The two real SDK writes of the RED 补办 flow: 挂失 then 补办. Returns the replacement view. */
async function loseAndReplace(cardId: string): Promise<CardView> {
  await banking.card.reportLostCard(cardId, DEMO_USER_ID, { reason: '卡遗失' });
  return banking.card.replaceCard(cardId, DEMO_USER_ID);
}

/**
 * One REAL SDK spend. The merchant is always explicit so the ledger assertions can be scoped to THIS
 * spend — the seeded world already contains `channel='CARD'` rows.
 */
function consume(
  cardId: string,
  amount: string,
  merchant: string,
  options: ConsumeCardOptions = {},
): Promise<ConsumeCardResult> {
  return banking.card.consumeCard({ userId: DEMO_USER_ID, cardId, amount, merchant }, options);
}

/** Raw card row (the persisted truth, not the projection). */
const cardRow = (cardId: string) => db().card.findUniqueOrThrow({ where: { id: cardId } });

/** Exact available cash of an account, in CNY minor units. */
async function balanceMinor(accountId: string = CHECKING) {
  return (await db().account.findUniqueOrThrow({ where: { id: accountId } })).balanceMinor;
}

/** The enriched `CardView` of one owned card — the same projection `getCards` returns. */
async function viewOf(cardId: string): Promise<CardView> {
  const view = (await banking.card.getCards(DEMO_USER_ID)).find((candidate) => candidate.id === cardId);
  if (!view) throw new Error(`card ${cardId} not found among the owned cards`);
  return view;
}

/** Every persisted spend row of the demo user, in a deterministic order. */
const consumptionRows = () =>
  db().cardConsumption.findMany({
    where: { userId: DEMO_USER_ID },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });

/** The fields of a booked spend that a 补办 must NEVER touch (no rewrite, no re-attribution). */
interface BookedSpend {
  id: string;
  cardId: string;
  amountMinor: bigint;
  occurredAt: number;
}

/** Snapshot of the booked spend history — `occurredAt` as epoch ms so deep equality is stable. */
async function historySnapshot(): Promise<BookedSpend[]> {
  return (await consumptionRows()).map((row) => ({
    id: row.id,
    cardId: row.cardId,
    amountMinor: row.amountMinor,
    occurredAt: row.occurredAt.getTime(),
  }));
}

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
function expectCode(error: unknown, code: ErrorCode): void {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe('virtual 补办 inherits the settlement-account binding (DB level, end to end)', () => {
  it('binds the replacement to the predecessor’s CHECKING account and debits it exactly once', async () => {
    // ── Arrange: a VIRTUAL card on the default CHECKING account with a ¥500 monthly limit. ──────────
    const source = await issueVirtual({ monthlyLimit: '500.00' });
    expect(source.linkedAccountId).toBe(CHECKING);
    const sourceRow = await cardRow(source.id);
    expect(sourceRow).toMatchObject({ type: 'VIRTUAL', status: 'ACTIVE', linkedAccountId: CHECKING, replacedByCardId: null });
    expect(sourceRow.monthlyLimitMinor).toBe(moneyToCents('500.00'));

    // ── Act: 挂失 + 补办 through the real SDK. ──────────────────────────────────────────────────────
    const replacement = await loseAndReplace(source.id);
    expect(replacement.id).not.toBe(source.id);

    // ── Assert the RAW replacement row: same owner/type/net, ACTIVE, binding + limit inherited. ─────
    const replacementRow = await cardRow(replacement.id);
    expect(replacementRow).toMatchObject({
      userId: DEMO_USER_ID,
      type: 'VIRTUAL',
      network: sourceRow.network,
      status: 'ACTIVE',
      linkedAccountId: CHECKING,
      replacedByCardId: null,
    });
    expect(replacementRow.monthlyLimitMinor).toBe(sourceRow.monthlyLimitMinor);
    // The mask is freshly generated and must be a NEW `****dddd` value — never a literal assertion.
    expect(replacementRow.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(replacementRow.numberMasked).not.toBe(sourceRow.numberMasked);

    // ── Assert the RAW source row: terminal, identity preserved, pointing at its replacement. ───────
    const lostRow = await cardRow(source.id);
    expect(lostRow).toMatchObject({ status: 'LOST', replacedByCardId: replacement.id, linkedAccountId: CHECKING });
    expect(lostRow.numberMasked).toBe(sourceRow.numberMasked);

    // ── Act: spend FROM THE REPLACEMENT. ───────────────────────────────────────────────────────────
    const before = await balanceMinor();
    const result = await consume(replacement.id, '25.00', '补办卡消费');

    // The returned projection reports the INHERITED binding — never a guessed account.
    expect(result.card.id).toBe(replacement.id);
    expect(result.card.linkedAccountId).toBe(CHECKING);
    expect(result.card.linkedAccountNumber).toBe(CHECKING_NUMBER);
    expect(result.consumption).toMatchObject({ cardId: replacement.id, accountId: CHECKING, amount: '25.00' });
    expect(result.accountAvailableBalance).toBe(centsToMoney(before - moneyToCents('25.00')));
    expect(result.card.accountAvailableBalance).toBe(result.accountAvailableBalance);
    // Remaining allowance after the spend: min(balance, ¥500 − ¥25).
    expect(result.card.payableAmount).toBe('475.00');

    // ── Exactly ONE debit on the settlement account. ───────────────────────────────────────────────
    expect(await balanceMinor()).toBe(before - moneyToCents('25.00'));
    const ledger = await db().transaction.findMany({
      where: { userId: DEMO_USER_ID, merchant: '补办卡消费' },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ accountId: CHECKING, channel: 'CARD', direction: 'DEBIT', currency: 'CNY' });
    expect(ledger[0].amountMinor).toBe(-moneyToCents('25.00'));

    // ── Exactly ONE consumption row, attributed to the card that incurred it. ──────────────────────
    const rows = await consumptionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cardId: replacement.id, accountId: CHECKING, userId: DEMO_USER_ID, currency: 'CNY' });
    expect(rows[0].amountMinor).toBe(moneyToCents('25.00'));
    // The predecessor incurred no spend of its own — it is a history row, not a spending card.
    expect(await db().cardConsumption.count({ where: { cardId: source.id } })).toBe(0);
  });
});

describe('monthly limit stays family-continuous across 补办 generations (A → B → C)', () => {
  it('shares ONE September allowance, rejects the overflow and never rewrites booked history', async () => {
    // ── Generation A: ¥100 monthly limit, spend ¥30. ───────────────────────────────────────────────
    const cardA = await issueVirtual({ monthlyLimit: '100.00' });
    expect(cardA.payableAmount).toBe('100.00');
    const spendA = await consume(cardA.id, '30.00', '一代卡消费');
    expect(spendA.consumption.occurredAt).toBe(demoNow());
    expect(spendA.card.payableAmount).toBe('70.00');
    const historyAfterA = await historySnapshot();
    expect(historyAfterA).toHaveLength(1);

    // ── Generation B: the replacement inherits the SAME ¥100 limit and the REMAINING ¥70. ──────────
    const cardB = await loseAndReplace(cardA.id);
    expect(cardB.id).not.toBe(cardA.id);
    expect(cardB.linkedAccountId).toBe(CHECKING);
    expect(cardB.monthlyLimit).toBe('100.00');
    // The account balance (¥23,550) is far larger than the remaining limit, so the cap IS the limit.
    expect(cardB.payableAmount).toBe('70.00');
    expect((await viewOf(cardB.id)).payableAmount).toBe('70.00');
    // 补办 alone books nothing: the history is byte-for-byte identical (no rewrite, no second debit).
    expect(await historySnapshot()).toEqual(historyAfterA);

    // A spend in the PREVIOUS billing month does not consume the September allowance — the family walk
    // is bounded by the UTC+08:00 month window, not by "any spend ever booked in this family".
    const spendB = await consume(cardB.id, '10.00', '二代卡上月消费', { now: PREVIOUS_MONTH_INSTANT });
    expect(spendB.consumption.occurredAt).toBe(PREVIOUS_MONTH_INSTANT);
    const historyAfterB = await historySnapshot();
    expect(historyAfterB).toHaveLength(2);
    expect((await viewOf(cardB.id)).payableAmount).toBe('70.00');

    // ── Generation C: NO reset — the second 补办 still shows the ¥70 remaining. ────────────────────
    const cardC = await loseAndReplace(cardB.id);
    expect(cardC.id).not.toBe(cardA.id);
    expect(cardC.id).not.toBe(cardB.id);
    expect(cardC.linkedAccountId).toBe(CHECKING);
    expect(cardC.monthlyLimit).toBe('100.00');
    expect(cardC.payableAmount).toBe('70.00');
    expect((await viewOf(cardC.id)).payableAmount).toBe('70.00');
    expect(await historySnapshot()).toEqual(historyAfterB);

    // ── ¥70.01 overflows the ONE shared allowance → LIMIT_EXCEEDED, nothing charged. ───────────────
    const balanceBeforeRejected = await balanceMinor();
    const rejected = await capture(() => consume(cardC.id, '70.01', '三代卡超额'));
    expectCode(rejected, 'LIMIT_EXCEEDED');
    expect((rejected as AppError).detail).toMatchObject({
      cardId: cardC.id,
      monthlyLimit: '100.00',
      spent: '30.00',
      amount: '70.01',
    });
    expect(await balanceMinor()).toBe(balanceBeforeRejected);
    expect(await historySnapshot()).toEqual(historyAfterB);

    // ── Exactly ¥70.00 fits: 30.00 + 70.00 = 100.00 is allowed (the limit is not exceeded). ────────
    const spendC = await consume(cardC.id, '70.00', '三代卡消费');
    expect(spendC.card.payableAmount).toBe('0.00');
    expect(spendC.accountAvailableBalance).toBe(centsToMoney(balanceBeforeRejected - moneyToCents('70.00')));
    expect(await balanceMinor()).toBe(balanceBeforeRejected - moneyToCents('70.00'));

    // ── The whole history: 3 successes ⇒ 3 rows, each still owned by the card that incurred it. ────
    const successes = [spendA, spendB, spendC];
    const rows = await historySnapshot();
    expect(successes).toHaveLength(3);
    expect(rows).toHaveLength(successes.length);
    expect(rows.filter((row) => row.cardId === cardA.id).map((row) => centsToMoney(row.amountMinor))).toEqual(['30.00']);
    expect(rows.filter((row) => row.cardId === cardB.id).map((row) => centsToMoney(row.amountMinor))).toEqual(['10.00']);
    expect(rows.filter((row) => row.cardId === cardC.id).map((row) => centsToMoney(row.amountMinor))).toEqual(['70.00']);
    // Row ids are untouched: the two rows booked before the LAST 补办 are still there, unmodified.
    for (const booked of historyAfterB) {
      expect(rows.find((row) => row.id === booked.id)).toEqual(booked);
      expect(booked.cardId).not.toBe(cardC.id);
    }
  });
});

describe('broken legacy data: a null binding is repaired ONLY from the explicit predecessor link', () => {
  it('restores and persists the predecessor’s CHECKING account instead of failing the spend', async () => {
    // ── Arrange: a NORMAL 补办, then break the replacement's binding directly in the DB (a row minted
    // before bindings were inherited). The predecessor still records the settlement account. ────────
    const source = await issueVirtual({ monthlyLimit: '500.00' });
    const replacement = await loseAndReplace(source.id);
    await db().card.update({ where: { id: replacement.id }, data: { linkedAccountId: null } });

    expect((await cardRow(replacement.id)).linkedAccountId).toBeNull();
    const predecessorRow = await cardRow(source.id);
    expect(predecessorRow).toMatchObject({ status: 'LOST', replacedByCardId: replacement.id, linkedAccountId: CHECKING });

    // ── Act: the spend must succeed ONCE, on the recovered account. ────────────────────────────────
    const before = await balanceMinor();
    const result = await consume(replacement.id, '88.00', '补办卡消费');

    // The repair is PERSISTED (a later read of the raw row proves it, not just the returned projection).
    expect((await cardRow(replacement.id)).linkedAccountId).toBe(CHECKING);
    expect(result.card.linkedAccountId).toBe(CHECKING);
    expect(result.card.linkedAccountNumber).toBe(CHECKING_NUMBER);
    expect(result.consumption).toMatchObject({ cardId: replacement.id, accountId: CHECKING, amount: '88.00' });

    // Exactly one debit, one ledger row, one consumption row.
    expect(await balanceMinor()).toBe(before - moneyToCents('88.00'));
    const ledger = await db().transaction.findMany({ where: { userId: DEMO_USER_ID, merchant: '补办卡消费' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ accountId: CHECKING, channel: 'CARD', direction: 'DEBIT' });
    expect(ledger[0].amountMinor).toBe(-moneyToCents('88.00'));
    const rows = await consumptionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cardId: replacement.id, accountId: CHECKING, userId: DEMO_USER_ID });
    expect(rows[0].amountMinor).toBe(moneyToCents('88.00'));

    // The predecessor's own binding and terminal identity are untouched by the repair.
    expect(await cardRow(source.id)).toEqual(predecessorRow);
  });
});

describe('a null-bound card with NO explicit predecessor is refused (never the default account)', () => {
  it('rejects with CONFLICT and moves neither the binding, the balance nor the ledger', async () => {
    // ── Arrange: an ACTIVE VIRTUAL card bound to NOTHING, with a generous limit, and no card pointing
    // at it through `replacedByCardId` — i.e. no explicit 补办 source can be consulted. ──────────────
    const orphanId = 'card_virtual_orphan';
    await db().card.create({
      data: {
        id: orphanId,
        userId: DEMO_USER_ID,
        type: 'VIRTUAL',
        network: 'UnionPay',
        numberMasked: '****4242',
        status: 'ACTIVE',
        monthlyLimitMinor: moneyToCents('5000.00'),
        linkedAccountId: null,
      },
    });
    expect(await db().card.count({ where: { replacedByCardId: orphanId } })).toBe(0);
    // The settlement account holds far more than the spend, so a refusal cannot be about funds.
    const before = await balanceMinor();
    expect(before).toBe(SEEDED_CHECKING_MINOR);

    // ── Act / Assert: CONFLICT, never a silent fallback to the user's default account. ──────────────
    const error = await capture(() => consume(orphanId, '10.00', '孤儿卡消费'));
    expectCode(error, 'CONFLICT');
    expect((error as AppError).message).toContain('未绑定结算账户');

    const row = await cardRow(orphanId);
    expect(row.linkedAccountId).toBeNull();
    expect(row.status).toBe('ACTIVE');
    expect(await balanceMinor()).toBe(before);
    expect(await db().transaction.count({ where: { merchant: '孤儿卡消费' } })).toBe(0);
    expect(await db().cardConsumption.count()).toBe(0);
  });
});
